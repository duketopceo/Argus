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
}
/**
 * Shared GitHub GET scaffold — Bearer auth, API headers, 30s abort timeout,
 * `ctx.err` on non-ok/timeout, undefined on failure. Reuse for any
 * api.github.com read (fetchPrFiles in cli.ts paginates over it).
 */
export declare function ghGet(url: string, token: string, ctx: Ctx): Promise<unknown | undefined>;
/**
 * PR metadata for the evidence + probe lanes — the head SHA check-runs attach
 * to, plus the fork/association/label signals the sandbox fork gate (KTD5)
 * evaluates. One `/pulls/{pr}` request; undefined when the request fails.
 */
export declare function fetchPrMeta(repo: string, pr: string, token: string, ctx: Ctx): Promise<PrMeta | undefined>;
/** Check-runs on a commit — the consumer's own CI signal. */
export declare function fetchCheckRuns(repo: string, sha: string, token: string, ctx: Ctx): Promise<CheckRun[] | undefined>;
export {};
