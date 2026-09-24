import { type LaneId, type RunIdentity, type RunManifest } from '../report/manifest.js';
import { type BudgetOptions } from './budget.js';
import { type LaneSelection } from './contracts.js';
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
/** Run selected lanes and return one stable manifest without owning subprocesses. */
export declare function runVerify(input: VerifyInput): Promise<VerifyResult>;
export declare function selectedManifestLanes(selection: LaneSelection): LaneId[];
