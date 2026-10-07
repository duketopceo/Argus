import { type LaneId, type RunIdentity, type RunManifest } from '../report/manifest.js';
import { type BudgetOptions } from './budget.js';
import type { LaneSelection } from './contracts.js';
interface VerifyRunners {
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
/**
 * Write the offline HTML evidence report (U14) beside run-manifest.json.
 * Lane reports are read only when the manifest points at them: a runner that
 * threw leaves `reportPath` unset, and its stale file must not reach the
 * report (same contract as the manifest's own reads).
 */
export declare function writeEvidenceReport(reportDir: string, manifest: RunManifest, meta?: {
    version?: string;
    runUrl?: string;
}): Promise<string>;
export {};
