import { describe, expect, it } from 'vitest'
import { renderScaffold } from '../../../src/onboarding/scaffold.js'
import { handleWebhook, type WebhookEvent } from '../src/index.js'
import { createOnboardingHandler, handleInstallationEvent, WORST_CASE_PER_REPO } from '../src/onboard.js'
import { fakeGithub, PRIVATE_KEY, TOKEN, type FakeRepo } from './fakeGithub.js'
import { signatureFor } from '../src/verify.js'

const env = { APP_ID: '12345', PRIVATE_KEY, WEBHOOK_SECRET: 's3cret' }
const SCAFFOLD_PATHS = renderScaffold({ a0Host: undefined, includeConfig: true }).map((f) => f.path)

const installed = (repos: string[], action = 'created'): WebhookEvent => ({
  event: 'installation',
  delivery: 'd1',
  payload: { action, installation: { id: 99 }, repositories: repos.map((full_name) => ({ full_name, name: full_name.split('/')[1] })) },
})
const added = (repos: string[]): WebhookEvent => ({
  event: 'installation_repositories',
  delivery: 'd2',
  payload: {
    action: 'added',
    installation: { id: 99 },
    repositories_added: repos.map((full_name) => ({ full_name, name: full_name.split('/')[1] })),
    repositories_removed: [],
  },
})

function run(e: WebhookEvent, repos: Record<string, FakeRepo>, extra: { maxSubrequests?: number } = {}) {
  const gh = fakeGithub(repos)
  const logs: string[] = []
  const p = handleInstallationEvent(e, env, { fetch: gh.fetch, log: (m) => logs.push(m), now: () => 1_800_000_000, ...extra })
  return { gh, logs, p }
}

