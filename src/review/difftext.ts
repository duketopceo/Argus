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

/**
 * git `-c` pins every diff producer feeding this lane must use — ambient
 * gitconfig (`diff.noprefix`, `diff.dstPrefix`, `core.quotePath`) rewrites
 * or C-quotes the `+++` headers the walker parses, silently emptying the
 * scan surface.
 */
export const GIT_DIFF_PATH_FLAGS = [
  'diff.mnemonicPrefix=false',
  'diff.noprefix=false',
  'diff.srcPrefix=a/',
  'diff.dstPrefix=b/',
  'core.quotePath=false',
].flatMap((kv) => ['-c', kv])

export interface AddedLine {
  file: string
  /** Line number in the post-change file. */
  line: number
  /** The added line's text, without the leading `+`. */
  text: string
}

/**
 * git C-quote unescape — `\"` `\\`, letter escapes, `\NNN` octal. git
 * quotes byte-wise: high bytes arrive as octal UTF-8 units, so decode
 * through bytes — `String.fromCharCode` would mis-decode multi-byte
 * sequences (`\303\251` must be `é`, not `Ã©`).
 */
function unquoteGitPath(s: string): string {
  const NAMED: Record<string, number> = {
    n: 10,
    t: 9,
    r: 13,
    b: 8,
    f: 12,
    v: 11,
    a: 7,
  }
  const bytes: number[] = []
  let i = 0
  while (i < s.length) {
    const ch = s[i] as string
    if (ch !== '\\') {
      for (const b of Buffer.from(ch, 'utf8')) bytes.push(b)
      i++
      continue
    }
    const n = s[i + 1]
    const oct = n !== undefined ? /^[0-7]{3}/.exec(s.slice(i + 1)) : null
    if (n === '"' || n === '\\') {
      bytes.push(n.charCodeAt(0))
      i += 2
    } else if (n !== undefined && n in NAMED) {
      bytes.push(NAMED[n] as number)
      i += 2
    } else if (oct !== null) {
      bytes.push(parseInt(oct[0], 8))
      i += 1 + oct[0].length
    } else {
      // Unknown escape — keep the backslash literal.
      for (const b of Buffer.from(ch, 'utf8')) bytes.push(b)
      i++
    }
  }
  return Buffer.from(bytes).toString('utf8')
}

/** `+++ <path>` header — plain `b/<path>` or git C-quoted `"b/<path>"`. */
export function parsePlusPlus(raw: string): string | undefined {
  const plain = /^\+\+\+ b\/(.+)$/.exec(raw)
  if (plain !== null) return plain[1]
  const quoted = /^\+\+\+ "b\/((?:[^"\\]|\\.)*)"$/.exec(raw)
  if (quoted !== null) return unquoteGitPath(quoted[1] as string)
  return undefined
}

export interface DiffHunkLine {
  kind: 'add' | 'del' | 'ctx'
  file: string
  /** Monotonic hunk index — increments on every `@@`, so consumers that
   * track state from context lines can detect when the visible window
   * jumped (the opener their state depends on may be out of view). */
  hunk: number
  /** Post-change line number (for `del`, the next-to-be-assigned number). */
  line: number
  text: string
}

/**
 * Kind-tagged walker over unified-diff hunk lines — the one walker all
 * diff consumers share so `@@` ordering, `+++` header quirks (C-quoted
 * paths, `/dev/null`), and line numbering can't drift between parsers.
 * Lines in sections without a parseable `+++` header (deleted files)
 * are skipped; `del` lines do not consume a new-side line number.
 */
export function* diffLines(diff: string): Generator<DiffHunkLine> {
  let file = ''
  let newLine = 0
  let inHunk = false
  let hunk = 0
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git')) {
      // Reset both — a section without a parseable `+++` header must not
      // inherit the previous file's name.
      inHunk = false
      file = ''
      continue
    }
    // `@@` must reset before the `!inHunk` gate — second and later hunks
    // of a file still carry their own line offsets.
    if (raw.startsWith('@@')) {
      inHunk = true
      hunk++
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
      newLine = m !== null ? parseInt(m[1] as string, 10) : 0
      continue
    }
    if (!inHunk) {
      if (raw.startsWith('+++ ')) {
        file = parsePlusPlus(raw) ?? ''
      }
      continue
    }
    if (file === '') continue
    if (raw.startsWith('+')) {
      yield { kind: 'add', file, hunk, line: newLine, text: raw.slice(1) }
      newLine++
      continue
    }
    if (raw.startsWith('-')) {
      yield { kind: 'del', file, hunk, line: newLine, text: raw.slice(1) }
      continue
    }
    if (raw.startsWith(' ')) {
      yield { kind: 'ctx', file, hunk, line: newLine, text: raw.slice(1) }
      newLine++
    }
  }
}

// The rules lane runs N rules over the same diff text; every rule used to
// re-parse it. Single-entry memo — callers treat the result as read-only
// (every consumer iterates; none mutates).
let lastDiff: string | undefined
let lastLines: AddedLine[] | undefined

export function addedLines(diff: string): AddedLine[] {
  if (diff === lastDiff && lastLines !== undefined) return lastLines
  const out: AddedLine[] = []
  for (const l of diffLines(diff)) {
    if (l.kind === 'add') out.push({ file: l.file, line: l.line, text: l.text })
  }
  lastDiff = diff
  lastLines = out
  return out
}
