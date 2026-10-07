interface Ctx {
    err: (line: string) => void;
}
/**
 * Shared "commit files to a dedicated branch and open one PR" writer —
 * extracted from `persistProbes` so heal write-back, generated-spec PRs, and
 * `@argus fix` apply-PRs share one audited write path (refs + contents +
 * pulls, never a checkout, never the base ref).
 *
 * File semantics come in two modes:
 * - `create` (persist contract): exclusive create — an existing file 422s
 *   and is reported `skipped`, never overwritten.
 * - `upsert`: the file's current blob sha is read on the branch and the PUT
 *   carries it — an update, still branch-scoped.
 */
interface WritePrFile {
    /** Repo-relative write path — callers validate `isSafeRepoPath` upstream. */
    path: string;
    /** File content (utf8 — encoded by the caller-side write). */
    content: string;
}
export interface CreateFilesPrOpts {
    /** `owner/repo`. */
    repo: string;
    /** Base branch the PR targets and the write branch forks from. */
    baseRef: string;
    /**
     * Exact commit the write branch forks from. When set it replaces the
     * `baseRef` resolution — `@argus fix` uses this to bind the branch to the
     * reviewed head SHA rather than wherever the head ref has moved to.
     */
    baseSha?: string;
    /**
     * Hook evaluated after the file writes, before the PR is opened. Return a
     * string to abort the open with that reason in `error` (commits stay on
     * the branch — idempotent for a re-run). `@argus fix` uses it to re-verify
     * the head SHA (TOCTOU) between write and open.
     */
    preOpen?: () => Promise<string | undefined>;
    /** Dedicated branch name — `argus/…` prefix by convention. */
    branch: string;
    files: WritePrFile[];
    title: string;
    /**
     * PR body — a string, or a callback evaluated after the writes so it can
     * render what actually landed (written/updated/skipped).
     */
    body: string | ((r: {
        written: string[];
        updated: string[];
        skipped: string[];
    }) => string);
    /** Existing-file contract on the write branch. */
    exists: 'create' | 'upsert';
}
export interface CreateFilesPrResult {
    /** Opened (or reused) PR URL. */
    prUrl?: string;
    /** True when `prUrl` is an already-open PR on the branch, not a new one. */
    existing?: boolean;
    /** Paths committed as new files. */
    written: string[];
    /** Paths updated in place (upsert mode only). */
    updated: string[];
    /** Paths skipped — existing files under `create` mode. */
    skipped: string[];
    /** Failure message when the write could not complete. */
    error?: string;
}
/**
 * Commit `files` to `branch` (created off `baseRef` or reused) and open one
 * PR. Idempotent: an existing branch is reused and an already-open PR on the
 * branch is returned rather than duplicated.
 */
export declare function createFilesPr(opts: CreateFilesPrOpts, token: string, ctx: Ctx): Promise<CreateFilesPrResult>;
export {};
