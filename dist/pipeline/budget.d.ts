import type { CallCost } from '../vision/cost.js';
import type { BudgetSummary, LaneId } from '../report/manifest.js';
export interface BudgetOptions {
    limitUsd?: number;
    maxDurationMs?: number;
    maxTasks?: number;
}
export declare function createBudget(lane: LaneId, options?: BudgetOptions): BudgetSummary;
export declare function addProviderCalls(budget: BudgetSummary, calls: CallCost[] | undefined): BudgetSummary;
export declare function addA0Task(budget: BudgetSummary, elapsedMs: number, metered: boolean): BudgetSummary;
export declare function budgetCanSpend(budget: BudgetSummary, nextCostUsd: number): boolean;
