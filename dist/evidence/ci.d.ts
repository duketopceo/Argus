interface Ctx {
    err: (line: string) => void;
}
/** Maintainer-applied PR label that opts a fork PR into sandbox probes. */
export declare const PROBE_LABEL = "argus-probe";
/**
 * GitHub `author_association` values trusted to run probes on fork PRs —
 * repo members/owners/collaborators. CONTRIBUTOR, FIRST_TIME_CONTRIBUTOR,
 * FIRST_TIMER, MANNEQUIN, and NONE are not.
 */
export declare function isTrustedAssociation(association: string | undefined): boolean;
export interface CheckRun {
    name: string;
    /** GitHub check-run conclusion once status === 'completed'; undefined while pending. */
    conclusion: string | undefined;
    completed: boolean;
    url: string | undefined;
}
export interface PrMeta {
    /** PR head SHA — the commit the PR's check-runs are attached to. */
    headSha: string | undefined;
    /** PR base SHA — the merge base probes run against for the double-run. */
    baseSha: string | undefined;
    /** PR base branch name (e.g. `main`) — the persist lane's PR target. */
    baseRef: string | undefined;
    /** `head.repo.fork` — true when the PR head branch lives in a fork. */
    isFork: boolean;
    /**
     * Raw `author_association` for the PR (OWNER, MEMBER, COLLABORATOR,
     * CONTRIBUTOR, FIRST_TIME_CONTRIBUTOR, FIRST_TIMER, MANNEQUIN, NONE).
     */
    authorAssociation: string | undefined;
    /** Names of labels currently applied to the PR. */
    labels: string[];
    /**
     * `head.repo.pushed_at` — the freshest push timestamp the probe label gate
     * can compare against (head commits arrive via pushes; comparing against
     * this is what binds label approval to the current head).
     */
    pushedAt: string | undefined;
    /**
     * Timestamp of the newest `argus-probe` `labeled` event on the PR, from the
     * issue timeline — undefined when the label was never applied or the
     * timeline fetch failed (the gate fails closed either way).
     */
    labelApprovedAt: string | undefined;
    /** PR title/body — triage state only (untrusted text; feeds the confidence model, never gates). */
    title: string | undefined;
    body: string | undefined;
}
/**
 * Shared GitHub GET scaffold — Bearer auth, API headers, 30s abort timeout,
 * `ctx.err` on non-ok/timeout, undefined on failure. Reuse for any
 * api.github.com read (fetchPrFiles in cli.ts paginates over it).
 */
export declare function ghGet(url: string, token: string, ctx: Ctx): Promise<unknown | undefined>;
/**
 * Write twin of `ghGet` — POST/PUT/PATCH/DELETE with an optional JSON body,
 * same auth/timeout contract. Unlike ghGet, callers usually need the status
 * (201-created vs 422-exists is meaningful for idempotent writes), so the
 * response returns `{ status, data }` and failures return `{ status: 0 }`.
 */
export declare function ghWrite(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, token: string, ctx: Ctx, body?: unknown): Promise<{
    status: number;
    data: unknown;
}>;
/**
 * PR metadata for the evidence + probe lanes — the head SHA check-runs attach
 * to, plus the fork/association/label signals the sandbox fork gate (KTD5)
 * evaluates. One `/pulls/{pr}` request; undefined when the request fails.
 */
export declare function fetchPrMeta(repo: string, pr: string, token: string, ctx: Ctx): Promise<PrMeta | undefined>;
export interface CompareFilesResult {
    /** `ahead` = head strictly contains base; `identical`/`behind`/`diverged` fail the ancestor check. */
    status: string | undefined;
    /** Commits in base..head as counted by the compare API. */
    totalCommits: number | undefined;
    /** Changed files in base..head — same {filename, patch} shape as the pulls/files API. */
    files: {
        filename: string;
        patch: string;
        previous_filename?: string;
    }[];
}
/**
 * `GET /compare/{base}...{head}` — U4 incremental review needs both the
 * ancestry verdict (`status`) and the per-file patches for the range.
 * `files` paginates like pulls/files; a page short of `per_page` ends the
 * walk. undefined means the compare itself failed (shallow clone, SHA not
 * reachable from this repo) — callers fail closed to a full diff.
 */
export declare function fetchCompare(repo: string, base: string, head: string, token: string, ctx: Ctx): Promise<CompareFilesResult | undefined>;
/** The commit-status context the action posts on every reviewed head. */
export declare const REVIEW_STATUS_CONTEXT = "argus-reviewer";
/**
 * Whether an Argus commit status exists on `sha` — the API-verifiable half
 * of the U4 baseline check. A stored SHA in a sticky comment is attacker-
 * editable, so it is honored only when the repo's own Argus run is on record
 * for that commit (writing a status needs `statuses: write`; a same-repo
 * author who can forge it can already push unreviewed commits).
 */
export declare function fetchReviewedStatus(repo: string, sha: string, token: string, ctx: Ctx): Promise<boolean | undefined>;
/** Check-runs on a commit — the consumer's own CI signal. */
export declare function fetchCheckRuns(repo: string, sha: string, token: string, ctx: Ctx): Promise<CheckRun[] | undefined>;
export {};
