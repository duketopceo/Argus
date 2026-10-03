import { ghGet, ghWrite } from '../evidence/ci.js'
import { isSafeRepoPath, type ProbeRecord } from './queue.js'

interface Ctx {
  err: (line: string) => void
}

/**
 * `@argus persist` — reproduced probes become regression tests (roadmap
 * E1.U3). Probe files are written transiently and deleted during review,
 * so `reproduced` records carry their source + suggested path in
 * code-review.json. The sticky comment embeds them as a base64 HTML-comment
 * payload (`PERSIST_MARKER`) — a later `issue_comment` run on a base-only
 * checkout decodes it and commits the probes to a new branch via the
 * contents API, then opens one regression-test PR per source PR.
 *
 * Trust: payload content is model-authored. It passed the probe lane's
 * validation once (forced `argus-probe-` filename, safe repo path, bounded
 * imports), but the sticky comment is editable — decode() re-validates
 * every path and bound before any write, and writes go to a dedicated
 * branch, never the base ref.
 */

export interface PersistableProbe {
  /** Repo-relative write path — `argus-probe-*` basename, validated. */
  path: string
  /** Probe source (bounded). */
  content: string
  /** Probe filename for messaging. */
  file: string
  /** Finding file the probe covers, when known. */
  findingFile?: string | undefined
}

export const PERSIST_MARKER = '<!-- argus-probe-persist '

/** Keep the embedded payload well under GitHub's 65536-char comment cap. */
const PERSIST_MAX_PROBES = 3
const PERSIST_CONTENT_CAP = 12 * 1024
const PERSIST_PAYLOAD_CAP = 32 * 1024

const B64_RE = /^[A-Za-z0-9+/=]+$/

/** Reproduced probes carrying serialized content + a safe suggested path. */
export function selectPersistable(records: ProbeRecord[] | undefined): PersistableProbe[] {
  if (!Array.isArray(records)) return []
  const out: PersistableProbe[] = []
  for (const r of records) {
    if (out.length >= PERSIST_MAX_PROBES) break
    if (r.outcome !== 'reproduced') continue
    const { path, content } = r
    if (
      typeof path !== 'string' ||
      typeof content !== 'string' ||
      content === '' ||
      content.length > PERSIST_CONTENT_CAP ||
      !isSafeRepoPath(path) ||
      // The write-side contract: persist only ever creates argus-probe-*
      // files — a crafted payload must not aim at an existing test.
      !path.split('/').pop()?.startsWith('argus-probe-')
    ) {
      continue
    }
    out.push({ path, content, file: r.file, findingFile: r.findingFile })
  }
  return out
}

/**
 * Serialize the payload for the sticky comment — the full marker string,
 * or undefined when nothing persistable exists or the payload would bust
 * the cap (the copy-paste tier still renders probes that don't fit).
 */
export function encodeProbePayload(
  records: ProbeRecord[] | undefined,
  headSha: string | undefined,
): string | undefined {
  const probes = selectPersistable(records)
  if (probes.length === 0) return undefined
  const payload = JSON.stringify({
    v: 1,
    ...(headSha !== undefined ? { head: headSha } : {}),
    probes,
  })
  const b64 = Buffer.from(payload, 'utf8').toString('base64')
  if (b64.length > PERSIST_PAYLOAD_CAP) return undefined
  return `${PERSIST_MARKER}${b64} -->`
}

export interface DecodedPayload {
  head?: string | undefined
  probes: PersistableProbe[]
}

/**
 * Parse a sticky comment body back into probes. Strict: exactly one
 * marker, alphabet-checked base64, shaped JSON, and every entry through
 * the same selectPersistable validation — a hand-edited comment fails
 * closed to undefined rather than persisting attacker-controlled paths.
 */
export function decodeProbePayload(body: string): DecodedPayload | undefined {
  const start = body.indexOf(PERSIST_MARKER)
  if (start === -1) return undefined
  if (body.indexOf(PERSIST_MARKER, start + PERSIST_MARKER.length) !== -1) return undefined
  const end = body.indexOf('-->', start + PERSIST_MARKER.length)
  if (end === -1) return undefined
  const b64 = body.slice(start + PERSIST_MARKER.length, end).trim()
  if (b64.length > PERSIST_PAYLOAD_CAP || !B64_RE.test(b64)) return undefined
  let raw: unknown
  try {
    raw = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'))
  } catch {
    return undefined
  }
  if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as { probes?: unknown }).probes)) {
    return undefined
  }
  const r = raw as { v?: unknown; head?: unknown; probes: unknown[] }
  if (r.v !== 1) return undefined
  // Re-run the records through the selector's validation by shape — the
  // payload must contain only what selectPersistable would emit.
  const probes: PersistableProbe[] = []
  for (const p of r.probes.slice(0, PERSIST_MAX_PROBES)) {
    const c = p as Partial<PersistableProbe>
    if (
      typeof c !== 'object' ||
      c === null ||
      typeof c.path !== 'string' ||
      typeof c.content !== 'string' ||
      c.content === '' ||
      c.content.length > PERSIST_CONTENT_CAP ||
      !isSafeRepoPath(c.path) ||
      !c.path.split('/').pop()?.startsWith('argus-probe-')
    ) {
      return undefined
    }
    probes.push({
      path: c.path,
      content: c.content,
      file: typeof c.file === 'string' ? c.file : '(probe)',
      findingFile: typeof c.findingFile === 'string' ? c.findingFile : undefined,
    })
  }
  if (probes.length === 0) return undefined
  return { head: typeof r.head === 'string' ? r.head : undefined, probes }
}

