/**
 * Chunk planning for large PRs.
 *
 * A diff over the per-call token target is reviewed in several model calls
 * instead of one oversized (or truncated) prompt. Files are grouped by
 * directory so a chunk reads as one area of the change, and a single patch
 * larger than the target is split at hunk boundaries. Every chunk records
 * which files it carries so a partial review can say what it did not cover.
 */

const CHUNK_TOKEN_TARGET = 6000
const CHUNK_FILE_OVERHEAD = 100

export interface ChunkFile {
  filename: string
  patch?: string
}

export interface PlannedChunk {
  /** Prompt text for this chunk. */
  text: string
  /** Files with content in this chunk (a split file appears in each part). */
  files: string[]
}

const tokensOf = (s: string): number => Math.ceil(s.length / 4)

function dirOf(filename: string): string {
  const i = filename.lastIndexOf('/')
  return i < 0 ? '' : filename.slice(0, i)
}

/** Stable group-by-directory; groups keep first-appearance order. */
function groupByDir<T extends ChunkFile>(files: T[]): T[] {
  const groups = new Map<string, T[]>()
  for (const f of files) {
    const d = dirOf(f.filename)
    const g = groups.get(d)
    if (g === undefined) groups.set(d, [f])
    else g.push(f)
  }
  return [...groups.values()].flat()
}

/** Split a patch at `@@` hunk starts into parts that each fit `budgetTokens`. */
function splitPatch(patch: string, budgetTokens: number): string[] {
  const firstHunk = patch.search(/^@@/m)
  if (firstHunk < 0) return [patch]
  const header = patch.slice(0, firstHunk)
  const hunks = patch.slice(firstHunk).split(/^(?=@@)/m)
  const parts: string[] = []
  let cur = header
  for (const h of hunks) {
    if (cur !== header && tokensOf(cur) + tokensOf(h) > budgetTokens) {
      parts.push(cur)
      cur = header
    }
    cur += h
  }
  if (cur !== header) parts.push(cur)
  return parts
}

export function planChunks(
  files: ChunkFile[],
  contexts: Record<string, string> = {},
  targetTokens: number = CHUNK_TOKEN_TARGET,
): PlannedChunk[] {
  interface Unit {
    filename: string
    text: string
    tokens: number
  }
  const units: Unit[] = []
  for (const f of groupByDir(files)) {
    const patch = f.patch ?? ''
    const ctxBlock = contexts[f.filename]
    const ctxTokens = ctxBlock === undefined ? 0 : tokensOf(ctxBlock)
    const section = (label: string, body: string): string => {
      const head = ctxBlock === undefined ? `### ${label}` : `### ${label}\n${ctxBlock}`
      return `${head}\n\`\`\`diff\n${body}\n\`\`\``
    }
    const whole = tokensOf(patch) + ctxTokens + CHUNK_FILE_OVERHEAD
    if (whole <= targetTokens) {
      units.push({ filename: f.filename, text: section(f.filename, patch), tokens: whole })
      continue
    }
    const parts = splitPatch(patch, Math.max(1, targetTokens - ctxTokens - CHUNK_FILE_OVERHEAD))
    parts.forEach((p, i) => {
      const label = parts.length > 1 ? `${f.filename} (part ${i + 1}/${parts.length})` : f.filename
      units.push({
        filename: f.filename,
        text: section(label, p),
        tokens: tokensOf(p) + ctxTokens + CHUNK_FILE_OVERHEAD,
      })
    })
  }

  const chunks: PlannedChunk[] = []
  let cur: Unit[] = []
  let curTokens = 0
  const flush = (): void => {
    if (cur.length === 0) return
    chunks.push({
      text: cur.map((u) => u.text).join('\n\n'),
      files: [...new Set(cur.map((u) => u.filename))],
    })
    cur = []
    curTokens = 0
  }
  for (const u of units) {
    if (cur.length > 0 && curTokens + u.tokens > targetTokens) flush()
    cur.push(u)
    curTokens += u.tokens
  }
  flush()
  return chunks
}
