import { BrowserDriver as launchBrowserDriver } from '../driver/browser.js';
import { TargetProcess, holdTargetForDebug, waitForReady } from '../driver/target.js';
import { inspectInstructions } from '../driver/browser.js';
import { Actions } from '../engine/actions.js';
import { runExplore, } from '../engine/explore.js';
import { Ledger } from '../vision/ledger.js';
/** Lane detail file the app runner writes and `runVerify` reads back. */
export const APP_LANE_REPORT = 'app-lane.json';
/** Wall-clock bound when config.app.timeoutMs is unset. */
export const APP_LANE_DEFAULT_TIMEOUT_MS = 120_000;
/** Reachability preflight bound — short enough to fail fast on dead targets. */
const APP_PREFLIGHT_TIMEOUT_MS = 10_000;
/**
 * Compile the configured expected state into one AND-ed predicate. An
 * invalid url regex throws here — caught at preflight so a broken marker
 * blocks the lane instead of failing mid-run.
 */
export function buildExpectationCheck(expected) {
    const parts = [];
    if (expected.text !== undefined) {
        const needle = expected.text.toLowerCase();
        parts.push({
            describe: `text "${expected.text}"`,
            test: async (ctx) => ctx.observation.a11yYaml.toLowerCase().includes(needle),
        });
    }
    if (expected.url !== undefined) {
        const re = new RegExp(expected.url);
        parts.push({ describe: `url /${expected.url}/`, test: async (ctx) => re.test(ctx.url) });
    }
    if (expected.selector !== undefined) {
        const selector = expected.selector;
        parts.push({
            describe: `selector "${selector}"`,
            test: async (ctx) => (await ctx.page.locator(selector).count()) > 0,
        });
    }
    return {
        describe: parts.map((p) => p.describe).join(' AND '),
        check: async (ctx) => {
            for (const part of parts) {
                if (!(await part.test(ctx)))
                    return false;
            }
            return parts.length > 0;
        },
    };
}
/**
 * The bounded task loop: ExploreLoop substrate + task + expectation +
 * wall-clock deadline. The lane — not the model's `done` — decides pass:
 * the expected-state predicate is re-verified on a fresh observation after
 * the loop stops, so a page that merely loads can never pass.
 */
async function runAppTask(input) {
    const expectation = buildExpectationCheck(input.expected);
    const result = await runExplore({
        driver: input.driver,
        actions: input.actions,
        client: input.client,
        ledger: input.ledger,
        config: input.config,
        targetUrl: input.targetUrl,
        task: input.task,
        deadlineAt: Date.now() + input.timeoutMs,
        expectation: (ctx) => expectation.check(ctx),
        ...(input.maxSteps !== undefined ? { maxSteps: input.maxSteps } : {}),
        ...(input.budgetLimitUsd !== undefined ? { budgetUsd: input.budgetLimitUsd } : {}),
        ...(input.logger !== undefined ? { logger: input.logger } : {}),
    });
    // Mid-loop 'expectation' already verified on a real observation — no
    // second screenshot. Every other stop re-verifies against fresh state.
    let expectedMet = result.stopReason === 'expectation';
    let verifyError;
    if (!expectedMet) {
        try {
            const observation = await input.driver.observe({ grid: true });
            expectedMet = await expectation.check({
                observation,
                url: input.driver.rawPage.url(),
                page: input.driver.rawPage,
            });
        }
        catch (e) {
            verifyError = e.message;
        }
    }
    return { result, expectedMet, verifyError };
}
/**
 * Full `verify --app` lifecycle: contract preflight → trust/reachability →
 * bounded task loop → lane record. Every status path produces a report —
 * the lane can fail loudly, never silently.
 */
