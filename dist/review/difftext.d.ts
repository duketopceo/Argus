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
    file: string;
    /** Line number in the post-change file. */
    line: number;
    /** The added line's text, without the leading `+`. */
    text: string;
}
export declare function addedLines(diff: string): AddedLine[];
