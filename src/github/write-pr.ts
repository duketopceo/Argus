import { ghGet, ghWrite } from '../evidence/ci.js'

interface Ctx {
  err: (line: string) => void
}

/**
 * Shared "commit files to a dedicated branch and open one PR" writer —
 * extracted from `persistProbes` so heal write-back, generated-spec PRs, and
 * `@argus fix` apply-PRs share one audited write path (refs + contents +
 * pulls, never a checkout, never the base ref).
 *
 * File semantics come in two modes:
 * - `create` (persist contract): exclusive create — an existing file 422s
 *   and is reported `skipped`, never overwritten.
 * - `upsert`: the file's current blob sha is read on the branch and the PUT
 *   carries it — an update, still branch-scoped.
 */
interface WritePrFile {
  /** Repo-relative write path — callers validate `isSafeRepoPath` upstream. */
  path: string
  /** File content (utf8 — encoded by the caller-side write). */
  content: string
}

export interface CreateFilesPrOpts {
  /** `owner/repo`. */
  repo: string
  /** Base branch the PR targets and the write branch forks from. */
  baseRef: string
  /**
   * Exact commit the write branch forks from. When set it replaces the
   * `baseRef` resolution — `@argus fix` uses this to bind the branch to the
   * reviewed head SHA rather than wherever the head ref has moved to.
   */
  baseSha?: string
  /**
   * Hook evaluated after the file writes, before the PR is opened. Return a
   * string to abort the open with that reason in `error` (commits stay on
   * the branch — idempotent for a re-run). `@argus fix` uses it to re-verify
   * the head SHA (TOCTOU) between write and open.
   */
  preOpen?: () => Promise<string | undefined>
  /** Dedicated branch name — `argus/…` prefix by convention. */
  branch: string
  files: WritePrFile[]
  title: string
  /**
   * PR body — a string, or a callback evaluated after the writes so it can
   * render what actually landed (written/updated/skipped).
   */
  body: string | ((r: { written: string[]; updated: string[]; skipped: string[] }) => string)
  /** Existing-file contract on the write branch. */
  exists: 'create' | 'upsert'
}

export interface CreateFilesPrResult {
  /** Opened (or reused) PR URL. */
  prUrl?: string
  /** True when `prUrl` is an already-open PR on the branch, not a new one. */
  existing?: boolean
  /** Paths committed as new files. */
  written: string[]
  /** Paths updated in place (upsert mode only). */
  updated: string[]
  /** Paths skipped — existing files under `create` mode. */
  skipped: string[]
  /** Failure message when the write could not complete. */
  error?: string
}

const GH_API = 'https://api.github.com'

/**
 * Commit `files` to `branch` (created off `baseRef` or reused) and open one
 * PR. Idempotent: an existing branch is reused and an already-open PR on the
 * branch is returned rather than duplicated.
 */
export async function createFilesPr(
  opts: CreateFilesPrOpts,
  token: string,
  ctx: Ctx,
): Promise<CreateFilesPrResult> {
  const { repo, baseRef, baseSha: forkSha, branch, files, title, body, exists, preOpen } = opts
  const empty: CreateFilesPrResult = { written: [], updated: [], skipped: [] }

  const base = forkSha
    ? undefined
    : ((await ghGet(`${GH_API}/repos/${repo}/git/ref/heads/${baseRef}`, token, ctx)) as
        | { object?: { sha?: string } }
        | undefined)
  const baseSha = forkSha ?? base?.object?.sha
  if (typeof baseSha !== 'string') {
    return { ...empty, error: `couldn't resolve base ref ${baseRef}` }
  }

  const created = await ghWrite('POST', `${GH_API}/repos/${repo}/git/refs`, token, ctx, {
    ref: `refs/heads/${branch}`,
    sha: baseSha,
  })
  // 422 = ref already exists — reuse the branch (idempotent re-write).
  if (created.status !== 201 && created.status !== 422) {
    return { ...empty, error: `couldn't create branch ${branch} (github ${created.status})` }
  }

  const written: string[] = []
  const updated: string[] = []
  const skipped: string[] = []
  for (const file of files) {
    let sha: string | undefined
    if (exists === 'upsert') {
      const current = (await ghGet(
        `${GH_API}/repos/${repo}/contents/${encodeURIComponent(file.path)}?ref=${encodeURIComponent(branch)}`,
        token,
        ctx,
      )) as { sha?: string } | undefined
      sha = typeof current?.sha === 'string' ? current.sha : undefined
    }
    const put = await ghWrite(
      'PUT',
      `${GH_API}/repos/${repo}/contents/${encodeURIComponent(file.path)}`,
      token,
      ctx,
      {
        message: `${title}: ${file.path}`,
        content: Buffer.from(file.content, 'utf8').toString('base64'),
        branch,
        ...(sha !== undefined ? { sha } : {}),
      },
    )
    if (put.status === 201 || put.status === 200) {
      ;(sha !== undefined ? updated : written).push(file.path)
    } else if (put.status === 422 && exists === 'create') {
      // File already exists on the branch — exclusive create honors the
      // never-overwrite contract.
      skipped.push(file.path)
    } else {
      return {
        written,
        updated,
        skipped,
        error: `couldn't write ${file.path} (github ${put.status})`,
      }
    }
  }

  if (preOpen !== undefined) {
    const abort = await preOpen()
    if (typeof abort === 'string') {
      return { written, updated, skipped, error: abort }
    }
  }

  const owner = repo.split('/')[0] ?? repo
  const open = (await ghGet(
    `${GH_API}/repos/${repo}/pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&state=open`,
    token,
    ctx,
  )) as { html_url?: string }[] | undefined
  const existing = Array.isArray(open) ? open[0]?.html_url : undefined
  if (typeof existing === 'string') {
    return { prUrl: existing, existing: true, written, updated, skipped }
  }

  const createdPr = await ghWrite('POST', `${GH_API}/repos/${repo}/pulls`, token, ctx, {
    title,
    head: branch,
    base: baseRef,
    body: typeof body === 'string' ? body : body({ written, updated, skipped }),
  })
  const url = (createdPr.data as { html_url?: string } | undefined)?.html_url
  if (createdPr.status !== 201 || typeof url !== 'string') {
    return {
      written,
      updated,
      skipped,
      error: `file(s) committed but PR open failed (github ${createdPr.status})`,
    }
  }
  return { prUrl: url, existing: false, written, updated, skipped }
}
