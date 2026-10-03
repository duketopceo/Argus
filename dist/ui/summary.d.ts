import { type LaneStatus, type RunManifest } from '../report/manifest.js';
import type { Styler } from './style.js';
/**
 * End-of-run summary block for `run` and `verify` (R13, DESIGN.md 7.7), in
 * the same grammar as the PR comment: verdict line, one row per lane, then
 * total spend against budget and the report path.
 *
 *   ⊘ failed   head abc1234   38.1s
 *     ⊘ review   3 findings, 2 reproduced      $0.003100
 *     ● flow     4/4 journeys, 1 healed        $0.000000
 *     total $0.004210 of $1.00 budget · report argus-reviewer-report/run-manifest.json
 */
export interface SummaryLane {
    lane: string;
    status: LaneStatus;
    detail: string;
    costUsd: number;
    /** false for lanes whose spend Argus cannot see (a0): shows "unmetered". */
    metered: boolean;
    limitUsd?: number | undefined;
    spentUsd?: number | undefined;
    exceeded?: boolean | undefined;
}
export interface SummaryInput {
    status: LaneStatus;
    headSha?: string | undefined;
    durationMs?: number | undefined;
    lanes: SummaryLane[];
    totalUsd: number;
    /** Sum of the lane caps; omitted when no lane has a dollar cap. */
    budgetUsd?: number | undefined;
    reportPath?: string | undefined;
}
/** The config key that raises each lane's dollar cap (ARGUS_BUDGET_USD overrides all). */
export declare const BUDGET_KEY: Record<string, string>;
export declare function renderSummary(input: SummaryInput, style: Styler, width?: number): string[];
/** Project a verify manifest onto the summary block. */
export declare function verifySummary(manifest: RunManifest, reportPath: string): SummaryInput;
