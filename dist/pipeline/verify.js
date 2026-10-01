import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { aggregateLanes, addProviderUsage, emptyLane, emptyUsage, isHeadBindingConclusive, LANE_IDS, LANE_STATUSES, MANIFEST_SCHEMA_VERSION, } from '../report/manifest.js';
import { addProviderCalls, createBudget, overLimit, } from './budget.js';
async function readJson(path) {
    try {
        return JSON.parse(await readFile(path, 'utf8'));
    }
    catch {
        return undefined;
    }
}
function relativeReport(cwd, reportDir, name) {
    return relative(cwd, join(reportDir, name)) || name;
}
function laneStart(lane, at = new Date()) {
    return { ...lane, startedAt: at.toISOString() };
}
function laneEnd(lane, at = new Date()) {
    return { ...lane, finishedAt: at.toISOString() };
}
function reportStatus(code, report, inconclusive) {
    if (report?.skipped === true)
        return 'skipped';
    if (inconclusive)
        return 'inconclusive';
    if (report?.ok === true && code === 0)
        return 'passed';
    return 'failed';
}
function providerUsageFromCalls(calls) {
    const usage = emptyUsage('openrouter');
    return calls === undefined ? usage : addProviderUsage(usage, calls);
}
function flowCalls(report) {
    return report?.tests?.flatMap((test) => test.calls ?? []) ?? [];
}
function flowUsage(report) {
    const calls = flowCalls(report);
    const usage = providerUsageFromCalls(calls);
    const totals = report?.totals;
    if (totals === undefined)
        return usage;
    // totals are the authoritative rollup — they fold in lane-level calls the
    // per-test reports never own (e.g. the explore pass). Per-call records
    // still supply tokens and the model tag, which totals don't carry.
    return {
        ...usage,
        calls: totals.visionCalls ?? usage.calls,
        costUsd: totals.visionCostUsd ?? usage.costUsd,
    };
}
function flowCache(report) {
    const totals = report?.totals;
    if (totals === undefined)
        return undefined;
    return {
        hits: totals.cacheHits ?? 0,
        misses: totals.cacheMisses ?? 0,
        heals: totals.cacheHeals ?? 0,
        staleEntries: totals.staleEntries ?? 0,
        assertionHits: totals.assertionHits ?? 0,
        assertionMisses: totals.assertionMisses ?? 0,
    };
}
/** A green `ok` is only evidence when a test executed or the explore lane
 * ran as the evidence source (its pass or explicit skip is recorded). */
function flowEvidenceRan(report) {
    if (report === undefined)
        return false;
    if (report.explore?.enabled === true)
        return true;
    return (report.totals?.tests ?? report.tests?.length ?? 0) > 0;
}
function budgetFor(lane, input, report) {
    const options = input.budgets?.[lane] ?? {};
    let budget = createBudget(lane, options);
    if (lane === 'review') {
        budget = addProviderCalls(budget, report?.calls);
    }
    else if (lane === 'flow') {
        const flowReport = report;
        budget = addProviderCalls(budget, flowCalls(flowReport));
        // totals fold in lane-level calls the per-test reports never own (the
        // explore pass) — the budget must count the same spend usage reports.
        const totalUsd = flowReport?.totals?.visionCostUsd;
        if (totalUsd !== undefined && totalUsd > budget.spentUsd) {
            budget = {
                ...budget,
                spentUsd: totalUsd,
                exceeded: budget.exceeded ||
                    (budget.limitUsd !== undefined && overLimit(totalUsd, budget.limitUsd)),
            };
        }
    }
    return budget;
}
function baseLane(lane, selected) {
    return emptyLane(lane, selected);
}
/**
 * Usage from a runner's lane-detail file. Per-call records are authoritative
 * for tokens/model; `visionCalls`/`visionCostUsd` scalars cover runners that
 * only know totals. An `a0` host without usage telemetry reports
 * `metered: false` — never a fabricated dollar amount (R13).
 */
function laneDetailUsage(lane, detail) {
    const provider = lane === 'a0' ? 'a0' : 'openrouter';
    const base = addProviderUsage(emptyUsage(provider), detail?.calls);
    return {
        ...base,
        provider,
        model: detail?.model ?? base.model,
        calls: detail?.calls === undefined ? (detail?.visionCalls ?? base.calls) : base.calls,
        costUsd: detail?.calls === undefined ? (detail?.visionCostUsd ?? base.costUsd) : base.costUsd,
        metered: lane === 'a0' ? detail?.metered === true : base.metered,
    };
}
/**
 * Lane budget from options plus what the runner's detail actually consumed —
 * provider calls, delegated tasks, and elapsed wall-clock each count against
 * their configured bound.
 */
function laneDetailBudget(lane, input, detail) {
    let budget = addProviderCalls(createBudget(lane, input.budgets?.[lane] ?? {}), detail?.calls);
    const tasks = detail?.tasks ?? 0;
    const elapsedMs = detail?.durationMs ?? 0;
    const exceeded = budget.exceeded ||
        (budget.maxTasks !== undefined && tasks > budget.maxTasks) ||
        (budget.maxDurationMs !== undefined && elapsedMs > budget.maxDurationMs) ||
        (budget.limitUsd !== undefined &&
            detail?.calls === undefined &&
            detail?.visionCostUsd !== undefined &&
            overLimit(detail.visionCostUsd, budget.limitUsd));
    budget = { ...budget, tasks, elapsedMs, exceeded };
    return budget;
}
/**
 * Run selected lanes and return one stable manifest without owning
 * subprocesses. Lanes run sequentially on purpose: flow/app can both boot
 * `target.command` (port collision) and serial execution keeps budget
 * accounting and lane timing honest — each lane's startedAt is its own
 * start, not the run's.
 */
