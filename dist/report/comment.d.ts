import type { LaneId, LaneStatus, RunManifest } from './manifest.js';
import { RunReport } from './run.js';
import { type LaneView, type ProofLevel } from './viewmodel.js';
export declare const SENTINEL = "<!-- argus-reviewer -->";
/**
 * Reference renderer for the sticky PR comment (plan U4, R6). NOT wired into
 * the action: `action/sticky-comment.cjs` is self-contained CJS and ships the
 * live renderer. This file renders the same grammar from the shared
 * view-model so the golden suite (tests/unit/comment-golden.test.ts) can pin
 * the two against each other: header, verdict line, lane table and findings
 * summary for every body, and the whole manifest-only and missing-key bodies.
 * Keep it honest or the parity suite guards nothing.
 */
export interface CommentMeta {
    /** Argus version shown in the footer. */
    version: string;
    /** Link to the workflow run page (evidence and artifacts). */
    runUrl?: string;
    /**
     * Workspace-relative path of this run's `report.html` (U14). Set only when
     * the manifest is fresh, so the footer never points at a planted file.
     */
    reportHtml?: string;
}
/** The subset of code-review.json the comment head reads. */
export interface CodeReviewInput {
    ok?: boolean;
    skipped?: boolean;
    verdict?: string;
    summary?: string;
    visionCostUsd?: number;
    provenBlockers?: number;
    highConfidenceBlockers?: number;
    findings?: {
        file?: string;
        severity?: string;
        p?: number;
        suggestion?: string;
        evidence?: {
            status?: string;
        };
    }[];
    reviewComments?: {
        body?: string;
    }[];
    headBinding?: {
        intendedSha?: string;
        status?: string;
        detail?: string;
    };
}
/** The subset of run.json the comment head reads. */
export type ReportInput = Pick<RunReport, 'ok' | 'durationMs'> & {
    totals: Pick<RunReport['totals'], 'tests' | 'passed' | 'visionCostUsd'>;
    tests: {
        healEvents?: unknown[];
    }[];
};
/** One sticky-comment input, mirroring the action's five body renderers. */
export interface CommentInput {
    body: 'missing-key' | 'no-report' | 'manifest' | 'full' | 'review-only';
    ok?: boolean;
    manifest?: RunManifest;
    codeReview?: CodeReviewInput;
    report?: ReportInput;
    reportDir?: string;
}
export type Proof = ProofLevel | 'none' | null;
export interface LaneRow {
    lane: LaneId;
    status: LaneStatus;
    result: string;
    proof: Proof;
    spend: string;
}
export declare function findingsOf(cr: CodeReviewInput | undefined): NonNullable<CodeReviewInput['findings']>;
export declare function laneProof(lane: LaneId, status: LaneStatus, cr: CodeReviewInput | undefined): Proof;
export declare function manifestRow(lane: LaneView, cr: CodeReviewInput | undefined): LaneRow;
export declare function reproducedCount(cr: CodeReviewInput): number;
/** Headline status and word, shared by the comment and the HTML report. */
export declare function verdictOf(ok: boolean | undefined, aggregate: LaneStatus | undefined, cr: CodeReviewInput | undefined): {
    status: LaneStatus;
    label: string;
};
/** How a lead sentence marks up emphasis, code and plain text. */
export interface LeadFormat {
    strong: (s: string) => string;
    code: (s: unknown) => string;
    text: (s: unknown) => string;
}
/** The verdict line's lead: what the run proved, in one phrase. */
export declare function verdictLead(rows: LaneRow[], cr: CodeReviewInput | undefined, f?: LeadFormat): string;
/** First screen of any sticky body: sentinel through the findings summary. */
export declare function renderCommentHead(input: CommentInput): string;
export declare function renderMissingKeyComment(meta: CommentMeta): string;
/**
 * Whole manifest-only body (no code-review folds): lane names, status labels,
 * model/cost and head identity come from the shared view-model so the
 * comment agrees with the TUI and dashboard under the contract test.
 */
export declare function renderManifestComment(manifest: RunManifest, meta: CommentMeta): string;
export type CheckConclusion = 'success' | 'failure' | 'neutral';
/** Map a run report (and optional missing-key flag) to a check-run conclusion. */
export declare function conclusionFromReport(report: RunReport | undefined, missingKey?: boolean): CheckConclusion;
