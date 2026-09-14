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
  headSha: string | undefined
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

/** PR head SHA — the commit the PR's check-runs are attached to. */
export async function fetchPrHeadSha(
  repo: string,
  pr: string,
  token: string,
  ctx: Ctx,
): Promise<string | undefined> {
  const data = (await ghGet(`${GH_API}/repos/${repo}/pulls/${pr}`, token, ctx)) as
    | { head?: { sha?: string } }
    | undefined
  return data?.head?.sha
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
