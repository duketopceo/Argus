import { writeAtomicJson } from '../fsutil.js';
export function buildRunReport(tests, startedAt, durationMs) {
    const failed = tests.filter((t) => !t.ok).length;
    const callsByModel = {};
    const costByModel = {};
    for (const t of tests) {
        for (const c of t.calls) {
            callsByModel[c.model] = (callsByModel[c.model] ?? 0) + 1;
            costByModel[c.model] = (costByModel[c.model] ?? 0) + c.costUsd;
        }
    }
    return {
        tool: 'argus-reviewer',
        startedAt: startedAt.toISOString(),
        durationMs,
        ok: failed === 0,
        totals: {
            tests: tests.length,
            passed: tests.length - failed,
            failed,
            visionCalls: tests.reduce((sum, t) => sum + t.visionCalls, 0),
            visionCostUsd: tests.reduce((sum, t) => sum + t.visionCostUsd, 0),
            sandboxSeconds: tests.reduce((sum, t) => sum + t.sandboxSeconds, 0),
            budgetExceeded: tests.some((t) => t.budgetExceeded),
            callsByModel,
            costByModel,
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
