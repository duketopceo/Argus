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
/** Status glyph per lane status; no two statuses share one. */
export declare const STATUS_GLYPH: Record<LaneStatus, string>;
/** Proof strength, weakest to strongest (A4 ladder). */
export declare const PROOF_LEVELS: readonly ["suspected", "corroborated", "exercised", "reproduced"];
export type ProofLevel = (typeof PROOF_LEVELS)[number];
/**
 * Four-notch meter: one filled notch per ladder step reached. Any other
 * value (an evidence status outside the ladder, a missing level) is the
 * empty meter, so a renderer never throws on unexpected input.
 */
export declare function proofMeter(level: string | undefined): string;
/** Finding severities as the review pipeline emits them (`q` is a question). */
export declare const SEVERITIES: readonly ["bug", "risk", "nit", "q"];
export type Severity = (typeof SEVERITIES)[number];
/** Geometric, shape-only severity glyphs (A5). */
export declare const SEVERITY_GLYPH: Record<Severity, string>;
export declare const SEVERITY_LABEL: Record<Severity, string>;
/** Review verdicts as the synthesis step emits them. */
export declare const VERDICTS: readonly ["approve", "needs_changes", "pass"];
export type Verdict = (typeof VERDICTS)[number];
/** Verdicts reuse status glyphs, so there is no third vocabulary. */
export declare const VERDICT_STATUS: Record<Verdict, LaneStatus>;
export declare const VERDICT_LABEL: Record<Verdict, string>;
export declare function verdictGlyph(verdict: Verdict): string;
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