export async function runAppLane(input) {
    const started = Date.now();
    const config = input.config;
    const deps = input.deps ?? {};
    const task = input.task ?? config.app.task;
    const expected = input.expected ?? config.app.expected;
    const targetUrl = input.url ?? config.target?.url;
    const base = {
        lane: 'app',
        task,
        expected,
        targetUrl,
        finalUrl: undefined,
        expectedMet: false,
        stopReason: undefined,
        steps: [],
        visited: 0,
        anomalies: [],
        notes: [],
        artifacts: { video: undefined },
        calls: [],
        visionCalls: 0,
        visionCostUsd: 0,
        durationMs: 0,
        model: config.model,
    };
    const done = (status, reason, summary, extra) => ({
        ...base,
        ...extra,
        status,
        reason,
        summary: summary ?? (status === 'passed' ? 'task verified' : reason),
        durationMs: Date.now() - started,
    });
    // Executable lanes are gated on the same trust resolution as config
    // loading (SECURITY.md): an untrusted checkout never reaches the task,
    // the browser, or a PR-controlled expectation — blocked before any
    // preflight, not just before `target.command`.
    if (!input.trusted) {
        return done('blocked', 'verify --app is an executable lane — requires a trusted checkout');
    }
    // Contract preflight — a lane without a task or a verifiable marker
    // blocks before touching the network or the provider (R8).
    if (task === undefined || task.trim() === '') {
        return done('blocked', 'no task configured — set app.task or pass --task');
    }
    if (expected === undefined) {
        return done('blocked', 'app lane needs an expected-state marker (app.expected.text/url/selector or --expect-*) — page load alone cannot pass a task');
    }
    try {
        buildExpectationCheck(expected);
    }
    catch (e) {
        return done('blocked', `invalid expected-state marker: ${e.message}`);
    }
    if (targetUrl === undefined || targetUrl === '') {
        return done('blocked', 'no application target configured; set target.url or pass --url');
    }
    let target;
    let driver;
    /**
     * U3 keep-alive gate: on a non-passed report, hold a spawned target up for
     * the TTL; for an externally-served target nothing argus owns would die on
     * teardown, so the inspect hint alone is the hold. Called only on paths
     * where the app was actually reachable — a target that never booted or
     * never answered has no live page worth inspecting.
     */
    const maybeHold = async (report) => {
        if (input.keepAlive === undefined || report.status === 'passed')
            return report;
        const note = deps.note ?? (() => undefined);
        if (target === undefined) {
            for (const line of inspectInstructions(targetUrl))
                note(`  ${line}`);
            return report;
        }
        try {
            await holdTargetForDebug(targetUrl, input.keepAlive.ttlMs, note, {
                ...(deps.sleep !== undefined ? { sleep: deps.sleep } : {}),
            });
        }
        catch (e) {
            note(`keep-alive hold failed: ${e.message}`);
        }
        return report;
    };
    try {
        if (config.target?.command !== undefined && config.target.command !== '') {
            const start = deps.startTarget ?? ((spec) => TargetProcess.start(spec));
            try {
                target = await start(config.target);
            }
            catch (e) {
                return done('unavailable', `target command failed to boot: ${e.message}`);
            }
        }
        else {
            // No boot command — the target must already serve. Probe before any
            // model call so an unreachable app costs zero provider spend.
            const ready = deps.waitForReady ?? waitForReady;
            try {
                await ready(targetUrl, config.target?.readyTimeoutMs ?? APP_PREFLIGHT_TIMEOUT_MS);
            }
            catch (e) {
                return done('unavailable', `target unreachable before any model call: ${e.message}`);
            }
        }
        const launch = deps.launchDriver ??
            ((cfg) => 
            // The lane's evidence contract needs anomaly taps regardless of the
            // observe-only explore toggle.
            launchBrowserDriver.launch({
                browser: cfg.browser,
                browserTimeoutMs: cfg.browserTimeoutMs,
                captureErrors: true,
            }));
        try {
            driver = await launch(config);
        }
        catch (e) {
            // The spawned target is still serving — keep-alive applies: a human
            // can check the app even though argus got no browser. `return await`:
            // bare `return` lets `finally` kill the target while the hold sleeps.
            return await maybeHold(done('unavailable', `browser failed to launch: ${e.message}`));
        }
        if (deps.applyPageSetup !== undefined)
            await deps.applyPageSetup(driver);
        try {
            await driver.goto(targetUrl);
        }
        catch (e) {
            return await maybeHold(done('unavailable', `target navigation failed: ${e.message}`));
        }
        const ledger = new Ledger(input.budgetLimitUsd ?? config.app.budgetUsd ?? config.budgetUsd);
        const client = deps.createClient?.(config) ?? missingClient();
        const { result, expectedMet, verifyError } = await runAppTask({
            driver,
            actions: new Actions(driver),
            client,
            ledger,
            config,
            targetUrl,
            task,
            expected,
            timeoutMs: config.app.timeoutMs ?? APP_LANE_DEFAULT_TIMEOUT_MS,
            maxSteps: config.app.maxSteps,
            budgetLimitUsd: input.budgetLimitUsd ?? config.app.budgetUsd ?? config.budgetUsd,
            logger: deps.logger,
        });
        // Captures + video must be lifted before close() — the taps and the
        // webm path die with the context.
        const anomalies = driver.pageCaptures();
        const video = await driver.close();
        driver = undefined;
        const summary = expectedMet
            ? `expected state verified (${result.steps.length} steps, ${result.visited} page(s))`
            : `expected state unmet after ${result.stopReason} (${result.steps.length} steps)`;
        const report = done(expectedMet ? 'passed' : verifyError !== undefined ? 'inconclusive' : 'failed', expectedMet
            ? undefined
            : verifyError !== undefined
                ? `expected-state verification failed: ${verifyError}`
                : `task did not reach its expected state — stopped on ${result.stopReason}`, summary, {
            finalUrl: result.finalUrl,
            expectedMet,
            stopReason: result.stopReason,
            steps: result.steps,
            visited: result.visited,
            anomalies,
            notes: result.notes,
            artifacts: { video },
            calls: ledger.calls,
            visionCalls: result.visionCalls,
            visionCostUsd: result.visionCostUsd,
        });
        return await maybeHold(report);
    }
    finally {
        await driver?.close().catch(() => undefined);
        await target?.stop().catch(() => undefined);
    }
}
/** Default client when the caller supplies none — fails loudly on first call. */
function missingClient() {
    return {
        complete: () => Promise.reject(new Error('no vision client wired into the app lane')),
    };
}
