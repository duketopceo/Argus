#!/usr/bin/env node
import { Config } from './config.js';
import { type ExecFn, type ProbeFn } from './detect.js';
import { BrowserDriver } from './driver/browser.js';
import { VisionClient } from './engine/loop.js';
import { type PrMeta } from './evidence/ci.js';
import { type Evidence } from './evidence/link.js';
import { type ValidationAudit } from './review/validate.js';
import { type SecretsScanResult } from './review/secrets.js';
import { type TriageRecord } from './review/triage.js';
import { type FindingAdjudicationAudit } from './review/adjudicate.js';
import { type ProbeRecord } from './probe/queue.js';
import { type HeadBinding } from './report/manifest.js';
import { CallCost } from './vision/cost.js';
import { Message } from './vision/openrouter.js';
export interface CliDeps {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    out?: (line: string) => void;
    err?: (line: string) => void;
    /** Inject a vision client (tests stub this; default builds OpenRouterClient). */
    createClient?: (config: Config) => VisionClient;
    /** Inject a driver factory (tests may stub browser launch). */
    launchDriver?: (config: Config) => Promise<BrowserDriver>;
    /** Inject a subprocess runner (tests stub `a0`/`gh` detection + delegation). */
    exec?: ExecFn;
    /** Inject the host reachability probe (tests stub a0 detection). */
    probe?: ProbeFn;
    /**
     * Whether output goes to a terminal. Defaults to process.stdout.isTTY
     * when `out` is not injected, and to false when it is.
     */
    isTTY?: boolean;
    /** Terminal width for the summary block (default process.stdout.columns, else 80). */
    columns?: number;
}
export declare function main(argv: string[], deps?: CliDeps): Promise<number>;
interface PrFile {
    filename: string;
    previous_filename?: string;
    patch?: string;
}
export interface ReviewFinding {
    file: string;
    line?: number;
    severity: string;
    category?: string;
    message: string;
    /** U8: confidence-model true-positive probability (absent = unadjudicated). */
    p?: number;
    /** R1 — committable replacement lines for the commented range (parse-bounded). */
    suggestion?: string;
    /** R1 — first line of the replaced range; absent = single-line fix at `line`. */
    startLine?: number;
    evidence?: Evidence;
}
/** KTD3 — one pre-rendered inline review comment; posters POST it verbatim. */
export interface ReviewComment {
    path: string;
    line: number;
    start_line?: number;
    start_side?: 'RIGHT';
    side: 'RIGHT';
    body: string;
    /** KTD4: path:line:severity:normalizedMessage:hash8(suggestion); a corrected suggestion re-posts. */
    dedupKey: string;
}
export interface ReviewScope {
    /** Changed files in the PR with a patch. */
    totalFiles: number;
    /** Files that reached the review model. */
    reviewedFiles: number;
    /** Files kept out by `review.exclude`. */
    excludedFiles: number;
    /** Up to 5 excluded paths, for the Diagnostics line. */
    excludedSample: string[];
}
interface CodeReviewReport {
    ok: boolean;
    skipped: boolean;
    summary: string;
    verdict: 'pass' | 'needs_changes' | 'approve';
    findings: ReviewFinding[];
    /** Inline-comment cap consumed by the sticky poster (Tencent max_comments pull). */
    maxComments?: number;
    /** R3/KTD2 — poster gate: 'request_changes' only for proven blockers. */
    reviewEvent: 'comment' | 'request_changes';
    /** Blocker-severity findings a sandbox probe reproduced. */
    provenBlockers: number;
    /** Blocker-severity findings at/above the confidence-model P(true-positive) gate. */
    highConfidenceBlockers: number;
    /** KTD3 — eligibility-filtered, severity-sorted, sanitized, capped. */
    reviewComments: ReviewComment[];
    /** Eligible findings dropped by the maxComments cap. */
    commentsOverflow: number;
    /** B.2 probe audit records — present only when the sandbox lane ran. */
    probes?: ProbeRecord[];
    /** Why an enabled lane bowed out (fork gate, no docker, no harness…). */
    probeLaneSkipped?: string;
    /** Secrets-lane audit — masked candidates, adjudication verdicts, skip reason. */
    secretsScan?: SecretsScanResult | {
        skipped: string;
    };
    /** U7 triage record: confidence-model pre-review signals (annotate/route, never gates). */
    triage?: TriageRecord;
    /** U8 adjudication audit — per-finding p + suppressed records. */
    findingAdjudication?: FindingAdjudicationAudit;
    /** How much of the PR the review covered, and what was left out. */
    scope?: ReviewScope;
    /** Findings dropped by deterministic validation, with reasons. */
    validation?: ValidationAudit;
    calls: CallCost[];
    visionCostUsd: number;
    tokens: number;
    model: string;
    budgetExceeded: boolean;
    /** Identity relationship between the report source and checkout. */
    headBinding?: HeadBinding;
    /** Workflow-run nonce (GITHUB_RUN_ID) — see runNonceFrom. */
    runNonce?: string;
    /**
     * Base64 HTML-comment payload (`argus-probe-persist`) carrying reproduced
     * probe source — the sticky poster embeds it verbatim so `@argus persist`
     * can commit the probes later from a base-only checkout (E1.U3).
     */
    persistPayload?: string;
}
/**
 * Split `git diff` text into per-file PrFile entries — the local-diff
 * equivalent of the PR-files API response (which also reports `patch`
 * per file). `+++ b/` names new/copied files; `--- a/` covers deletions.
 */
