export declare const DEFAULT_BRANCH = "argus/onboarding";
/** A validation message, or undefined when the repo slug is safe to use in argv and URLs. */
export declare function validateRepo(repo: string): string | undefined;
export declare function validateBranch(branch: string): string | undefined;
export interface PrBodyInput {
    repo: string;
    /** Default per-run budget in USD, from the resolved config defaults. */
    budgetUsd: number;
    /** Files this PR adds. */
    paths: string[];
}
export declare function renderPrBody(input: PrBodyInput): string;
