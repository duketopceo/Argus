/**
 * Added-line iteration over unified-diff text — the shared scan surface
 * for the deterministic lanes (rules engine, secrets patterns).
 *
 * `+++`/`---` are file headers only before the first `@@` of a section;
 * inside a hunk they are added/removed content and must not reset state.
 * Context lines consume a post-change line number; `-` lines do not.
 * Lines under `+++ /dev/null` (deleted files) yield `file === ''` and are
 * skipped by consumers.
 */

export interface AddedLine {
  file: string
  /** Line number in the post-change file. */
  line: number
  /** The added line's text, without the leading `+`. */
  text: string
}

export function addedLines(diff: string): AddedLine[] {
  const out: AddedLine[] = []
  let file = ''
  let newLine = 0
  let inHunk = false
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git')) {
      inHunk = false
      continue
    }
    if (raw.startsWith('@@')) {
      inHunk = true
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
      newLine = m !== null ? parseInt(m[1] as string, 10) : 0
      continue
    }
    if (!inHunk) {
      if (raw.startsWith('+++ ')) {
        const m = /^\+\+\+ b\/(.+)$/.exec(raw)
        file = m?.[1] ?? ''
      }
      continue
    }
    if (raw.startsWith(' ')) {
      newLine++
      continue
    }
    if (!raw.startsWith('+') || file === '') continue
    out.push({ file, line: newLine, text: raw.slice(1) })
    newLine++
  }
  return out
}
