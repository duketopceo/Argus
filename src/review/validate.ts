/**
 * Deterministic finding validation (no model). A finding must point at a
 * file that is in the reviewed diff and at a line inside the diff's
 * changed hunks (plus a small context tolerance). Anything else is a
 * hallucinated or stale anchor; it is dropped here and counted in the
 * report so the drop is never silent.
 */

export type DropReason =
  | 'file_not_in_diff'
  | 'file_excluded'
  | 'file_deleted'
  | 'line_beyond_file'
  | 'line_outside_diff'

export interface DroppedFinding {
  file: string
  line?: number
  reason: DropReason
}

export interface ValidationAudit {
  dropped: number
  byReason: Partial<Record<DropReason, number>>
  /** Up to 10 dropped anchors, for the Diagnostics fold. */
  examples: DroppedFinding[]
}

/** Lines of slack around a hunk: models are often off by a line or two. */
export const HUNK_TOLERANCE = 2
const MAX_EXAMPLES = 10

export interface ParsedHunks {
  /** Inclusive new-side [start, end] line ranges, one per hunk with new lines. */
  ranges: [number, number][]
  /** Set when the patch creates the file: its exact line count. */
  newFileLength?: number
  /** True when no new-side lines survive (file deleted at head). */
  deleted: boolean
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

export function parseHunks(patch: string): ParsedHunks {
  const ranges: [number, number][] = []
  let newFileLength: number | undefined
  let sawHunk = false
  for (const line of patch.split('\n')) {
    const m = HUNK_HEADER.exec(line)
    if (m === null) continue
    sawHunk = true
    const oldStart = Number(m[1])
    const oldCount = m[2] === undefined ? 1 : Number(m[2])
    const start = Number(m[3])
    const count = m[4] === undefined ? 1 : Number(m[4])
    if (count > 0) ranges.push([start, start + count - 1])
    if (oldStart === 0 && oldCount === 0) newFileLength = count
  }
  return {
    ranges,
    ...(newFileLength !== undefined ? { newFileLength } : {}),
    deleted: sawHunk && ranges.length === 0,
  }
}

const norm = (p: string): string => p.replace(/^\.\//, '')

export function validateFindings<T extends { file: string; line?: number }>(
  findings: T[],
  files: { filename: string; patch?: string }[],
  excluded: ReadonlySet<string> = new Set(),
): { kept: T[]; dropped: DroppedFinding[] } {
  const byName = new Map<string, ParsedHunks>()
  for (const f of files) byName.set(f.filename, parseHunks(f.patch ?? ''))
  const kept: T[] = []
  const dropped: DroppedFinding[] = []
  for (const f of findings) {
    const file = norm(String(f.file ?? ''))
    const hunks = byName.get(file)
    const hasLine = typeof f.line === 'number' && Number.isFinite(f.line)
    const drop = (reason: DropReason): void => {
      dropped.push({ file: String(f.file), ...(hasLine ? { line: f.line as number } : {}), reason })
    }
    if (hunks === undefined) {
      drop(excluded.has(file) ? 'file_excluded' : 'file_not_in_diff')
    } else if (hunks.deleted) {
      drop('file_deleted')
    } else if (!hasLine) {
      kept.push(f)
    } else if (hunks.newFileLength !== undefined && (f.line as number) > hunks.newFileLength) {
      drop('line_beyond_file')
    } else if (
      !hunks.ranges.some(
        ([s, e]) => (f.line as number) >= s - HUNK_TOLERANCE && (f.line as number) <= e + HUNK_TOLERANCE,
      )
    ) {
      drop('line_outside_diff')
    } else {
      kept.push(f)
    }
  }
  return { kept, dropped }
}

export function auditOf(dropped: DroppedFinding[]): ValidationAudit {
  const byReason: Partial<Record<DropReason, number>> = {}
  for (const d of dropped) byReason[d.reason] = (byReason[d.reason] ?? 0) + 1
  return { dropped: dropped.length, byReason, examples: dropped.slice(0, MAX_EXAMPLES) }
}

/** RIGHT-side line numbers covered by a unified-diff patch — parity with
 *  `rightSideLines` in action/sticky-comment.cjs (every line in a hunk's
 *  `+c,d` range is a valid RIGHT-side anchor; `-` lines aren't counted). */
export function rightSideLines(patch: string): Set<number> {
  const lines = new Set<number>()
  for (const m of patch.matchAll(/@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/g)) {
    const start = Number.parseInt(m[1] ?? '0', 10)
    const count = m[2] === undefined ? 1 : Number.parseInt(m[2], 10)
    for (let l = start; l < start + count; l++) lines.add(l)
  }
  return lines
}

/** True when an anchor is inside the live diff — path in the file list and
 *  `line` (plus `startLine` when present) on a RIGHT-side hunk line. Parity
 *  with `isOnDiff` in action/sticky-comment.cjs. */
export function isOnDiff(
  c: { path: string; line: number; startLine?: number },
  diffLines: ReadonlyMap<string, ReadonlySet<number>>,
): boolean {
  const valid = diffLines.get(c.path)
  return (
    valid !== undefined &&
    valid.has(c.line) &&
    (c.startLine === undefined || valid.has(c.startLine))
  )
}
