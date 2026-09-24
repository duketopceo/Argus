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
export function addProviderCalls(budget, calls) {
    if (calls === undefined || calls.length === 0)
        return budget;
    const spentUsd = calls.reduce((sum, call) => sum + call.costUsd, 0);
    const exceeded = budget.exceeded ||
        (budget.limitUsd !== undefined && budget.spentUsd + spentUsd > budget.limitUsd);
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
        (budget.limitUsd !== undefined && metered && budget.spentUsd > budget.limitUsd);
    return { ...budget, tasks, elapsedMs: elapsed, exceeded };
}
export function budgetCanSpend(budget, nextCostUsd) {
    return (!budget.exceeded &&
        (budget.limitUsd === undefined || budget.spentUsd + nextCostUsd <= budget.limitUsd));
}
