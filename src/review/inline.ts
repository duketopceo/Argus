import { SEVERITIES, SEVERITY_LABEL } from '../report/viewmodel.js'

/**
 * Inline review comment identity (plan KTD4, U6).
 *
 * The CLI renders each inline comment once and serializes its dedup key; the
 * action poster rebuilds the same key from comments already on the PR. Both
 * sides go through `inlineDedupKey`; the action imports these functions via
 * the generated action/parity.cjs bundle (KTD2), so no copies can drift.
 *
 * Two body formats exist on real PRs:
 *   legacy (before U6): `**argus-reviewer <sev>:** <message> \`<category>\``
 *   Ocellus (U6):       `<!-- argus-reviewer:inline -->`
 *                       `<glyph> **<severity word>** · <proof meter> <level>`
 *                       `<message>`
 * A comment posted in either format keys to the same value for the same
 * finding, so upgrading never re-posts every inline comment.
 */

/** Hidden first line of every Ocellus inline comment: marks it as Argus's own. */
export const INLINE_SENTINEL = '<!-- argus-reviewer:inline -->'

const LEGACY_PREFIX = '**argus-reviewer'
const LEGACY_LINE = /^\*\*argus-reviewer ([^:*]+):\*\* ?(.*)$/
const SEVERITY_LINE = /^(?:\S+ )?\*\*([^*]+)\*\* · /
/** The category code span the legacy renderer appended to the message. */
const CATEGORY_SUFFIX = /\s*`(?:correctness|security|performance|usability|convention|other)`$/
/** One model-message prefix: `L<n>[-<m>]:`, a leading emoji, or a `<severity>:` keyword. */
const MESSAGE_PREFIX = /^(?:L\d+(?:-\d+)?:|\p{Extended_Pictographic}\u{FE0F}?|(?:bug|risk|nit|q|question):)\s*/iu

/**
 * Strip the prefix the review prompt asks the model for (`L42: <emoji> bug: `)
 * in any order, so the rendered message line starts with the sentence.
 */
export function normalizeFindingMessage(message: string): string {
  let out = message.trim()
  for (let i = 0; i < 4; i++) {
    const next = out.replace(MESSAGE_PREFIX, '')
    if (next === out) break
    out = next
  }
  return out
}

/** The message as the dedup key sees it: normalized, no category span, one-spaced. */
function keyMessage(message: string): string {
  return normalizeFindingMessage(message.replace(CATEGORY_SUFFIX, '')).replace(/\s+/g, ' ').trim()
}

const LABEL_TO_SEVERITY = new Map<string, string>(SEVERITIES.map((s) => [SEVERITY_LABEL[s], s]))

/** Severity and message of an Argus inline comment in either format; undefined for any other body. */
export function parseInlineBody(body: string): { severity: string; message: string } | undefined {
  const lines = body.split(/\r?\n/)
  if (body.startsWith(LEGACY_PREFIX)) {
    const m = LEGACY_LINE.exec(lines[0] ?? '')
    if (m === null) return undefined
    return { severity: (m[1] ?? '').trim(), message: keyMessage(m[2] ?? '') }
  }
  if (lines[0] === INLINE_SENTINEL) {
    const m = SEVERITY_LINE.exec(lines[1] ?? '')
    if (m === null) return undefined
    const word = (m[1] ?? '').trim()
    return { severity: LABEL_TO_SEVERITY.get(word) ?? word, message: keyMessage(lines[2] ?? '') }
  }
  return undefined
}

/** True when the body is an Argus inline comment (legacy prefix or the sentinel). */
export function isArgusInlineBody(body: string): boolean {
  return body.startsWith(LEGACY_PREFIX) || body.startsWith(INLINE_SENTINEL)
}

/** djb2 to 8 hex chars: dedup identity only, not a security boundary. */
export function shortHash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(16).padStart(8, '0')
}

/**
 * The fenced suggestion block of a comment body. The CLI's fence is the
 * longest backtick run plus one (min 4), so a run of exactly that length can
 * only be the closing fence.
 */
export function extractSuggestion(body: string): string {
  const m = /\r?\n(`{4,})suggestion\r?\n([\s\S]*?)\r?\n\1/.exec(body)
  return m?.[2] ?? ''
}

/**
 * KTD4 dedup key: `path:line:severity:normalizedMessage:hash8(suggestion)`.
 * A changed suggestion changes the key, so a corrected fix re-posts. A body
 * that parses as neither format keeps the pre-U6 first-line key.
 */
export function inlineDedupKey(path: string, line: number, body: string): string {
  const parsed = parseInlineBody(body)
  const hash = shortHash(extractSuggestion(body))
  if (parsed === undefined) return `${path}:${line}:${body.split('\n')[0]}:${hash}`
  return `${path}:${line}:${parsed.severity}:${parsed.message}:${hash}`
}
