/**
 * Inline review comment identity (plan KTD4, U6).
 *
 * The CLI renders each inline comment once and serializes its dedup key; the
 * action poster rebuilds the same key from comments already on the PR. Both
 * sides go through `inlineDedupKey`, and action/sticky-comment.cjs keeps a
 * copy of this file's functions (KTD2), pinned equal by a parity test.
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
export declare const INLINE_SENTINEL = "<!-- argus-reviewer:inline -->";
/**
 * Strip the prefix the review prompt asks the model for (`L42: <emoji> bug: `)
 * in any order, so the rendered message line starts with the sentence.
 */
export declare function normalizeFindingMessage(message: string): string;
/** Severity and message of an Argus inline comment in either format; undefined for any other body. */
export declare function parseInlineBody(body: string): {
    severity: string;
    message: string;
} | undefined;
/** True when the body is an Argus inline comment (legacy prefix or the sentinel). */
export declare function isArgusInlineBody(body: string): boolean;
/** djb2 to 8 hex chars: dedup identity only, not a security boundary. */
export declare function shortHash(s: string): string;
/**
 * The fenced suggestion block of a comment body. The CLI's fence is the
 * longest backtick run plus one (min 4), so a run of exactly that length can
 * only be the closing fence.
 */
export declare function extractSuggestion(body: string): string;
/**
 * KTD4 dedup key: `path:line:severity:normalizedMessage:hash8(suggestion)`.
 * A changed suggestion changes the key, so a corrected fix re-posts. A body
 * that parses as neither format keeps the pre-U6 first-line key.
 */
export declare function inlineDedupKey(path: string, line: number, body: string): string;
