import { writeAtomicJson } from '../fsutil.js';
export function buildRunReport(tests, startedAt, durationMs, 
/**
 * Model calls outside the per-test sessions (the explore act pass bills
 * its own ledger). Folded into the run totals so `run.json` spend is
 * complete even though no TestReport owns these calls.
 */
extraCalls = [], 
/**
 * An enabled explore lane makes a zero-test run a legitimate shape — the
 * act pass is the evidence source for repos with no recorded flows, and
 * its outcome (or explicit skip reason) lands in `report.explore`, so the
 * empty suite is never a silent pass.
 */
exploreEnabled = false) {
    const failed = tests.filter((t) => !t.ok).length;
    const callsByModel = {};
    const costByModel = {};
    for (const c of [...tests.flatMap((t) => t.calls), ...extraCalls]) {
        callsByModel[c.model] = (callsByModel[c.model] ?? 0) + 1;
        costByModel[c.model] = (costByModel[c.model] ?? 0) + c.costUsd;
    }
    const extraVisionCost = extraCalls.reduce((s, c) => s + c.costUsd, 0);
    return {
        tool: 'argus-reviewer',
        startedAt: startedAt.toISOString(),
        durationMs,
        // Zero executed tests is not a pass — an empty suite produces no evidence,
        // so the report fails closed rather than letting a misconfigured testsDir
        // or a non-matching pattern read as green. An enabled explore lane is the
        // exception: its pass (or explicit skip) is the evidence.
        ok: (tests.length > 0 || exploreEnabled) && failed === 0,
        totals: {
            tests: tests.length,
            passed: tests.length - failed,
            failed,
            visionCalls: tests.reduce((sum, t) => sum + t.visionCalls, 0) + extraCalls.length,
            visionCostUsd: tests.reduce((sum, t) => sum + t.visionCostUsd, 0) + extraVisionCost,
            sandboxSeconds: tests.reduce((sum, t) => sum + t.sandboxSeconds, 0),
            budgetExceeded: tests.some((t) => t.budgetExceeded),
            callsByModel,
            costByModel,
            cacheHits: tests.reduce((sum, t) => sum + (t.cache?.hits ?? 0), 0),
            cacheMisses: tests.reduce((sum, t) => sum + (t.cache?.misses ?? 0), 0),
            cacheHeals: tests.reduce((sum, t) => sum + (t.cache?.heals ?? 0), 0),
            staleEntries: tests.reduce((sum, t) => sum + (t.cache?.staleEntries ?? 0), 0),
            assertionHits: tests.reduce((sum, t) => sum + (t.cache?.assertionHits ?? 0), 0),
            assertionMisses: tests.reduce((sum, t) => sum + (t.cache?.assertionMisses ?? 0), 0),
        },
        tests,
        artifacts: {
            videos: tests.map((t) => t.videoPath).filter((p) => p !== undefined),
        },
    };
}
export async function writeRunReport(path, report) {
    await writeAtomicJson(path, report);
}
