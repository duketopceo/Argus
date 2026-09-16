import { PROBE_LABEL } from './gate.js'

interface Ctx {
  err: (line: string) => void
}

export interface CheckRun {
  name: string
  /** GitHub check-run conclusion once status === 'completed'; undefined while pending. */
  conclusion: string | undefined
  completed: boolean
  url: string | undefined
}

export interface PrMeta {
  /** PR head SHA — the commit the PR's check-runs are attached to. */
  headSha: string | undefined
  /** PR base SHA — the merge base probes run against for the double-run. */
  baseSha: string | undefined
  /** `head.repo.fork` — true when the PR head branch lives in a fork. */
  isFork: boolean
  /**
   * Raw `author_association` for the PR (OWNER, MEMBER, COLLABORATOR,
   * CONTRIBUTOR, FIRST_TIME_CONTRIBUTOR, FIRST_TIMER, MANNEQUIN, NONE).
   */
  authorAssociation: string | undefined
  /** Names of labels currently applied to the PR. */
  labels: string[]
  /**
   * `head.repo.pushed_at` — the freshest push timestamp the probe label gate
   * can compare against (head commits arrive via pushes; comparing against
   * this is what binds label approval to the current head).
   */
  pushedAt: string | undefined
  /**
   * Timestamp of the newest `argus-probe` `labeled` event on the PR, from the
   * issue timeline — undefined when the label was never applied or the
   * timeline fetch failed (the gate fails closed either way).
   */
  labelApprovedAt: string | undefined
}

const GH_API = 'https://api.github.com'
const MAX_CHECK_RUN_PAGES = 5

async function ghGet(url: string, token: string, ctx: Ctx): Promise<unknown | undefined> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30_000)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    })
    if (!res.ok) {
      ctx.err(`evidence: github ${res.status} ${res.statusText} — ${url}`)
      return undefined
    }
    return await res.json()
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      ctx.err(`evidence: github request timed out — ${url}`)
      return undefined
    }
    throw e
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * PR metadata for the evidence + probe lanes — the head SHA check-runs attach
 * to, plus the fork/association/label signals the sandbox fork gate (KTD5)
 * evaluates. One `/pulls/{pr}` request; undefined when the request fails.
 */
export async function fetchPrMeta(
  repo: string,
  pr: string,
  token: string,
  ctx: Ctx,
): Promise<PrMeta | undefined> {
  const data = (await ghGet(`${GH_API}/repos/${repo}/pulls/${pr}`, token, ctx)) as
    | {
        head?: { sha?: string; repo?: { fork?: boolean; pushed_at?: string } | null }
        base?: { sha?: string }
        author_association?: string
        labels?: ({ name?: string } | null)[] | null
      }
    | undefined
  if (data === undefined) return undefined
  const labels = Array.isArray(data.labels)
    ? data.labels.map((l) => l?.name).filter((n): n is string => typeof n === 'string')
    : []
  const labelApprovedAt = labels.includes(PROBE_LABEL)
    ? await fetchLabelApprovedAt(repo, pr, token, ctx)
    : undefined
  return {
    headSha: data.head?.sha,
    baseSha: data.base?.sha,
    // head.repo is null when the source fork was deleted — fail closed and
    // treat it as a fork so the probe gate still applies.
    isFork: data.head?.repo?.fork !== false,
    authorAssociation:
      typeof data.author_association === 'string' ? data.author_association : undefined,
    labels,
    pushedAt: data.head?.repo?.pushed_at,
    labelApprovedAt,
  }
}

/**
 * Newest `labeled` event for `argus-probe` on the PR's issue timeline. The
 * label on the payload proves it's currently applied; the event timestamp is
 * what binds approval to the current head (a `synchronize` push after the
 * label must not inherit it). One extra request, only when the label exists.
 */
async function fetchLabelApprovedAt(
  repo: string,
  pr: string,
  token: string,
  ctx: Ctx,
): Promise<string | undefined> {
  const events = (await ghGet(
    // per_page=100 widens the single allowed call — the timeline endpoint
    // pages oldest-first, so a tiny page can miss the newest labeled event.
    `${GH_API}/repos/${repo}/issues/${pr}/timeline?per_page=100`,
    token,
    ctx,
  )) as ({ event?: string; created_at?: string; label?: { name?: string } | null }[] | undefined)
  if (!Array.isArray(events)) return undefined
  let latest: string | undefined
  for (const e of events) {
    if (e?.event === 'labeled' && e.label?.name === PROBE_LABEL && typeof e.created_at === 'string') {
      if (latest === undefined || e.created_at > latest) latest = e.created_at
    }
  }
  return latest
}

/** Check-runs on a commit — the consumer's own CI signal. */
export async function fetchCheckRuns(
  repo: string,
  sha: string,
  token: string,
  ctx: Ctx,
): Promise<CheckRun[] | undefined> {
  const runs: CheckRun[] = []
  let page = 1
  while (page <= MAX_CHECK_RUN_PAGES) {
    const data = (await ghGet(
      `${GH_API}/repos/${repo}/commits/${sha}/check-runs?per_page=100&page=${page}`,
      token,
      ctx,
    )) as { check_runs?: unknown[] } | undefined
    if (data === undefined || !Array.isArray(data.check_runs)) return undefined
    for (const r of data.check_runs) {
      const cr = r as { name?: string; conclusion?: string | null; status?: string; html_url?: string }
      if (typeof cr.name !== 'string') continue
      runs.push({
        name: cr.name,
        conclusion: cr.conclusion ?? undefined,
        completed: cr.status === 'completed',
        url: typeof cr.html_url === 'string' ? cr.html_url : undefined,
      })
    }
    if (data.check_runs.length < 100) break
    page++
  }
  return runs
}
