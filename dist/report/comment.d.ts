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
 * Reference renderer for a `verify` sticky comment — NOT wired into the
 * action (`action/sticky-comment.cjs` is self-contained CJS and ships the
 * live renderer). This exists so the cross-surface parity test can compare
 * the TS and CJS renderers over the same manifest; keep it honest or the
 * parity suite guards nothing.
 *
 * Lane names, status labels, model/cost, and head identity come from
 * the shared view-model so the comment agrees with the TUI and dashboard
 * under the contract test, not by convention.
 */
export declare function renderManifestComment(manifest: RunManifest, opts?: CommentOptions): string;
export type CheckConclusion = 'success' | 'failure' | 'neutral';
/** Map a run report (and optional missing-key flag) to a check-run conclusion. */
export declare function conclusionFromReport(report: RunReport | undefined, missingKey?: boolean): CheckConclusion;