export async function runVerify(input) {
    const startedAt = new Date();
    const lanes = Object.fromEntries(LANE_IDS.map((lane) => [lane, baseLane(lane, input.selection[lane])]));
    const reviewSelected = input.selection.review;
    if (reviewSelected) {
        lanes.review = laneStart(lanes.review);
        let code = 1;
        let runnerError;
        try {
            code = await input.runners.review();
        }
        catch (error) {
            runnerError = error instanceof Error ? error.message : String(error);
            ctxError(runnerError);
        }
        const report = await readJson(join(input.reportDir, 'code-review.json'));
        const inconclusive = report !== undefined &&
            report.skipped !== true &&
            !isHeadBindingConclusive(report.headBinding);
        const status = runnerError !== undefined ? 'failed' : reportStatus(code, report, inconclusive);
        lanes.review = laneEnd({
            ...lanes.review,
            status,
            reportPath: report === undefined
                ? undefined
                : relativeReport(input.cwd, input.reportDir, 'code-review.json'),
            model: report?.model,
            summary: report?.summary,
            reason: runnerError ??
                (report === undefined
                    ? 'code-review.json was not produced'
                    : status === 'passed'
                        ? undefined
                        : report.summary),
            usage: providerUsageFromCalls(report?.calls),
            budget: budgetFor('review', input, report),
            headBinding: report?.headBinding,
        });
    }
    if (input.selection.flow) {
        lanes.flow = laneStart(lanes.flow);
        if (input.runners.flow === undefined) {
            lanes.flow = laneEnd({
                ...lanes.flow,
                status: 'unavailable',
                reason: 'flow runner is not available in this build',
            });
        }
        else if (input.flowUrl === undefined || input.flowUrl === '') {
            lanes.flow = laneEnd({
                ...lanes.flow,
                status: 'blocked',
                reason: input.flowUnavailableReason ?? 'no application target configured',
            });
        }
        else {
            let code = 1;
            let runnerError;
            try {
                code = await input.runners.flow(input.flowUrl);
            }
            catch (error) {
                runnerError = error instanceof Error ? error.message : String(error);
                ctxError(runnerError);
            }
            const report = await readJson(join(input.reportDir, 'run.json'));
            // A run.json claiming ok with zero executed tests carries no evidence —
            // fail closed instead of letting it pass the lane.
            const noEvidence = report !== undefined && report.ok === true && code === 0 && !flowEvidenceRan(report);
            lanes.flow = laneEnd({
                ...lanes.flow,
                status: runnerError !== undefined || noEvidence
                    ? 'failed'
                    : reportStatus(code, report, false),
                reportPath: report === undefined ? undefined : relativeReport(input.cwd, input.reportDir, 'run.json'),
                summary: report === undefined
                    ? undefined
                    : noEvidence
                        ? 'flow ran zero tests'
                        : report.ok === true
                            ? 'flow passed'
                            : 'flow failed',
                reason: runnerError ??
                    (noEvidence
                        ? 'run.json reports ok but executed zero tests'
                        : report === undefined
                            ? 'run.json was not produced'
                            : report.ok === true
                                ? undefined
                                : 'flow failed'),
                usage: flowUsage(report),
                budget: budgetFor('flow', input, report),
                cache: flowCache(report),
            });
        }
    }
    for (const lane of ['app', 'a0']) {
        if (!input.selection[lane])
            continue;
        const runner = input.runners[lane];
        lanes[lane] = laneStart(lanes[lane]);
        if (runner === undefined) {
            lanes[lane] = laneEnd({
                ...lanes[lane],
                status: 'unavailable',
                reason: `${lane} runner is not available in this build`,
            });
            continue;
        }
        let code = 1;
        let runnerError;
        try {
            code = await runner();
        }
        catch (error) {
            runnerError = error instanceof Error ? error.message : String(error);
            ctxError(runnerError);
        }
        // Runners write their own lane detail (`<lane>-lane.json`); a valid
        // status there wins over the exit-code mapping, so preflight outcomes
        // (blocked/unavailable/inconclusive) reach the manifest faithfully.
        const detail = await readJson(join(input.reportDir, `${lane}-lane.json`));
        const detailStatus = detail?.status !== undefined && LANE_STATUSES.includes(detail.status)
            ? detail.status
            : undefined;
        const status = runnerError !== undefined
            ? 'failed'
            : (detailStatus ?? (code === 0 ? 'passed' : 'failed'));
        const usage = laneDetailUsage(lane, detail);
        lanes[lane] = laneEnd({
            ...lanes[lane],
            status,
            reportPath: detail === undefined
                ? undefined
                : relativeReport(input.cwd, input.reportDir, `${lane}-lane.json`),
            model: detail?.model,
            summary: detail?.summary,
            reason: runnerError ??
                detail?.reason ??
                (code === 0 ? undefined : `${lane} runner exited ${code}`),
            usage,
            budget: laneDetailBudget(lane, input, detail),
        });
    }
    const aggregate = aggregateLanes(lanes);
    const manifest = {
        schemaVersion: MANIFEST_SCHEMA_VERSION,
        runId: input.runId,
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        identity: input.identity,
        lanes,
        aggregate,
    };
    return { manifest, exitCode: aggregate.ok ? 0 : 1 };
}
function ctxError(message) {
    console.error(`verify lane error: ${message}`);
}
