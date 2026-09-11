import { JOURNAL_SCHEMA_VERSION } from './schema.js';
/** Assemble the immutable run record — lives here so the schema mapping is owned by the journal module. */
export function buildJournalEntry(opts) {
    const { reports } = opts;
    const failed = reports.filter((r) => !r.ok).length;
    return {
        schemaVersion: JOURNAL_SCHEMA_VERSION,
        runId: opts.runId,
        repo: opts.repo,
        commitSha: opts.commitSha,
        branch: opts.branch,
        startedAt: opts.startedAt.toISOString(),
        durationMs: opts.durationMs,
        ok: (opts.ok ?? true) && failed === 0,
        totals: {
            tests: reports.length,
            passed: reports.length - failed,
            failed,
            visionCalls: reports.reduce((s, r) => s + r.visionCalls, 0),
            visionCostUsd: reports.reduce((s, r) => s + r.visionCostUsd, 0),
            budgetExceeded: reports.some((r) => r.budgetExceeded),
        },
        tests: reports.map((r) => ({
            name: r.name,
            file: r.file,
            ok: r.ok,
            durationMs: r.durationMs,
            ...(r.failureMessage !== undefined ? { failureMessage: r.failureMessage } : {}),
            steps: r.steps.map((s) => ({
                instruction: s.instruction,
                action: s.action,
                ok: s.ok,
                ...(s.reason !== undefined ? { reason: s.reason } : {}),
                ...(s.healed ? { healed: true } : {}),
                ...(s.model !== undefined ? { model: s.model } : {}),
            })),
            asserts: r.asserts.map((a) => ({
                question: a.question,
                verdict: a.verdict,
                reasoning: a.reasoning,
                ...(a.cached ? { cached: true } : {}),
            })),
            visionCalls: r.visionCalls,
        })),
        errors: opts.runErrors,
    };
}
