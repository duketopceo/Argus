import { type ExecFn } from '../detect.js';
import type { CallCost } from '../vision/cost.js';
/** Whether a report's source can be tied to the intended PR head. */
export type HeadBindingStatus = 'match' | 'mismatch' | 'unknown' | 'not_applicable';
export type HeadSource = 'github' | 'fixture' | 'local';
export declare const LANE_IDS: readonly ["review", "flow", "app", "a0"];
export type LaneId = (typeof LANE_IDS)[number];
export declare const LANE_STATUSES: readonly ["passed", "failed", "skipped", "blocked", "unavailable", "inconclusive"];
export type LaneStatus = (typeof LANE_STATUSES)[number];
export declare const MANIFEST_SCHEMA_VERSION: 1;
export interface HeadBinding {
    intendedSha: string | undefined;
    checkoutSha: string | undefined;
    status: HeadBindingStatus;
    source: HeadSource;
    detail: string;
}
export interface UsageSummary {
    provider: 'openrouter' | 'a0' | 'unknown';
    model: string | undefined;
    calls: number;
    tokens: number;
    costUsd: number;
    metered: boolean;
}
export interface BudgetSummary {
    limitUsd: number | undefined;
    spentUsd: number;
    exceeded: boolean;
    maxDurationMs: number | undefined;
    elapsedMs: number;
    maxTasks: number | undefined;
    tasks: number;
}
export interface LaneManifest {
    lane: LaneId;
    selected: boolean;
    status: LaneStatus;
    startedAt: string | undefined;
    finishedAt: string | undefined;
    reportPath: string | undefined;
    model: string | undefined;
    summary: string | undefined;
    reason: string | undefined;
    usage: UsageSummary;
    budget: BudgetSummary;
    headBinding: HeadBinding | undefined;
}
export interface RunIdentity {
    repo: string | undefined;
    pr: string | undefined;
    intendedHeadSha: string | undefined;
    checkoutSha: string | undefined;
    baseSha: string | undefined;
}
export interface RunManifest {
    schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
    runId: string;
    startedAt: string;
    finishedAt: string;
    identity: RunIdentity;
    lanes: Record<LaneId, LaneManifest>;
    aggregate: {
        status: LaneStatus;
        ok: boolean;
        costUsd: number;
        calls: number;
        tokens: number;
    };
}
/** Read the checked-out commit without making git identity a hard dependency. */
export declare function readCheckoutSha(cwd: string, exec?: ExecFn): Promise<string | undefined>;
/** Classify the relationship between API/fixture head identity and the checkout. */
export declare function classifyHeadBinding(intendedSha: string | undefined, checkoutSha: string | undefined, source: HeadSource): HeadBinding;
/** True when runtime evidence is bound to the intended head (or a fixture). */
export declare function isHeadBindingConclusive(binding: HeadBinding | undefined): boolean;
export declare function emptyUsage(provider?: UsageSummary['provider']): UsageSummary;
export declare function emptyBudget(): BudgetSummary;
export declare function emptyLane(lane: LaneId, selected: boolean): LaneManifest;
export declare function aggregateLanes(lanes: Record<LaneId, LaneManifest>): {
    status: LaneStatus;
    ok: boolean;
    costUsd: number;
    calls: number;
    tokens: number;
};
export declare function addProviderUsage(usage: UsageSummary, calls: CallCost[] | undefined): UsageSummary;
