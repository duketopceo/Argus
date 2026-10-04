import type { CallCost } from '../vision/cost.js';
import type { BudgetSummary, LaneId } from '../report/manifest.js';
export interface BudgetOptions {
    limitUsd?: number;
    maxDurationMs?: number;
    maxTasks?: number;
}
export declare function createBudget(lane: LaneId, options?: BudgetOptions): BudgetSummary;
export declare function overLimit(spentUsd: number, limitUsd: number): boolean;
export declare function addProviderCalls(budget: BudgetSummary, calls: CallCost[] | undefined): BudgetSummary;
export declare function addA0Task(budget: BudgetSummary, elapsedMs: number, metered: boolean): BudgetSummary;
export declare function budgetCanSpend(budget: BudgetSummary, nextCostUsd: number): boolean;
export declare function estimateRequestCostUsd(req: {
    messages: unknown;
    schema?: unknown;
}): number;
/**
 * How many leading requests of a batch fit in the remaining budget. A batch
 * cannot be cancelled once submitted, so the guard sizes it up front.
 * `limitUsd` undefined = unlimited.
 */
export declare function affordableBatchPrefix(requests: ReadonlyArray<{
    messages: unknown;
    schema?: unknown;
}>, limitUsd: number | undefined, spentUsd: number): number;
