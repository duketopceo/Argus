import { type BudgetSummary, type CacheSummary, type HeadBinding, type LaneId, type LaneManifest, type LaneStatus, type RunManifest, type UsageSummary } from './manifest.js';
/**
 * Manifest → view model. One contract for the three evidence surfaces —
 * sticky PR comment, TUI, and Electron dashboard — so lane names, status
 * labels, model/cost fields, and head identity agree by construction, not
 * by convention (R15, AE-C).
 *
 * Everything here is a pure function over an already-parsed RunManifest:
 * no fs, no fetch — the collector owns reading, this owns shaping.
 */
/** One display label per status — surfaces may color it, never rename it. */
export declare const LANE_STATUS_LABEL: Record<LaneStatus, string>;
/** One glyph per status — terminal/comment-safe, color-independent. */
export declare const LANE_STATUS_ICON: Record<LaneStatus, string>;
/** Comment-flavored emoji per status — same ordering contract as the glyph. */
export declare const LANE_STATUS_EMOJI: Record<LaneStatus, string>;
export interface LaneView {
    lane: LaneId;
    selected: boolean;
    status: LaneStatus;
    statusLabel: string;
    statusIcon: string;
    summary: string | undefined;
    reason: string | undefined;
    reportPath: string | undefined;
    model: string | undefined;
    usage: UsageSummary;
    budget: BudgetSummary;
    cache: CacheSummary | undefined;
    headBinding: HeadBinding | undefined;
    startedAt: string | undefined;
    finishedAt: string | undefined;
    durationMs: number | undefined;
}
export interface RunView {
    runId: string;
    schemaVersion: number;
    startedAt: string;
    finishedAt: string;
    status: LaneStatus;
    statusLabel: string;
    statusIcon: string;
    ok: boolean;
    costUsd: number;
    calls: number;
    tokens: number;
    repo: string | undefined;
    pr: string | undefined;
    intendedHeadSha: string | undefined;
    checkoutSha: string | undefined;
    /** Review lane's head binding — the run-level binding contract. */
    headBinding: HeadBinding | undefined;
    /** All lanes in LANE_IDS order — selection state included. */
    lanes: LaneView[];
    /** Only the lanes that ran or were asked to — the matrix surfaces show. */
    selectedLanes: LaneView[];
}
export declare function laneView(lane: LaneManifest): LaneView;
export declare function manifestToRunView(manifest: RunManifest): RunView;
/** Structural validation — a manifest the view-model can trust enough to render. */
export declare function isRunManifest(value: unknown): value is RunManifest;
export declare function maskSecrets(s: string): string;
export declare function formatUsd(n: number | undefined): string;
export declare function formatDuration(ms: number | undefined): string;
export declare function shortSha(sha: string | undefined): string | undefined;
