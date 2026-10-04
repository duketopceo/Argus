import { getInstallationToken, type AuthEnv } from './auth.js'
import { createBudget, createGitHubClient, GitHubApiError, type GitHubClient } from './github.js'
import { redact } from './redact.js'
import type { WebhookEvent } from './webhook.js'
// Shared with the CLI (`init --pr`) so both surfaces render the same PR.
import { DEFAULT_BRANCH, renderPrBody, validateRepo } from '../../../src/onboarding/pr-content.js'
import { renderScaffold } from '../../../src/onboarding/scaffold.js'

/** Cloudflare free plan: 50 subrequests per invocation. Keep headroom. */
export const SUBREQUEST_LIMIT = 50
export const DEFAULT_SUBREQUEST_BUDGET = 45
/** Default per-run budget stated in the PR body; matches the scaffold's budgetUsd. */
const BUDGET_USD = 1
const WORKFLOW_PATH = '.github/workflows/argus-reviewer.yml'
const PR_TITLE = 'Add Argus reviewer (review-only, bring your own key)'
const COMMIT_MESSAGE = 'chore: add Argus reviewer (review-only, BYOK)'
const enc = new TextEncoder()

const SCAFFOLD = renderScaffold({ a0Host: undefined, includeConfig: true })

/**
 * Subrequests one repo can cost at most: token, GET repo, GET workflow,
 * GET PRs, GET branch, GET base ref, POST ref, one PUT per scaffold file,
 * POST PR. The fan-out gate refuses to start a repo unless this much budget
 * remains, so a delivery can never overrun the platform limit mid-repo.
 */
export const WORST_CASE_PER_REPO = 8 + SCAFFOLD.length

export type RepoStatus =
  | 'opened'
  | 'pr-exists'
  | 'already-onboarded'
  | 'skipped-fork'
  | 'skipped-archived'
  | 'nothing-to-add'
  | 'invalid'
  | 'deferred'
  | 'error'

export interface RepoResult {
  repo: string
  status: RepoStatus
  url?: string
  error?: string
}

export interface OnboardResult {
  results: RepoResult[]
  /** Subrequests spent by this delivery. */
  subrequests: number
  /** Repos not attempted because the subrequest budget ran out. */
  deferred: number
}

export interface OnboardDeps {
  fetch?: typeof fetch
  now?: () => number
  /** Operational log sink. Receives only redacted one-line status messages, never payloads. */
  log?: (message: string) => void
  /** Usable subrequests for this delivery (default 45 of the free plan's 50). */
  maxSubrequests?: number
}

type Env = AuthEnv