describe('onboarding PR on install', () => {
  it('opens a PR with the shared scaffold for a fresh repo (installation.created)', async () => {
    const { gh, p } = run(installed(['acme/web']), { 'acme/web': {} })
    const res = await p
    expect(res.results).toEqual([{ repo: 'acme/web', status: 'opened', url: 'https://github.com/acme/web/pull/8' }])
    expect(gh.committed.get('acme/web')).toEqual(SCAFFOLD_PATHS)
    const pr = gh.prs.get('acme/web')!
    expect(pr.head).toBe('argus/onboarding')
    expect(pr.base).toBe('main')
    expect(pr.body).toContain('OPENROUTER_API_KEY')
    expect(pr.body).toContain('Nothing runs until it is merged')
  })

  it('handles installation_repositories.added', async () => {
    const res = await run(added(['acme/web']), { 'acme/web': {} }).p
    expect(res.results[0]?.status).toBe('opened')
  })

  it('is a no-op when an open onboarding PR already exists (re-delivery)', async () => {
    const { gh, p } = run(installed(['acme/web']), { 'acme/web': { openPr: true, branchExists: true } })
    const res = await p
    expect(res.results[0]).toMatchObject({ repo: 'acme/web', status: 'pr-exists' })
    expect(gh.api().filter((c) => c.method !== 'GET')).toEqual([])
  })

  it('opens the PR when the branch exists but no PR does, without recreating the branch', async () => {
    const { gh, p } = run(installed(['acme/web']), { 'acme/web': { branchExists: true, existingFiles: SCAFFOLD_PATHS } })
    const res = await p
    expect(res.results[0]?.status).toBe('opened')
    expect(gh.api().some((c) => c.method === 'POST' && c.url.endsWith('/git/refs'))).toBe(false)
    expect(gh.prs.has('acme/web')).toBe(true)
  })

  it('skips archived, forked and already-onboarded repos', async () => {
    const { gh, p } = run(installed(['a/arch', 'a/fork', 'a/done']), {
      'a/arch': { archived: true },
      'a/fork': { fork: true },
      'a/done': { hasWorkflow: true },
    })
    const res = await p
    expect(res.results.map((r) => r.status)).toEqual(['skipped-archived', 'skipped-fork', 'already-onboarded'])
    expect(gh.api().filter((c) => c.method !== 'GET')).toEqual([])
  })

  it('does nothing for repositories_removed / removed actions', async () => {
    const gh = fakeGithub({})
    const ev: WebhookEvent = {
      event: 'installation_repositories',
      delivery: 'd',
      payload: { action: 'removed', installation: { id: 99 }, repositories_removed: [{ full_name: 'a/b' }] },
    }
    const res = await handleInstallationEvent(ev, env, { fetch: gh.fetch })
    expect(res.results).toEqual([])
    expect(gh.calls).toEqual([])
    for (const action of ['deleted', 'suspend', 'unsuspend', 'new_permissions_accepted']) {
      const r = await handleInstallationEvent(installed(['a/b'], action), env, { fetch: gh.fetch })
      expect(r.results).toEqual([])
    }
    expect(gh.calls).toEqual([])
  })

  it('ignores other event types', async () => {
    const gh = fakeGithub({})
    const res = await handleInstallationEvent({ event: 'pull_request', delivery: 'x', payload: { action: 'opened' } }, env, { fetch: gh.fetch })
    expect(res.results).toEqual([])
    expect(gh.calls).toEqual([])
  })

  it.each([
    ['null payload', null],
    ['string payload', 'x'],
    ['no installation', { action: 'created', repositories: [] }],
    ['bad installation id', { action: 'created', installation: { id: 'nope' }, repositories: [{ full_name: 'a/b' }] }],
    ['negative installation id', { action: 'created', installation: { id: -1 }, repositories: [{ full_name: 'a/b' }] }],
    ['repositories not an array', { action: 'created', installation: { id: 1 }, repositories: 'a/b' }],
  ])('rejects malformed payload without any GitHub call: %s', async (_n, payload) => {
    const gh = fakeGithub({})
    const res = await handleInstallationEvent({ event: 'installation', delivery: 'x', payload }, env, { fetch: gh.fetch })
    expect(res.results).toEqual([])
    expect(gh.calls).toEqual([])
  })

  it('rejects invalid owner/repo names and never turns them into requests', async () => {
    const bad = ['a/b/c', '../etc', 'a/..', 'a b/c', 'a/b?x=1', 'a/b#', 'noslash', '', 'a/b\n', 'é/x']
    const gh = fakeGithub({})
    const res = await handleInstallationEvent(
      { event: 'installation', delivery: 'x', payload: { action: 'created', installation: { id: 1 }, repositories: [...bad.map((full_name) => ({ full_name })), { name: 'x' }, 5, null] } },
      env,
      { fetch: gh.fetch },
    )
    expect(res.results.every((r) => r.status === 'invalid')).toBe(true)
    expect(gh.calls).toEqual([])
  })

  it('deduplicates repos in one delivery', async () => {
    const { gh, p } = run(installed(['acme/web', 'acme/web', 'ACME/WEB']), { 'acme/web': {}, 'ACME/WEB': {} })
    const res = await p
    expect(res.results).toHaveLength(1)
    expect(gh.prs.size).toBe(1)
  })
})

describe('fan-out cap and subrequest counting', () => {
  const many = Array.from({ length: 30 }, (_, i) => `acme/r${i}`)
  const repos = Object.fromEntries(many.map((r) => [r, {}]))

  it('never exceeds the 50-subrequest limit and defers the remainder', async () => {
    const { gh, logs, p } = run(installed(many), repos)
    const res = await p
    expect(gh.calls.length).toBe(res.subrequests)
    expect(res.subrequests).toBeLessThanOrEqual(50)
    const opened = res.results.filter((r) => r.status === 'opened')
    const deferred = res.results.filter((r) => r.status === 'deferred')
    expect(opened.length).toBeGreaterThan(0)
    expect(opened.length + deferred.length).toBe(many.length)
    expect(deferred.length).toBeGreaterThan(0)
    expect(res.deferred).toBe(deferred.length)
    expect(logs.join('\n')).toMatch(new RegExp(`${deferred.length} repo\\(s\\) deferred`))
  })

  it('a worst-case repo fits the budget: the cap is derived from WORST_CASE_PER_REPO', async () => {
    const { p } = run(installed(many), repos)
    const res = await p
    expect(res.results.filter((r) => r.status === 'opened').length).toBe(Math.floor(45 / WORST_CASE_PER_REPO))
  })

  it('lets cheap no-op repos use fewer subrequests so more fit', async () => {
    const noops = Array.from({ length: 12 }, (_, i) => `acme/p${i}`)
    const { p } = run(installed(noops), Object.fromEntries(noops.map((r) => [r, { openPr: true }])))
    const res = await p
    expect(res.results.filter((r) => r.status === 'pr-exists').length).toBeGreaterThan(Math.floor(45 / WORST_CASE_PER_REPO))
    expect(res.subrequests).toBeLessThanOrEqual(50)
  })

  it('honors a smaller injected budget and counts the token exchange', async () => {
    const { gh, p } = run(installed(['a/one', 'a/two']), { 'a/one': {}, 'a/two': {} }, { maxSubrequests: WORST_CASE_PER_REPO })
    const res = await p
    expect(res.results.map((r) => r.status)).toEqual(['opened', 'deferred'])
    expect(gh.calls.filter((c) => c.url.includes('/access_tokens'))).toHaveLength(1)
    expect(res.subrequests).toBe(gh.calls.length)
  })

  it('mints one single-repo token per repo with the minimal permission set', async () => {
    const { gh, p } = run(installed(['a/one', 'a/two']), { 'a/one': {}, 'a/two': {} })
    await p
    const toks = gh.calls.filter((c) => c.url.includes('/access_tokens'))
    expect(toks.map((t) => (t.body as { repositories: string[] }).repositories)).toEqual([['one'], ['two']])
  })
})

