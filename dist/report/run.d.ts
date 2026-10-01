import type { HealEvent, TdAssertRecord, TdStepRecord } from '../api.js';
import type { PageCapture } from '../driver/browser.js';
import type { ExploreStopReason } from '../engine/explore.js';
import type { CacheStats } from '../engine/loop.js';
import type { CallCost } from '../vision/cost.js';
/**
 * JSON run report consumed by the GitHub Action (R10): per-test verdicts,
 * heal events, vision-call counts, ledger totals, and artifact paths.
 */
export interface TestReport {
    name: string;
    file: string;
    ok: boolean;
    durationMs: number;
    failureMessage: string | undefined;
    steps: TdStepRecord[];
    asserts: TdAssertRecord[];
    healEvents: HealEvent[];
    visionCalls: number;
    visionCostUsd: number;
    sandboxSeconds: number;
    budgetExceeded: boolean;
    /** Per-call cost rows for model-level attribution. */
    calls: CallCost[];
    videoPath: string | undefined;
    /** Fingerprint replay/grounding counters for this test. */
    cache?: CacheStats;
    /** Agent Zero's autonomous second opinion on a failure (heal: 'a0'). */
    a0Diagnosis?: string;
    /**
     * Exploratory captures from this file's browser session (U4a):
     * console errors, page errors, and failed same-origin requests observed
     * while the tests ran. `observed` findings — never verdict-changing.
     * Present only when explore.enabled and anomalies occurred.
     */
    captures?: PageCapture[];
}
export interface RunTotals {
    tests: number;
    passed: number;
    failed: number;
    visionCalls: number;
    visionCostUsd: number;
    /** Token rollup across per-test calls AND lane-level extraCalls. */
    visionTokens: number;
    sandboxSeconds: number;
    budgetExceeded: boolean;
    /** OpenRouter spend grouped by model id. */
    costByModel: Record<string, number>;
    /** OpenRouter call count grouped by model id. */
    callsByModel: Record<string, number>;
    cacheHits: number;
    cacheMisses: number;
    cacheHeals: number;
    staleEntries: number;
    assertionHits: number;
    assertionMisses: number;
}
export interface RunReport {
    tool: 'argus-reviewer';
    startedAt: string;
    durationMs: number;
    ok: boolean;
    totals: RunTotals;
    /** Workflow-run nonce (GITHUB_RUN_ID) — freshness binding for post steps. */
    runNonce?: string;
    tests: TestReport[];
    artifacts: {
        videos: string[];
    };
    /**
     * Exploratory-lane summary (U4). Present only when `explore.enabled` —
     * the comment renders an Exploratory section for it. `skipped` carries an
     * explicit reason when the lane was on but could not observe anything
     * (e.g. the target URL was unreachable), so a silent no-op is impossible.
     * `steps`/`visited`/`stopReason`/`visionCalls`/`visionCostUsd`/`captures`
     * describe the bounded free-explore act pass (U4b) when it ran; they are
     * `observed` evidence, never verdict-changing.
     */
    explore?: {
        enabled: boolean;
        skipped?: string;
        steps?: number;
        visited?: number;
        stopReason?: ExploreStopReason;
        visionCalls?: number;
        visionCostUsd?: number;
        captures?: PageCapture[];
        /** Video of the explore session itself (also in `artifacts.videos`). */
        videoPath?: string;
    };
}
export declare function buildRunReport(tests: TestReport[], startedAt: Date, durationMs: number, 
/**
 * Model calls outside the per-test sessions (the explore act pass bills
 * its own ledger). Folded into the run totals so `run.json` spend is
 * complete even though no TestReport owns these calls.
 */
extraCalls?: CallCost[], 
/**
 * An explore lane that actually ran makes a zero-test run a legitimate
 * shape — the act pass is the evidence source for repos with no recorded
 * flows. A configured-but-skipped/errored pass is not evidence: the run
 * fails closed instead of reading a silent no-op as green.
 */
exploreEvidence?: boolean, 
/**
 * Workflow-run nonce (GITHUB_RUN_ID). The run manifests bind evidence to
 * a run via `identity.runNonce`; run.json carries the same stamp so the
 * serialized-verdict fallback in the post step is bound too.
 */
runNonce?: string): RunReport;
export declare function writeRunReport(path: string, report: RunReport): Promise<void>;
