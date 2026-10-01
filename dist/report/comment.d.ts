import type { RunManifest } from './manifest.js';
import { RunReport } from './run.js';
export declare const SENTINEL = "<!-- argus-reviewer -->";
export interface CommentOptions {
    /** Link to the workflow run or artifact index. */
    runUrl?: string;
}
/** Render the sticky PR comment markdown from a run report (or a missing-key state). */
export declare function renderComment(report: RunReport | undefined, opts?: CommentOptions & {
    missingKey?: boolean;
}): string;
/**
 * Sticky comment for a `verify` run — the manifest is the evidence contract
 * (R15). Lane names, status labels, model/cost, and head identity come from
 * the shared view-model so the comment agrees with the TUI and dashboard
 * under the contract test, not by convention.
 */
export declare function renderManifestComment(manifest: RunManifest, opts?: CommentOptions): string;
export type CheckConclusion = 'success' | 'failure' | 'neutral';
/** Map a run report (and optional missing-key flag) to a check-run conclusion. */
export declare function conclusionFromReport(report: RunReport | undefined, missingKey?: boolean): CheckConclusion;
