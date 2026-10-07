import type { ExecFn } from '../detect.js';
export { DEFAULT_BRANCH, renderPrBody, validateBranch, validateRepo } from './pr-content.js';
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
