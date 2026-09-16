interface Ctx {
  err: (line: string) => void
}

/** Maintainer-applied PR label that opts a fork PR into sandbox probes. */
export const PROBE_LABEL = 'argus-probe'

/**
 * GitHub `author_association` values trusted to run probes on fork PRs —
 * repo members/owners/collaborators. CONTRIBUTOR, FIRST_TIME_CONTRIBUTOR,
 * FIRST_TIMER, MANNEQUIN, and NONE are not.
 */
export function isTrustedAssociation(association: string | undefined): boolean {
  return (
    association === 'MEMBER' || association === 'OWNER' || association === 'COLLABORATOR'
  )
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

/**
 * Shared GitHub GET scaffold — Bearer auth, API headers, 30s abort timeout,
 * `ctx.err` on non-ok/timeout, undefined on failure. Reuse for any
 * api.github.com read (fetchPrFiles in cli.ts paginates over it).
 */
export async function ghGet(
  url: string,
  token: string,
  ctx: Ctx,
): Promise<unknown | undefined> {
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
    } else {
      // DNS/socket/protocol failures — same contract: undefined, never throw.
      ctx.err(`evidence: github request failed — ${url} (${(e as Error).message})`)
    }
    return undefined
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
  // The timeline call only matters when the label is the deciding signal —
  // forks from untrusted authors carrying the label. Skip it otherwise.
  const needsTimeline =
    data.head?.repo?.fork === true &&
    !isTrustedAssociation(data.author_association) &&
    labels.includes(PROBE_LABEL)
  const labelApprovedAt = needsTimeline
    ? await fetchLabelApprovedAt(repo, pr, token, ctx)
    : undefined
  // The pulls payload has NO merge-base field — derive it from the compare
  // API (merge_base_commit.sha). Base-branch tip is the fallback: it can
  // contain fixes the PR never saw and misattribute them to the change.
  const headSha = data.head?.sha
  const baseSha = data.base?.sha
  const mergeBase =
    headSha !== undefined && baseSha !== undefined
      ? await fetchMergeBase(repo, baseSha, headSha, token, ctx)
      : undefined
  return {
    headSha,
    baseSha: mergeBase ?? baseSha,
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
 * Merge base via the compare API — `GET /compare/{base}...{head}` returns
 * `merge_base_commit.sha`, the commit the PR actually diverged from.
 */
async function fetchMergeBase(
  repo: string,
  base: string,
  head: string,
  token: string,
  ctx: Ctx,
): Promise<string | undefined> {
  const data = (await ghGet(`${GH_API}/repos/${repo}/compare/${base}...${head}`, token, ctx)) as
    | { merge_base_commit?: { sha?: string } }
    | undefined
  return data?.merge_base_commit?.sha
}

/**
 * Newest `labeled` event for `argus-probe` on the PR's issue events feed.
 * The label on the payload proves it's currently applied; the event
 * timestamp is what binds approval to the current head (a `synchronize`
 * push after the label must not inherit it). Uses the *events* endpoint —
 * not timeline — because it carries only state events (no comments), so a
 * busy PR's `labeled` event isn't drowned past page one. Pages are
 * oldest-first with no reverse sort, so we take the newest within a
 * bounded 3-page scan; a still-busier PR fails closed.
 */
async function fetchLabelApprovedAt(
  repo: string,
  pr: string,
  token: string,
  ctx: Ctx,
): Promise<string | undefined> {
  let latest: string | undefined
  for (let page = 1; page <= 3; page++) {
    const events = (await ghGet(
      `${GH_API}/repos/${repo}/issues/${pr}/events?per_page=100&page=${page}`,
      token,
      ctx,
    )) as ({ event?: string; created_at?: string; label?: { name?: string } | null }[] | undefined)
    if (!Array.isArray(events)) return undefined
    for (const e of events) {
      if (
        e?.event === 'labeled' &&
        e.label?.name === PROBE_LABEL &&
        typeof e.created_at === 'string'
      ) {
        if (latest === undefined || e.created_at > latest) latest = e.created_at
      }
    }
    if (events.length < 100) break
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
