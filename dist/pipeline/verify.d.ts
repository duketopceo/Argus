import { type LaneId, type RunIdentity, type RunManifest } from '../report/manifest.js';
import { type BudgetOptions } from './budget.js';
import type { LaneSelection } from './contracts.js';
export interface VerifyRunners {
    review: () => Promise<number>;
    flow?: (url: string) => Promise<number>;
    app?: () => Promise<number>;
    a0?: () => Promise<number>;
}
export interface VerifyInput {
    cwd: string;
    runId: string;
    reportDir: string;
    identity: RunIdentity;
    selection: LaneSelection;
    runners: VerifyRunners;
    budgets?: Partial<Record<LaneId, BudgetOptions>>;
    flowUrl?: string;
    flowUnavailableReason?: string;
}
export interface VerifyResult {
    manifest: RunManifest;
    exitCode: number;
}
/**
 * Run selected lanes and return one stable manifest without owning
 * subprocesses. Lanes run sequentially on purpose: flow/app can both boot
 * `target.command` (port collision) and serial execution keeps budget
 * accounting and lane timing honest — each lane's startedAt is its own
 * start, not the run's.
 */
export declare function runVerify(input: VerifyInput): Promise<VerifyResult>;
