import { generateKeyPairSync } from 'node:crypto'

// Throwaway key generated at test runtime; never written to disk or committed.
export const PRIVATE_KEY = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
  type: 'pkcs8',
  format: 'pem',
}) as string

export const TOKEN = 'ghs_' + 'A1b2C3d4E5f6G7h8I9j0'

export interface FakeRepo {
  archived?: boolean
  fork?: boolean
  defaultBranch?: string
  /** .github/workflows/argus-reviewer.yml already on the default branch. */
  hasWorkflow?: boolean
  branchExists?: boolean
  openPr?: boolean
  /** Paths already present on the onboarding branch (PUT without sha then 422s). */
  existingFiles?: string[]
  /** Force a status for `METHOD path-regex` e.g. 'POST /pulls' */
  failOn?: Record<string, number>
  /** Echo this string inside an error body (to prove redaction). */
  errorBody?: string
}

export interface Call {
  method: string
  url: string
  body: unknown
}

export interface FakeGithub {
  fetch: typeof fetch
  calls: Call[]
  /** Calls excluding the token exchange. */
  api: () => Call[]
  committed: Map<string, string[]>
  prs: Map<string, { title: string; body: string; head: string; base: string }>
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** In-memory GitHub: only the endpoints the onboarding handler may touch. Anything else throws. */
export function fakeGithub(repos: Record<string, FakeRepo>): FakeGithub {
  const calls: Call[] = []
  const committed = new Map<string, string[]>()
  const prs = new Map<string, { title: string; body: string; head: string; base: string }>()
  const state = new Map<string, FakeRepo>(Object.entries(repos).map(([k, v]) => [k, { ...v }] as [string, FakeRepo]))

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const method = (init?.method ?? 'GET').toUpperCase()
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, url: url.pathname + url.search, body })
    if (url.origin !== 'https://api.github.com') throw new Error(`unexpected host ${url.origin}`)

    if (method === 'POST' && /^\/app\/installations\/\d+\/access_tokens$/.test(url.pathname)) {
      return json(201, {
        token: TOKEN,
        expires_at: '2099-01-01T00:00:00Z',
        permissions: body.permissions,
        repositories: [{ name: body.repositories[0] }],
      })
    }
    const m = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(url.pathname)
    if (!m) throw new Error(`unexpected request ${method} ${url.pathname}`)
    const key = `${m[1]}/${m[2]}`
    const rest = m[3] ?? ''
    const r = state.get(key)
    if (!r) return json(404, { message: 'Not Found' })
    const forced = Object.entries(r.failOn ?? {}).find(([k]) => {
      const [mm, p] = k.split(' ') as [string, string]
      return mm === method && rest.includes(p)
    })
    if (forced) return json(forced[1], { message: r.errorBody ?? 'forced failure' })
    const def = r.defaultBranch ?? 'main'

    if (method === 'GET' && rest === '') {
      return json(200, { archived: !!r.archived, fork: !!r.fork, default_branch: def, disabled: false })
    }
    if (method === 'GET' && rest === '/contents/.github/workflows/argus-reviewer.yml') {
      return r.hasWorkflow ? json(200, { type: 'file' }) : json(404, { message: 'Not Found' })
    }
    if (method === 'GET' && rest === '/pulls') {
      return json(200, r.openPr ? [{ html_url: `https://github.com/${key}/pull/7`, number: 7 }] : [])
    }
    if (method === 'GET' && rest === '/git/ref/heads/argus/onboarding') {
      return r.branchExists ? json(200, { object: { sha: 'b'.repeat(40) } }) : json(404, { message: 'Not Found' })
    }
    if (method === 'GET' && rest === `/git/ref/heads/${def}`) return json(200, { object: { sha: 'a'.repeat(40) } })
    if (method === 'POST' && rest === '/git/refs') {
      r.branchExists = true
      return json(201, { ref: body.ref })
    }
    if (method === 'PUT' && rest.startsWith('/contents/')) {
      const path = decodeURIComponent(rest.slice('/contents/'.length))
      if (body.branch !== 'argus/onboarding') throw new Error('commit to unexpected branch ' + String(body.branch))
      if ((r.existingFiles ?? []).includes(path)) return json(422, { message: '"sha" wasn\'t supplied.' })
      committed.set(key, [...(committed.get(key) ?? []), path])
      return json(201, { content: { path } })
    }
    if (method === 'POST' && rest === '/pulls') {
      prs.set(key, { title: body.title, body: body.body, head: body.head, base: body.base })
      return json(201, { html_url: `https://github.com/${key}/pull/8`, number: 8 })
    }
    throw new Error(`unexpected request ${method} ${url.pathname}`)
  }) as typeof fetch

  return {
    fetch: fetchImpl,
    calls,
    api: () => calls.filter((c) => !c.url.includes('/access_tokens')),
    committed,
    prs,
  }
}