export declare function filesFromUnifiedDiff(diff: string): PrFile[];
/**
 * `--fixture <dir>` seam: the dir is a real git repo with an
 * `argus-fixture-base` ref (the merge base) and HEAD at the PR head —
 * scripts/demo.mjs materializes it. Returns the same diff/files/meta
 * the GitHub paths would produce, so every downstream lane (chunking,
 * secrets scan, evidence linkage) runs its real code path.
 */
export declare function loadFixture(dir: string, exec?: ExecFn): Promise<{
    files: PrFile[];
    meta: PrMeta;
    diff: string;
} | {
    skipped: string;
}>;
export declare function buildPatchChunks(files: PrFile[], contexts?: Record<string, string>): string[];
export declare function buildCodeReviewMessages(repo: string, pr: string, patchText: string, chunkIndex?: number, totalChunks?: number, profiles?: readonly string[]): Message[];
export declare function parseCodeReview(content: string): {
    summary: string;
    verdict: 'pass' | 'needs_changes' | 'approve';
    findings: CodeReviewReport['findings'];
};
/**
 * KTD1 — a surviving synthesized finding's suggestion is restored verbatim
 * from its pre-synthesis original, matched on file + line + whitespace-
 * normalized message. With no pre-image the synthesized copy is dropped:
 * synthesis output is ungrounded model text, never committable code.
 */
export declare function carryForwardSuggestions(findings: CodeReviewReport['findings'], originals: CodeReviewReport['findings']): CodeReviewReport['findings'];
/**
 * R3/KTD2: confidence-model P(true-positive) at/above which a blocker-severity finding
 * counts as proven for the REQUEST_CHANGES gate. This is a different axis
 * from `review.findingThreshold` (P(false-positive) for nit/q suppression)
 * — never reuse that knob. 0.7: high-confidence without demanding
 * near-certainty from a calibrated scorer.
 */
export declare const P_TRUE_POSITIVE_THRESHOLD = 0.7;
/**
 * KTD2 — the poster-facing review gate, computed once at report assembly
 * on linkedFindings (post-adjudication `p`, post-probe `evidence`,
 * secrets-lane `pLive` already carried as `p`) and serialized into
 * code-review.json; posters read `reviewEvent`, never recompute.
 * Unadjudicated blockers (no p, not reproduced) never escalate —
 * degrade-open by design. The two counts overlap deliberately: a
 * reproduced AND high-confidence finding is reported under both.
 */
export declare function computeReviewEvent(findings: ReviewFinding[], blockSeverities: string[], allowRequestChanges: boolean): {
    reviewEvent: 'comment' | 'request_changes';
    provenBlockers: number;
    highConfidenceBlockers: number;
};
/**
 * KTD3 — pre-render the inline review surface: eligibility-filtered
 * (R8's static half — real path, positive integer line), severity-sorted
 * before the maxComments cap so nits can't crowd out bugs (R2), sanitized
 * (R5), suggestion-fenced, each carrying a dedupKey (R10). Posters consume
 * `comments` verbatim — dedup + live-diff validation + POST, no render
 * policy. `overflow` is the count of eligible findings past the cap.
 */
export declare function renderReviewComments(findings: ReviewFinding[], maxComments?: number): {
    comments: ReviewComment[];
    overflow: number;
};
export {};
