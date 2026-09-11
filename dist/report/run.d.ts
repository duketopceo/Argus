import type { HealEvent, TdAssertRecord, TdStepRecord } from '../api.js';
import type { CallCost } from '../vision/cost.js';
/**
 * JSON run report consumed by the GitHub Action (R10): per-test verdicts,
 * heal events, vision-call counts, ledger totals, and artifact paths.
 */
export interface TestReport {
    name: string;
    file: string;
    ok: boolean;
    durationMs: number;
    failureMessage: string | undefined;
    steps: TdStepRecord[];
    asserts: TdAssertRecord[];
    healEvents: HealEvent[];
    visionCalls: number;
    visionCostUsd: number;
    sandboxSeconds: number;
    budgetExceeded: boolean;
    /** Per-call cost rows for model-level attribution. */
    calls: CallCost[];
    videoPath: string | undefined;
}
export interface RunTotals {
    tests: number;
    passed: number;
    failed: number;
    visionCalls: number;
    visionCostUsd: number;
    sandboxSeconds: number;
    budgetExceeded: boolean;
    /** OpenRouter spend grouped by model id. */
    costByModel: Record<string, number>;
    /** OpenRouter call count grouped by model id. */
    callsByModel: Record<string, number>;
}
export interface RunReport {
    tool: 'argus-reviewer';
    startedAt: string;
    durationMs: number;
    ok: boolean;
    totals: RunTotals;
    tests: TestReport[];
    artifacts: {
        videos: string[];
    };
}
export declare function buildRunReport(tests: TestReport[], startedAt: Date, durationMs: number): RunReport;
export declare function writeRunReport(path: string, report: RunReport): Promise<void>;
