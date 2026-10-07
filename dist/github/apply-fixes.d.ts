import { type PrMeta } from '../evidence/ci.js';
interface Ctx {
    err: (line: string) => void;
}
interface AppliedFix {
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
interface SkippedFix {
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
    /** GITHUB_ACTOR — the workflow actor, whose `[bot]` login Argus posts as. */
    actor?: string | undefined;
}, token: string, ctx: Ctx): Promise<ApplyFixesResult>;
export {};
