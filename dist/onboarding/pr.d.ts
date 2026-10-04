import type { ExecFn } from '../detect.js';
export { DEFAULT_BRANCH, renderPrBody, validateBranch, validateRepo, type PrBodyInput } from './pr-content.js';
/** owner/name from a GitHub remote URL (ssh, https, with or without .git). */
export declare function parseGithubRemote(url: string): string | undefined;
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
