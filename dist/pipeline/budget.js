export function createBudget(lane, options = {}) {
    void lane;
    return {
        limitUsd: options.limitUsd,
        spentUsd: 0,
        exceeded: false,
        maxDurationMs: options.maxDurationMs,
        elapsedMs: 0,
        maxTasks: options.maxTasks,
        tasks: 0,
    };
}
/**
 * USD spend is summed as IEEE-754 doubles, so a lane that lands exactly on its
 * cap (0.1 + 0.2 === 0.30000000000000004, not 0.3) would otherwise read as over
 * budget and abort a run that never exceeded the cap. Compare with a tolerance
 * far below the 1e-6 precision reports render, and far above double noise here.
 */
const USD_EPSILON = 1e-9;
function overLimit(spentUsd, limitUsd) {
    return spentUsd > limitUsd + USD_EPSILON;
}
export function addProviderCalls(budget, calls) {
    if (calls === undefined || calls.length === 0)
        return budget;
    const spentUsd = calls.reduce((sum, call) => sum + call.costUsd, 0);
    const exceeded = budget.exceeded ||
        (budget.limitUsd !== undefined && overLimit(budget.spentUsd + spentUsd, budget.limitUsd));
    return {
        ...budget,
        spentUsd: budget.spentUsd + spentUsd,
        exceeded,
    };
}
export function addA0Task(budget, elapsedMs, metered) {
    const tasks = budget.tasks + 1;
    const elapsed = budget.elapsedMs + elapsedMs;
    const exceeded = budget.exceeded ||
        (budget.maxTasks !== undefined && tasks > budget.maxTasks) ||
        (budget.maxDurationMs !== undefined && elapsed > budget.maxDurationMs) ||
        (budget.limitUsd !== undefined && metered && overLimit(budget.spentUsd, budget.limitUsd));
    return { ...budget, tasks, elapsedMs: elapsed, exceeded };
}
export function budgetCanSpend(budget, nextCostUsd) {
    return (!budget.exceeded &&
        (budget.limitUsd === undefined ||
            budget.spentUsd + nextCostUsd <= budget.limitUsd + USD_EPSILON));
}
