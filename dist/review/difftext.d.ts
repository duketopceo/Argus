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
export declare const GIT_DIFF_PATH_FLAGS: string[];
export interface AddedLine {
    file: string;
    /** Line number in the post-change file. */
    line: number;
    /** The added line's text, without the leading `+`. */
    text: string;
}
/** `+++ <path>` header — plain `b/<path>` or git C-quoted `"b/<path>"`. */
export declare function parsePlusPlus(raw: string): string | undefined;
export interface DiffHunkLine {
    kind: 'add' | 'del' | 'ctx';
    file: string;
    /** Monotonic hunk index — increments on every `@@`, so consumers that
     * track state from context lines can detect when the visible window
     * jumped (the opener their state depends on may be out of view). */
    hunk: number;
    /** Post-change line number (for `del`, the next-to-be-assigned number). */
    line: number;
    text: string;
}
/**
 * Kind-tagged walker over unified-diff hunk lines — the one walker all
 * diff consumers share so `@@` ordering, `+++` header quirks (C-quoted
 * paths, `/dev/null`), and line numbering can't drift between parsers.
 * Lines in sections without a parseable `+++` header (deleted files)
 * are skipped; `del` lines do not consume a new-side line number.
 */
export declare function diffLines(diff: string): Generator<DiffHunkLine>;
export declare function addedLines(diff: string): AddedLine[];