interface Target {
  installationId: number
  repos: string[]
  invalid: number
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Which repos a delivery asks us to onboard. Undefined = not an event we act on. */
function targets(e: WebhookEvent): Target | undefined | 'malformed' {
  const { event, payload } = e
  if (event !== 'installation' && event !== 'installation_repositories') return undefined
  if (!isObj(payload)) return 'malformed'
  const wanted = event === 'installation' ? 'created' : 'added'
  if (payload.action !== wanted) return undefined
  const inst = payload.installation
  if (!isObj(inst) || typeof inst.id !== 'number' || !Number.isSafeInteger(inst.id) || inst.id <= 0) return 'malformed'
  const list = event === 'installation' ? payload.repositories : payload.repositories_added
  // installation.created with repository_selection "all" may omit the list; nothing to enumerate.
  if (list === undefined && event === 'installation') return { installationId: inst.id, repos: [], invalid: 0 }
  if (!Array.isArray(list)) return 'malformed'
  const seen = new Set<string>()
  const repos: string[] = []
  let invalid = 0
  for (const r of list) {
    const full = isObj(r) && typeof r.full_name === 'string' ? r.full_name : undefined
    if (full === undefined || validateRepo(full) !== undefined) {
      invalid += 1
      continue
    }
    const k = full.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    repos.push(full)
  }
  return { installationId: inst.id, repos, invalid }
}

const seg = (s: string): string => s.split('/').map(encodeURIComponent).join('/')

function b64(text: string): string {
  let s = ''
  for (const b of enc.encode(text)) s += String.fromCharCode(b)
  return btoa(s)
}

async function onboardRepo(gh: GitHubClient, full: string): Promise<RepoResult> {
  const [owner = '', name = ''] = full.split('/')
  const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`

  const info = (await gh.request<{ archived?: boolean; fork?: boolean; default_branch?: string }>('GET', base)).data
  if (info.archived) return { repo: full, status: 'skipped-archived' }
  if (info.fork) return { repo: full, status: 'skipped-fork' }
  const def = typeof info.default_branch === 'string' ? info.default_branch : ''
  if (def === '' || def.length > 255) throw new GitHubApiError(0, 'repository has no usable default branch')

  const wf = await gh.request('GET', `${base}/contents/${seg(WORKFLOW_PATH)}?ref=${encodeURIComponent(def)}`, { ok: [200, 404] })
  if (wf.status === 200) return { repo: full, status: 'already-onboarded' }

  // Any PR (open, closed or merged) from the onboarding branch means a human
  // already saw it: never re-open or spam.
  const head = encodeURIComponent(`${owner}:${DEFAULT_BRANCH}`)
  const prs = (await gh.request<{ html_url?: string }[]>('GET', `${base}/pulls?head=${head}&state=all&per_page=1`)).data
  if (Array.isArray(prs) && prs.length > 0) {
    const url = prs[0]?.html_url
    return { repo: full, status: 'pr-exists', ...(typeof url === 'string' ? { url } : {}) }
  }

  const branch = await gh.request('GET', `${base}/git/ref/heads/${seg(DEFAULT_BRANCH)}`, { ok: [200, 404] })
  const branchExisted = branch.status === 200
  if (!branchExisted) {
    const baseRef = (await gh.request<{ object?: { sha?: string } }>('GET', `${base}/git/ref/heads/${seg(def)}`)).data
    const sha = baseRef?.object?.sha
    if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) throw new GitHubApiError(0, 'could not resolve the default branch head')
    await gh.request('POST', `${base}/git/refs`, { body: { ref: `refs/heads/${DEFAULT_BRANCH}`, sha } })
  }

  // Sequential: parallel commits to one branch race. A 422 on a path means
  // the file already exists on the branch (partial earlier run, or the repo
  // has its own config): keep theirs, never overwrite.
  const added: string[] = []
  for (const f of SCAFFOLD) {
    const res = await gh.request('PUT', `${base}/contents/${seg(f.path)}`, {
      body: { message: COMMIT_MESSAGE, content: b64(f.content), branch: DEFAULT_BRANCH },
      ok: [200, 201, 422],
    })
    if (res.status !== 422) added.push(f.path)
  }
  if (added.length === 0 && !branchExisted) return { repo: full, status: 'nothing-to-add' }

  const pr = await gh.request<{ html_url?: string }>('POST', `${base}/pulls`, {
    body: {
      title: PR_TITLE,
      head: DEFAULT_BRANCH,
      base: def,
      body: renderPrBody({ repo: full, budgetUsd: BUDGET_USD, paths: branchExisted && added.length === 0 ? SCAFFOLD.map((f) => f.path) : added }),
    },
  })
  const url = pr.data?.html_url
  return { repo: full, status: 'opened', ...(typeof url === 'string' ? { url } : {}) }
}

/**
 * U6: `installation.created` and `installation_repositories.added` open one
 * onboarding PR per repo. GitHub is the state: branch / PR existence checks
 * make it idempotent, the in-memory replay guard is only an optimization.
 * Never reads customer code, never touches secrets, never reviews anything.
 */
export async function handleInstallationEvent(e: WebhookEvent, env: Env, deps: OnboardDeps = {}): Promise<OnboardResult> {
  const secrets = [env.PRIVATE_KEY]
  const log = (m: string): void => deps.log?.(redact(m, secrets))
  const empty: OnboardResult = { results: [], subrequests: 0, deferred: 0 }

  const t = targets(e)
  if (t === undefined) return empty
  if (t === 'malformed') {
    log(`onboard: ignored malformed ${e.event} payload`)
    return empty
  }

  const budget = createBudget(Math.min(deps.maxSubrequests ?? DEFAULT_SUBREQUEST_BUDGET, SUBREQUEST_LIMIT))
  const counted = budget.wrap(deps.fetch ?? fetch)
  const results: RepoResult[] = []
  for (let i = 0; i < t.invalid; i++) results.push({ repo: '(invalid)', status: 'invalid' })
  if (t.invalid > 0) log(`onboard: skipped ${t.invalid} entry(ies) with invalid owner/repo names`)

  let deferred = 0
  for (const full of t.repos) {
    if (budget.remaining < WORST_CASE_PER_REPO) {
      deferred += 1
      results.push({ repo: full, status: 'deferred' })
      continue
    }
    const [owner = '', repo = ''] = full.split('/')
    try {
      const tok = await getInstallationToken(env, { installationId: t.installationId, owner, repo }, {
        fetch: counted,
        ...(deps.now ? { now: deps.now } : {}),
      })
      const gh = createGitHubClient({ token: tok.token, fetch: counted, secrets })
      const r = await onboardRepo(gh, full)
      results.push(r)
      log(`onboard ${full}: ${r.status}`)
    } catch (err) {
      const msg = redact(err instanceof Error ? err.message : 'unknown error', secrets).slice(0, 300)
      results.push({ repo: full, status: 'error', error: msg })
      log(`onboard ${full}: error ${msg}`)
    }
  }
  if (deferred > 0) log(`onboard: ${deferred} repo(s) deferred, subrequest budget (${budget.limit}) exhausted; re-add them or run init --pr`)
  return { results, subrequests: budget.used, deferred }
}

export interface OnboardingHandlerDeps extends OnboardDeps {
  /** Run the work after the 202 has been returned (ctx.waitUntil). Default: await inline. */
  defer?: (p: Promise<unknown>) => void
}

/** Adapter for handleWebhook's onEvent. */
export function createOnboardingHandler(env: Env, deps: OnboardingHandlerDeps = {}): (e: WebhookEvent) => Promise<void> {
  const { defer, ...rest } = deps
  return async (e) => {
    const work = handleInstallationEvent(e, env, rest).then(() => undefined)
    if (defer) defer(work.catch(() => undefined))
    else await work
  }
}
