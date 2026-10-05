import { type PrMeta } from '../evidence/ci.js';
interface Ctx {
    err: (line: string) => void;
}
/**
 * `@argus fix` apply lane (U5). Applies every *posted, still-valid* inline
 * suggestion to a dedicated branch and opens one PR back onto the PR's head
 * branch.
 *
 * Trust model: suggestions come from review comments Argus itself posted
 * (`isArgusInlineBody`), re-read from the live API — never from a stored
 * report artifact a commenter could have edited. Each anchor is re-validated
 * against the CURRENT diff (`rightSideLines`/`isOnDiff` parity with the
 * poster), and each comment must be bound to the current head commit
 * (`commit_id === headSha`). The write branch forks at the exact head SHA
 * and the head is re-verified before the PR opens (TOCTOU).
 */
/** Largest suggestion span applied — a suggestion over this many lines is a
 *  rewrite, not a fix, and is skipped with a named reason. */
export declare const MAX_FIX_SPAN = 50;
export interface AppliedFix {
    path: string;
    /** First line of the replaced span (== `line` for single-line suggestions). */
    startLine: number;
    line: number;
    /** Finding message from the comment body, for the PR body. */
    message: string;
    severity: string;
    /** Lines the suggestion replaced — rendered verbatim in the PR body. */
    replaced: string[];
    /** The suggestion's replacement text. */
    replacement: string;
    url: string | undefined;
}
export interface SkippedFix {
    path: string | undefined;
    line: number | undefined;
    reason: string;
}
export interface ApplyFixesResult {
    prUrl?: string;
    applied: AppliedFix[];
    skipped: SkippedFix[];
    /** Set when nothing could run — fetch failures, stale head, write errors. */
    error?: string;
    /** Head moved between listing and PR open — commits sit on the branch, no PR. */
    stale?: boolean;
}
/**
 * Apply posted inline suggestions for `pr` at `meta.headSha`. `files` is the
 * CURRENT `/pulls/{pr}/files` list (the anchor re-validation surface).
 */
export declare function applyFixes(opts: {
    repo: string;
    pr: string;
    meta: PrMeta;
    files: {
        filename: string;
        patch?: string;
    }[];
}, token: string, ctx: Ctx): Promise<ApplyFixesResult>;
export {};
