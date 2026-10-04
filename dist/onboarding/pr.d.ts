import type { ExecFn } from '../detect.js';
export declare const DEFAULT_BRANCH = "argus/onboarding";
/** A validation message, or undefined when the repo slug is safe to use in argv and URLs. */
export declare function validateRepo(repo: string): string | undefined;
export declare function validateBranch(branch: string): string | undefined;
/** owner/name from a GitHub remote URL (ssh, https, with or without .git). */
export declare function parseGithubRemote(url: string): string | undefined;
export interface PrBodyInput {
    repo: string;
    /** Default per-run budget in USD, from the resolved config defaults. */
    budgetUsd: number;
    /** Files this PR adds. */
    paths: string[];
}
export declare function renderPrBody(input: PrBodyInput): string;
export interface InitPrOptions {
    cwd: string;
    exec: ExecFn;
    repo: string | undefined;
    branch: string;
    budgetUsd: number;
}
export type InitPrResult = {
    kind: 'created';
    url: string;
    repo: string;
    branch: string;
} | {
    kind: 'existing';
    url: string;
    repo: string;
    branch: string;
};
export declare function initPr(opts: InitPrOptions): Promise<InitPrResult>;
