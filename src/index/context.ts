import { readIndex, type IndexEntry, type RepoIndex } from './scan.js'

export const CONTEXT_PREFIX = '> context:'

const MAX_LIST = 5
// ~500 estimated tokens per block (chars/4) — hard per-file cap
const MAX_BLOCK_CHARS = 2000
const MAX_PURPOSE_CHARS = 80
// Paths render as `key=a, b` — a filename containing these could forge a
// second key or break the single-line format.
const UNSAFE_PATH_CHARS = /[,=>\n\r"`]/g
// Cheap secret heuristic: `key=…`-style assignments and long high-entropy
// runs are redacted rather than echoed into an LLM prompt.
const SECRETISH_RE = /(api[_-]?key|token|secret|passwd|password)\s*[:=]/i
const LONG_TOKEN_RE = /[A-Za-z0-9+/=_-]{40,}/

export interface ContextRequest {
  /** Repo-relative path as reported by the PR files API. */
  filename: string
  /** For renames, the pre-rename path — the index likely still holds it. */
  previousFilename?: string
}

function normalize(path: string): string {
  return path.replace(/^\.\//, '').replace(/\\/g, '/')
}

/** Shortest paths first — closer imports are usually the most relevant. */
function shortPaths(paths: string[]): string[] {
  const safe = paths
    .map((p) => normalize(p).replace(UNSAFE_PATH_CHARS, ''))
    .filter((p) => p !== '')
    .sort((a, b) => a.length - b.length || a.localeCompare(b))
  return safe.slice(0, MAX_LIST)
}

function sanitizePurpose(purpose: string | undefined): string | undefined {
  if (purpose === undefined) return undefined
  const cleaned = purpose
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/[`|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_PURPOSE_CHARS)
  if (cleaned === '') return undefined
  if (SECRETISH_RE.test(cleaned) || LONG_TOKEN_RE.test(cleaned)) return undefined
  return cleaned
}

function blockFor(entry: IndexEntry): string | undefined {
  const parts: string[] = []
  const purpose = sanitizePurpose(entry.purpose)
  if (purpose !== undefined) {
    parts.push(`purpose=${purpose}`)
  }
  if (entry.importedBy.length > 0) {
    const list = shortPaths(entry.importedBy)
    if (list.length > 0) parts.push(`importedBy=${list.join(', ')}`)
  }
  if (entry.imports.length > 0) {
    const list = shortPaths(entry.imports)
    if (list.length > 0) parts.push(`imports=${list.join(', ')}`)
  }
  if (parts.length === 0) return undefined
  const block = `${CONTEXT_PREFIX} ${parts.join(' | ')}`
  return block.length > MAX_BLOCK_CHARS ? block.slice(0, MAX_BLOCK_CHARS) : block
}

/**
 * Build per-file `> context:` blocks from an already-loaded index. Values are
 * sanitized before they reach an LLM prompt — index data is repo-controlled
 * text and must be treated as untrusted. Files absent from the index are
 * silently omitted; renames fall back to the pre-rename path.
 */
export function buildReviewContext(
  index: RepoIndex | undefined,
  files: ContextRequest[],
): Record<string, string> {
  if (index === undefined) return {}
  const byPath = new Map(index.entries.map((e) => [normalize(e.path), e]))
  const out: Record<string, string> = {}
  for (const f of files) {
    const entry =
      byPath.get(normalize(f.filename)) ??
      (f.previousFilename !== undefined
        ? byPath.get(normalize(f.previousFilename))
        : undefined)
    if (entry === undefined) continue
    const block = blockFor(entry)
    if (block !== undefined) out[f.filename] = block
  }
  return out
}

/** Convenience wrapper: read argus.index.json then build the context map. */
export async function loadReviewContext(
  indexPath: string,
  files: ContextRequest[],
): Promise<Record<string, string>> {
  return buildReviewContext(await readIndex(indexPath), files)
}
