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
function parsePlusPlus(raw: string): string | undefined {
  const plain = /^\+\+\+ b\/(.+)$/.exec(raw)
  if (plain !== null) return plain[1]
  const quoted = /^\+\+\+ "b\/((?:[^"\\]|\\.)*)"$/.exec(raw)
  if (quoted !== null) return unquoteGitPath(quoted[1] as string)
  return undefined
}

export function addedLines(diff: string): AddedLine[] {
  const out: AddedLine[] = []
  let file = ''
  let newLine = 0
  let inHunk = false
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git')) {
      // Reset both — a section without a parseable `+++` header must not
      // inherit the previous file's name.
      inHunk = false
      file = ''
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
        file = parsePlusPlus(raw) ?? ''
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
