import { parseBudgetSetting, applyBudgetSetting, UNCAPPED_WARNING, sanitizeExpectation } from '../config.js';
import { A0_LANE_MAX_TASKS, A0_DEFAULT_TIMEOUT_MS, runA0Lane, A0_LANE_REPORT } from '../executor/a0.js';
import { writeAtomicJson } from '../fsutil.js';
import { newRunId } from '../journal/store.js';
import { createLogger, resolveLogLevel } from '../log.js';
import { APP_LANE_DEFAULT_TIMEOUT_MS, runAppLane, APP_LANE_REPORT } from '../pipeline/app.js';
import { selectionFromFlags } from '../pipeline/contracts.js';
import { runVerify, writeEvidenceReport } from '../pipeline/verify.js';
import { REPORT_HTML } from '../report/html.js';
import { LANE_IDS, archiveManifest } from '../report/manifest.js';
import { renderSummary, verifySummary } from '../ui/summary.js';
import { cmdCodeReview } from './code-review.js';
import { applyPageSetup } from './record.js';
import { displayPath } from './review-shared.js';
import { cmdRun } from './run.js';
import { parseKeepAliveTtl, usageError, keepAliveInteractive, KEEP_ALIVE_DEFAULT_TTL_MS, resolveCheckoutTrust, loadCliConfig, envOr, parseOpenRouterTrace, gitInfo, runNonceFrom, createClient } from './shared.js';
import { mkdir, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
export async function cmdVerify(args, ctx, deps) {
    const { values } = parseArgs({
        args,
        allowPositionals: false,
        options: {
            help: { type: 'boolean', short: 'h', default: false },
            review: { type: 'boolean', default: true },
            'no-review': { type: 'boolean' },
            // No defaults on the opt-in lanes: `--flow`/`--no-flow` must both be
            // distinguishable from "flag absent" so an explicit negation vetoes an
            // ambient ARGUS_VERIFY_*=1. parseArgs doesn't auto-derive negations —
            // the no-* spellings are declared explicitly.
            flow: { type: 'boolean' },
            'no-flow': { type: 'boolean' },
            app: { type: 'boolean' },
            'no-app': { type: 'boolean' },
            a0: { type: 'boolean' },
            'no-a0': { type: 'boolean' },
            url: { type: 'string' },
            task: { type: 'string' },
            'expect-text': { type: 'string' },
            'expect-url': { type: 'string' },
            'expect-selector': { type: 'string' },
            'report-dir': { type: 'string' },
            'keep-alive': { type: 'boolean', default: false },
            'keep-alive-ttl': { type: 'string' },
        },
    });
    if (values.help) {
        ctx.out('Usage: argus-reviewer verify [--review|--no-review] [--flow|--no-flow] ' +
            '[--app|--no-app] [--a0|--no-a0] ' +
            '[--url <target>] ' +
            '[--task "<task>" --expect-text <marker>|--expect-url <re>|--expect-selector <sel>] ' +
            '[--keep-alive [--keep-alive-ttl <sec>]] [--report-dir <dir>]\n\n' +
            "Runs the selected product lanes and writes run-manifest.json. Code review is selected by default; deeper lanes are explicit. --no-* vetoes the ARGUS_VERIFY_* env inputs. --keep-alive holds a failed run's target up for inspection (interactive only).");
        return 0;
    }
    const verifyKeepAliveTtl = parseKeepAliveTtl(values['keep-alive-ttl']);
    if (values['keep-alive-ttl'] !== undefined && verifyKeepAliveTtl === undefined) {
        usageError(ctx, 'verify', `--keep-alive-ttl must be a positive integer of seconds, got "${values['keep-alive-ttl']}"`);
        return 2;
    }
    // Keep-alive is an interactive-only debug affordance: a CI or headless
    // run has nobody to attach, so each failed lane prints a skip line and
    // teardown proceeds normally. The flow lane re-checks this inside cmdRun;
    // the app lane holds whenever it receives keepAlive, so only the
    // interactive case is passed down.
    const keepAliveRequested = values['keep-alive'] === true || verifyKeepAliveTtl !== undefined;
    const verifyKeepAlive = keepAliveRequested && keepAliveInteractive(ctx)
        ? { ttlMs: verifyKeepAliveTtl ?? KEEP_ALIVE_DEFAULT_TTL_MS }
        : undefined;
    // Flag > env > config for lane booleans: `--no-app`/`--no-a0`/`--no-flow`
    // are explicit opt-outs that must beat an ambient ARGUS_VERIFY_*=1.
    const selection = selectionFromFlags({
        review: values['no-review'] === true ? false : values.review,
        flow: values['no-flow'] === true ? false : (values.flow ?? ctx.env.ARGUS_VERIFY_FLOW === '1'),
        app: values['no-app'] === true ? false : (values.app ?? ctx.env.ARGUS_VERIFY_APP === '1'),
        a0: values['no-a0'] === true ? false : (values.a0 ?? ctx.env.ARGUS_VERIFY_A0 === '1'),
    });
    // All lanes explicitly off is a real selection — every lane reports
    // skipped, the manifest records it, and the run fails closed. Silently
    // re-adding review here would negate `--no-review`.
    // Wipe run-scoped evidence files BEFORE config resolution: a committed or
    // leftover run-manifest.json/run.json/lane detail must never outlive the
    // run that produced it — and a config parse that throws here must still
    // leave the planted file gone, or the post step's commit status would
    // render stale (or deliberately forged) evidence as this head's verdict.
    // The flag/env/default resolution mirrors the post step's; a custom
    // config.reportDir gets the same wipe once the config loads.
    const wipeEvidence = async (dir) => {
        await mkdir(dir, { recursive: true }).catch(() => { });
        for (const stale of [
            'run-manifest.json',
            'run.json',
            'code-review.json',
            'junit.xml',
            REPORT_HTML,
        ]) {
            await rm(join(dir, stale), { force: true }).catch(() => { });
        }
        for (const lane of LANE_IDS) {
            await rm(join(dir, `${lane}-lane.json`), { force: true }).catch(() => { });
        }
    };
    const preConfigDir = resolve(ctx.cwd, values['report-dir'] ?? ctx.env.ARGUS_REPORT_DIR ?? 'argus-reviewer-report');
    await wipeEvidence(preConfigDir);
    const { trust } = await resolveCheckoutTrust(ctx);
    const config = await loadCliConfig(ctx, trust);
    const reportDir = resolve(ctx.cwd, values['report-dir'] ?? config.reportDir ?? 'argus-reviewer-report');
    await mkdir(reportDir, { recursive: true });
    if (reportDir !== preConfigDir)
        await wipeEvidence(reportDir);
    // ARGUS_VERIFY_* envs are the action's input bridge — flags win, then
    // env, then config, so a workflow needs no committed CLI invocation.
    // Action inputs default to '', which must not shadow the config — and an
    // explicit '' flag normalizes the same way (an empty task/expect marker
    // can never vacuously satisfy the lane contract).
    const flowUrl = envOr(values.url) ?? envOr(ctx.env.ARGUS_VERIFY_URL) ?? config.target?.url;
    const verifyTask = envOr(values.task) ?? envOr(ctx.env.ARGUS_VERIFY_TASK);
    const trace = parseOpenRouterTrace(ctx.env);
    const git = await gitInfo(ctx.cwd);
    const envBudget = envOr(ctx.env.ARGUS_BUDGET_USD);
    const envSetting = parseBudgetSetting(envBudget);
    if (envSetting.kind === 'invalid') {
        ctx.err(`warning: ignoring invalid ARGUS_BUDGET_USD="${envBudget}"`);
    }
    // 'keep' → fall back to config; otherwise the env value (undefined = unlimited)
    const appliedBudget = applyBudgetSetting(envSetting);
    const hasEnvBudget = appliedBudget !== 'keep';
    const envCap = appliedBudget === 'keep' ? undefined : appliedBudget;
    const budgets = {};
    const reviewBudget = hasEnvBudget ? envCap : config.codeReviewBudgetUsd;
    const flowBudget = hasEnvBudget ? envCap : config.budgetUsd;
    if (reviewBudget !== undefined)
        budgets.review = { limitUsd: reviewBudget };
    if (flowBudget !== undefined)
        budgets.flow = { limitUsd: flowBudget };
    const appBudget = config.app.budgetUsd ?? (hasEnvBudget ? envCap : config.budgetUsd);
    if (selection.app && appBudget === undefined)
        ctx.err(UNCAPPED_WARNING);
    budgets.app = {
        ...(appBudget !== undefined ? { limitUsd: appBudget } : {}),
        maxDurationMs: config.app.timeoutMs ?? APP_LANE_DEFAULT_TIMEOUT_MS,
    };
    budgets.a0 = {
        maxTasks: config.a0?.maxTasks ?? A0_LANE_MAX_TASKS,
        maxDurationMs: config.a0?.timeoutMs ?? A0_DEFAULT_TIMEOUT_MS,
    };
    // Flag-level expected-state markers compose into the task contract —
    // they win over config.app.expected so a one-shot verify needs no file.
    // sanitizeExpectation drops '' markers — an empty --expect-text would
    // otherwise compile to an always-true check and pass vacuously.
    const flagExpected = sanitizeExpectation({
        text: envOr(values['expect-text']) ?? envOr(ctx.env.ARGUS_VERIFY_EXPECT_TEXT),
        url: envOr(values['expect-url']) ?? envOr(ctx.env.ARGUS_VERIFY_EXPECT_URL),
        selector: envOr(values['expect-selector']) ?? envOr(ctx.env.ARGUS_VERIFY_EXPECT_SELECTOR),
    });
    const logger = createLogger(resolveLogLevel(ctx.env, config.logLevel), ctx, undefined, ctx.style);
    const runNonce = runNonceFrom(ctx.env);
    // Lane commands run nested: verify prints the one summary block at the end.
    const laneCtx = { ...ctx, nested: true };
    const result = await runVerify({
        cwd: ctx.cwd,
        runId: newRunId(),
        reportDir,
        identity: {
            repo: trace?.repo ?? git.repo,
            pr: trace?.pr,
            intendedHeadSha: trace?.commit,
            checkoutSha: git.commitSha,
            baseSha: undefined,
            runNonce,
        },
        selection,
        ...(flowUrl !== undefined ? { flowUrl } : {}),
        flowUnavailableReason: 'no application target configured; set target.url or pass --url',
        budgets,
        runners: {
            review: async () => cmdCodeReview(['--report-dir', reportDir], laneCtx, deps),
            flow: async (url) => cmdRun([
                '--url',
                url,
                '--report-dir',
                reportDir,
                // The flag rides down whenever requested; cmdRun's own gate
                // prints the non-interactive skip line on failure.
                ...(keepAliveRequested
                    ? [
                        '--keep-alive',
                        '--keep-alive-ttl',
                        String(Math.round((verifyKeepAliveTtl ?? KEEP_ALIVE_DEFAULT_TTL_MS) / 1000)),
                    ]
                    : []),
            ], laneCtx, deps),
            app: async () => {
                // The lane writes its own detail record — every status path
                // (blocked/unavailable/inconclusive/failed/passed) lands in the
                // manifest, none silently no-ops.
                const report = await runAppLane({
                    config,
                    trusted: trust === 'trusted',
                    url: flowUrl,
                    task: verifyTask,
                    expected: flagExpected,
                    // The lane enforces the same cap the manifest reports —
                    // app.budgetUsd ?? ARGUS_BUDGET_USD ?? budgetUsd.
                    ...(appBudget !== undefined ? { budgetLimitUsd: appBudget } : {}),
                    ...(verifyKeepAlive !== undefined ? { keepAlive: verifyKeepAlive } : {}),
                    deps: {
                        ...(deps.launchDriver !== undefined ? { launchDriver: deps.launchDriver } : {}),
                        createClient: (cfg) => createClient(deps, cfg, ctx),
                        applyPageSetup: async (driver) => {
                            // The transpile scratch dir exists only while a pageSetup
                            // module is imported — no leaked argus-verify-* dirs on
                            // review-only runs.
                            if (config.pageSetup === undefined || config.pageSetup === '')
                                return;
                            const verifyTmp = await mkdtemp(join(tmpdir(), 'argus-verify-'));
                            try {
                                await applyPageSetup(config, driver, ctx, verifyTmp);
                            }
                            finally {
                                await rm(verifyTmp, { recursive: true, force: true });
                            }
                        },
                        note: ctx.out,
                        ...(deps.sleep !== undefined ? { sleep: deps.sleep } : {}),
                        logger,
                    },
                });
                await writeAtomicJson(join(reportDir, APP_LANE_REPORT), report);
                if (report.status !== 'passed' && keepAliveRequested && !keepAliveInteractive(ctx)) {
                    ctx.out('keep-alive: skipped (non-interactive or CI run)');
                }
                ctx.out(`app lane: ${report.status}: ${report.summary ?? report.reason ?? 'no detail'}` +
                    (report.visionCalls > 0
                        ? ` (${report.visionCalls} call(s), $${report.visionCostUsd.toFixed(6)})`
                        : ''));
                return report.status === 'passed' ? 0 : 1;
            },
            a0: async () => {
                // Explicit-selection escalation lane: sanitized payload, allowlisted
                // child env, honest statuses — never a `passed` while #53 is open.
                const report = await runA0Lane({
                    a0: config.a0,
                    env: ctx.env,
                    trusted: trust === 'trusted',
                    targetUrl: flowUrl,
                    intendedHeadSha: trace?.commit ?? git.commitSha,
                    task: verifyTask ?? config.app.task,
                    deps: {
                        ...(deps.exec !== undefined ? { exec: deps.exec } : {}),
                        ...(deps.probe !== undefined ? { probe: deps.probe } : {}),
                        note: ctx.out,
                    },
                });
                await writeAtomicJson(join(reportDir, A0_LANE_REPORT), report);
                ctx.out(`a0 lane: ${report.status}: ${report.summary ?? report.reason ?? 'no detail'}`);
                return report.status === 'passed' ? 0 : 1;
            },
        },
    });
    const reviewBinding = result.manifest.lanes.review.headBinding;
    if (reviewBinding?.intendedSha !== undefined) {
        result.manifest.identity.intendedHeadSha = reviewBinding.intendedSha;
    }
    const manifestPath = join(reportDir, 'run-manifest.json');
    await writeAtomicJson(manifestPath, result.manifest);
    // U14: the offline HTML evidence report beside the manifest. A render
    // failure must not change the verdict the manifest already carries.
    try {
        const server = envOr(ctx.env.GITHUB_SERVER_URL);
        const repository = envOr(ctx.env.GITHUB_REPOSITORY);
        const runId = envOr(ctx.env.GITHUB_RUN_ID);
        await writeEvidenceReport(reportDir, result.manifest, {
            ...(server !== undefined && repository !== undefined && runId !== undefined
                ? { runUrl: `${server}/${repository}/actions/runs/${runId}` }
                : {}),
        });
    }
    catch (e) {
        ctx.err(`warning: evidence report failed: ${e.message}`);
    }
    // Local run history for the dashboard/TUI workspace — bounded by
    // reportRetention (default 20; 0 disables archival).
    try {
        await archiveManifest(reportDir, result.manifest, config.reportRetention ?? 20);
    }
    catch (e) {
        ctx.err(`warning: verify manifest archive failed: ${e.message}`);
    }
    // R13: one summary block in the comment's grammar.
    const summary = renderSummary(verifySummary(result.manifest, displayPath(ctx, manifestPath)), ctx.style, ctx.width);
    for (const line of summary)
        ctx.out(line);
    return result.exitCode;
}