describe('failure isolation and secrecy', () => {
  it('one repo failing does not stop the next; error is reported as a status', async () => {
    const { p } = run(installed(['a/bad', 'a/good']), { 'a/bad': { failOn: { 'POST /pulls': 500 } }, 'a/good': {} })
    const res = await p
    expect(res.results.map((r) => r.status)).toEqual(['error', 'opened'])
  })

  it('never leaks tokens, keys or JWTs through logs or results', async () => {
    const { logs, p } = run(installed(['a/bad']), {
      'a/bad': { failOn: { 'POST /pulls': 500 }, errorBody: `boom ${TOKEN} Bearer ${TOKEN} ${PRIVATE_KEY}` },
    })
    const res = await p
    const blob = JSON.stringify(res) + logs.join('\n')
    expect(blob).not.toContain(TOKEN)
    expect(blob).not.toContain('BEGIN PRIVATE KEY')
    expect(blob).not.toMatch(/eyJ[\w-]+\.[\w-]+\./)
    expect(logs.length).toBeGreaterThan(0)
  })

  it('does not log delivery payloads', async () => {
    const { logs, p } = run(installed(['secretorg/secretrepo']), { 'secretorg/secretrepo': {} })
    await p
    expect(logs.join('\n')).not.toContain('"installation"')
  })

  it('treats a token-exchange failure as an error status without throwing', async () => {
    const gh = fakeGithub({ 'a/b': {} })
    const failing = (async (u: string | URL | Request, i?: RequestInit) =>
      String(u).includes('access_tokens') ? new Response(`nope ${PRIVATE_KEY}`, { status: 401 }) : gh.fetch(u, i)) as typeof fetch
    const logs: string[] = []
    const res = await handleInstallationEvent(installed(['a/b']), env, { fetch: failing, log: (m) => logs.push(m) })
    expect(res.results[0]?.status).toBe('error')
    expect(logs.join('\n') + JSON.stringify(res)).not.toContain('BEGIN PRIVATE KEY')
  })
})

describe('wiring into handleWebhook', () => {
  it('a signed installation delivery reaches the handler and answers 202', async () => {
    const gh = fakeGithub({ 'acme/web': {} })
    const body = JSON.stringify(installed(['acme/web']).payload)
    const req = new Request('https://x.test/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-delivery': 'wire-1',
        'x-github-event': 'installation',
        'x-hub-signature-256': await signatureFor(env.WEBHOOK_SECRET, body),
      },
      body,
    })
    const pending: Promise<unknown>[] = []
    const onEvent = createOnboardingHandler(env, { fetch: gh.fetch, defer: (p) => pending.push(p) })
    const res = await handleWebhook(req, env, { onEvent })
    expect(res.status).toBe(202)
    await Promise.all(pending)
    expect(gh.prs.has('acme/web')).toBe(true)
  })
})