export interface PersistResult {
  /** Opened (or reused) regression-test PR URL. */
  prUrl?: string
  /** Probe paths committed to the branch. */
  written: string[]
  /** Probe paths skipped because they already exist on the branch. */
  skipped: string[]
  /** Failure message when the lane couldn't complete. */
  error?: string
}

const PERSIST_BRANCH_PREFIX = 'argus/probe-regression-pr-'

/**
 * Commit persistable probes to `argus/probe-regression-pr-<pr>` and open a
 * regression-test PR against `baseRef`. Idempotent: an existing branch is
 * reused, an existing file is skipped (never overwritten — contents API
 * exclusive create), and an already-open PR on the branch is returned
 * rather than duplicated.
 */
export async function persistProbes(
  repo: string,
  pr: string,
  baseRef: string,
  probes: PersistableProbe[],
  token: string,
  ctx: Ctx,
): Promise<PersistResult> {
  const api = 'https://api.github.com'
  const branch = `${PERSIST_BRANCH_PREFIX}${pr}`

  const base = (await ghGet(`${api}/repos/${repo}/git/ref/heads/${baseRef}`, token, ctx)) as
    | { object?: { sha?: string } }
    | undefined
  const baseSha = base?.object?.sha
  if (typeof baseSha !== 'string') {
    return { written: [], skipped: [], error: `couldn't resolve base ref ${baseRef}` }
  }

  const created = await ghWrite('POST', `${api}/repos/${repo}/git/refs`, token, ctx, {
    ref: `refs/heads/${branch}`,
    sha: baseSha,
  })
  // 422 = ref already exists — reuse the branch (idempotent re-persist).
  if (created.status !== 201 && created.status !== 422) {
    return { written: [], skipped: [], error: `couldn't create branch ${branch} (github ${created.status})` }
  }

  const written: string[] = []
  const skipped: string[] = []
  for (const probe of probes) {
    const put = await ghWrite(
      'PUT',
      `${api}/repos/${repo}/contents/${encodeURIComponent(probe.path)}`,
      token,
      ctx,
      {
        message: `test: argus probe regression for #${pr} (${probe.file})`,
        content: Buffer.from(probe.content, 'utf8').toString('base64'),
        branch,
      },
    )
    if (put.status === 201) {
      written.push(probe.path)
    } else if (put.status === 422) {
      // File already exists on the branch — exclusive create honors the
      // never-overwrite contract.
      skipped.push(probe.path)
    } else {
      return { written, skipped, error: `couldn't write ${probe.path} (github ${put.status})` }
    }
  }

  const owner = repo.split('/')[0] ?? repo
  const open = (await ghGet(
    `${api}/repos/${repo}/pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&state=open`,
    token,
    ctx,
  )) as { html_url?: string }[] | undefined
  const existing = Array.isArray(open) ? open[0]?.html_url : undefined
  if (typeof existing === 'string') {
    return { prUrl: existing, written, skipped }
  }

  const fileList = [
    ...written.map((p) => `\`${p}\` (new)`),
    ...skipped.map((p) => `\`${p}\` (already present)`),
  ]
  const createdPr = await ghWrite('POST', `${api}/repos/${repo}/pulls`, token, ctx, {
    title: `test: Argus reproduced-probe regression for #${pr}`,
    head: branch,
    base: baseRef,
    body:
      `Argus reproduced blocking finding(s) on #${pr} with a sandbox probe ` +
      `(fails on head, clean on base). This PR commits the probe source as a ` +
      `regression test.\n\n` +
      `Files:\n${fileList.map((f) => `- ${f}`).join('\n')}\n\n` +
      `**Warning:** Probe source is model-authored; review before merging. ` +
      `Generated by [argus-reviewer](https://github.com/duketopceo/argus-reviewer).`,
  })
  const url = (createdPr.data as { html_url?: string } | undefined)?.html_url
  if (createdPr.status !== 201 || typeof url !== 'string') {
    return {
      written,
      skipped,
      error: `probe file(s) committed but PR open failed (github ${createdPr.status})`,
    }
  }
  return { prUrl: url, written, skipped }
}
