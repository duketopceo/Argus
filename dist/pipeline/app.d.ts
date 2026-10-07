import type { AppExpectation, Config, Target } from '../config.js';
import type { BrowserDriver, PageCapture } from '../driver/browser.js';
import { TargetProcess } from '../driver/target.js';
import { type ExpectationContext } from '../engine/explore.js';
import type { VisionClient } from '../engine/loop.js';
import type { ErrorRecord } from '../journal/schema.js';
import type { Logger } from '../log.js';
import type { LaneStatus } from '../report/manifest.js';
import type { CallCost } from '../vision/cost.js';
/** Lane detail file the app runner writes and `runVerify` reads back. */
export declare const APP_LANE_REPORT = "app-lane.json";
/** Wall-clock bound when config.app.timeoutMs is unset. */
export declare const APP_LANE_DEFAULT_TIMEOUT_MS = 120000;
/**
 * Lane detail record written to `app-lane.json`. `runVerify` merges `status`,
 * `reason`, `summary`, `model`, and the call records into the manifest lane;
 * the rest is evidence for the operator surfaces (TUI, dashboard, comment).
 */
export interface AppLaneReport {
    lane: 'app';
    status: LaneStatus;
    reason: string | undefined;
    summary: string | undefined;
    task: string | undefined;
    expected: AppExpectation | undefined;
    targetUrl: string | undefined;
    finalUrl: string | undefined;
    expectedMet: boolean;
    stopReason: string | undefined;
    steps: {
        action: string;
        url: string;
        note?: string;
    }[];
    visited: number;
    anomalies: PageCapture[];
    notes: ErrorRecord[];
    artifacts: {
        video: string | undefined;
    };
    calls: CallCost[];
    visionCalls: number;
    visionCostUsd: number;
    durationMs: number;
    model: string | undefined;
}
interface ExpectationCheck {
    check: (ctx: ExpectationContext) => Promise<boolean>;
    /** Human-readable form for the lane record, e.g. `text "Done"` + url /x/. */
    describe: string;
}
/**
 * Compile the configured expected state into one AND-ed predicate. An
 * invalid url regex throws here — caught at preflight so a broken marker
 * blocks the lane instead of failing mid-run.
 */
export declare function buildExpectationCheck(expected: AppExpectation): ExpectationCheck;
interface AppLaneDeps {
    /** Browser launch — default Chromium with error-capture taps on. */
    launchDriver?: (config: Config) => Promise<BrowserDriver>;
    /** Vision client factory — lazy key resolution stays with the caller. */
    createClient?: (config: Config) => VisionClient;
    /** URL readiness probe. */
    waitForReady?: (url: string, timeoutMs: number) => Promise<void>;
    /** Target-command boot. */
    startTarget?: (spec: Target) => Promise<TargetProcess>;
    /** Consumer page-setup hook (config.pageSetup module) — trusted only. */
    applyPageSetup?: (driver: BrowserDriver) => Promise<void>;
    /** Sleep step for the keep-alive hold; injectable for tests. */
    sleep?: (ms: number) => Promise<void>;
    /** Human-facing lines during the keep-alive hold (ctx.out from the CLI). */
    note?: (line: string) => void;
    logger?: Logger;
}
export interface AppLaneInput {
    config: Config;
    /** Resolved target URL — `--url` or `config.target.url`. */
    url: string | undefined;
    /** The checkout's trust lane — gates the whole executable lane. */
    trusted: boolean;
    /** `--task` override wins over `config.app.task`. */
    task: string | undefined;
    /** Flag-level expected-state markers win over `config.app.expected`. */
    expected: AppExpectation | undefined;
    /**
     * Fully-resolved lane cap (`app.budgetUsd ?? ARGUS_BUDGET_USD ??
     * budgetUsd`) — the caller resolves precedence so the enforced Ledger
     * bound is exactly the one the manifest reports.
     */
    budgetLimitUsd?: number;
    /**
     * On a non-passed outcome with a booted target, hold the target up for
     * `ttlMs` before teardown (`--keep-alive`). The caller decides
     * interactivity; the lane just holds when asked.
     */
    keepAlive?: {
        ttlMs: number;
    };
    deps?: AppLaneDeps;
}
/**
 * Full `verify --app` lifecycle: contract preflight → trust/reachability →
 * bounded task loop → lane record. Every status path produces a report —
 * the lane can fail loudly, never silently.
 */
export declare function runAppLane(input: AppLaneInput): Promise<AppLaneReport>;
export {};
