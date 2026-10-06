#!/usr/bin/env node
import { Config } from './config.js';
import { type ExecFn, type ProbeFn } from './detect.js';
import { BrowserDriver } from './driver/browser.js';
import { VisionClient } from './engine/loop.js';
import { type PrMeta } from './evidence/ci.js';
import { type Evidence } from './evidence/link.js';
import { type ValidationAudit } from './review/validate.js';
import { type SecretsScanResult } from './review/secrets.js';
import { runRules, type RuleFailure, type RuleRecord } from './review/rules.js';
import { type TriageRecord } from './review/triage.js';
import { type FindingAdjudicationAudit } from './review/adjudicate.js';
import { type ProbeRecord } from './probe/queue.js';
import { type GenerateLaneResult } from './probe/generate.js';
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
    /** Inject the rules-lane runner (tests force lane-level failure). */
    rulesRunner?: typeof runRules;
    /** Inject the host reachability probe (tests stub a0 detection). */
    probe?: ProbeFn;
    /**
     * Whether output goes to a terminal. Defaults to process.stdout.isTTY
     * when `out` is not injected, and to false when it is.
     */
    isTTY?: boolean;
    /** Terminal width for the summary block (default process.stdout.columns, else 80). */
    columns?: number;
    /** Sleep step for the --keep-alive debug hold; injectable for tests. */
    sleep?: (ms: number) => Promise<void>;
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
/** Per-finding audit record for a finding the post-parse filters removed. */
export interface DroppedFinding {
    file: string;
    line?: number;
    severity: string;
    category?: string;
    message: string;
    reason: 'outside-diff' | 'revert-nit';
}
export interface ReviewBatch {
    /** True when the Batch API produced the chunk reviews. */
    used: boolean;
    /** Chunks submitted. */
    chunks: number;
    /** Batch chunks re-run realtime because their request errored. */
    retriedRealtime?: number;
    /** Why the whole batch fell back to realtime. */
    fellBack?: string;
}
export interface ReviewScope {
    /** Changed files in the PR with a patch. */
    totalFiles: number;
    /** Files that reached the review model. */
    reviewedFiles: number;
    /** Files kept out by `review.exclude`. */
    excludedFiles: number;
    /** Model calls the diff was split into (1 for a PR that fits one call). */
    chunksTotal?: number;
    /** Chunks that were actually reviewed (fewer than total when the budget stopped the run). */
    chunksReviewed?: number;
    /** Reviewed files with no chunk reviewed (budget stop); 0 on a full review. */
    unreviewedFiles?: number;
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
    /** U2 — diff-scoped spec generation records; present only when the lane was asked to run. */
    generated?: GenerateLaneResult;
    /** Secrets-lane audit — masked candidates, adjudication verdicts, skip reason. */
    secretsScan?: SecretsScanResult | {
        skipped: string;
    };
    /**
     * U8 — deterministic ruleset-lane audit: every rule hit, suppression,
     * failure. The secrets rule's records appear here AND under
     * `secretsScan` — rulesScan is the complete lane audit; secretsScan
     * is the frozen pre-U8 report shape.
     */
    rulesScan?: {
        /** Rule ids that ran. */
        ran: string[];
        /** Every hit — suppressed or finding-bound — rule-tagged. */
        records: RuleRecord[];
        /** Rules that threw; findings absent, lane completed anyway. */
        failures: RuleFailure[];
    } | {
        skipped: string;
    };
    /** U7 triage record: confidence-model pre-review signals (annotate/route, never gates). */
    triage?: TriageRecord;
    /** U8 adjudication audit — per-finding p + suppressed records. */
    findingAdjudication?: FindingAdjudicationAudit;
    /** Findings dropped for citing a file/line the diff never shows. */
    droppedUnanchored?: number;
    /** nit/q findings dropped for asking to revert text the diff added. */
    droppedReverted?: number;
    /** Per-finding audit of dropped findings (capped at 50); counters stay total. */
    droppedFindings?: DroppedFinding[];
    /** Synthesis verdict when it diverges from the post-filter derived verdict. */
    modelVerdict?: 'pass' | 'needs_changes' | 'approve';
    /** How much of the PR the review covered, and what was left out. */
    scope?: ReviewScope;
    /** Present when `review.mode` is batch: whether the batch served the review. */
    batch?: ReviewBatch;
    /** Findings dropped by deterministic validation, with reasons. */
    validation?: ValidationAudit;
    /** Test-file findings capped at nit (bug/risk with no non-test citation). */
    testFileCapped?: number;
    calls: CallCost[];
    visionCostUsd: number;
    tokens: number;
    model: string;
    budgetExceeded: boolean;
    /** Identity relationship between the report source and checkout. */
    headBinding?: HeadBinding;
    /** U16 — the reviewed range on local-diff runs (`--base`) and PR runs
     *  (merge base or a verified incremental baseline). */
    diffRange?: {
        base: string;
        baseSha: string;
        headSha: string;
    };
    /** U4 — head SHA a completed, non-budget-exceeded review covered; the
     *  sticky poster carries it as the `argus:last-reviewed-sha` marker. */
    reviewedHeadSha?: string;
    /** U4 — incremental-review audit: the verified baseline the diff ranged
     *  from (`since`), or why a stored baseline was rejected (`rejected`). */
    incremental?: {
        since?: string;
        commits?: number;
        rejected?: string;
    };
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
/**
 * `--base <ref>` seam: review the local diff with zero GitHub context —
 * the canonical "review my work" path for agents and local users (U16).
 * The diff runs merge-base against the WORKING TREE so committed and
 * uncommitted changes both land; a clean checkout reduces to base..HEAD.
 * `git diff` never names untracked files, so each is materialized through
 * `git diff --no-index /dev/null <file>` — a new file the agent just wrote
 * is precisely the local-change case. The index is never touched
 * (`git add -N`/`stash` would mutate the user's repo state).
 */
export declare function loadLocalDiff(cwd: string, baseRef: string, exec?: ExecFn, opts?: {
    excludeDirs?: string[];
}): Promise<{
    files: PrFile[];
    meta: PrMeta & {
        headSha: string;
        baseSha: string;
    };
    diff: string;
} | {
    error: string;
}>;
export declare function buildPatchChunks(files: PrFile[], contexts?: Record<string, string>): string[];
export declare function buildCodeReviewMessages(repo: string, pr: string, patchText: string, chunkIndex?: number, totalChunks?: number, profiles?: readonly string[], instructions?: readonly string[]): Message[];
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
 * New-side (RIGHT) line ranges covered by each file's diff hunks — the
 * only lines a finding can anchor to (and the only ones it could have
 * seen).
 */
export declare function diffLineRanges(files: readonly {
    filename: string;
    patch?: string | undefined;
}[]): Map<string, [number, number][]>;
/**
 * New-side line number -> line text for every line the diff shows
 * (added and context). Lets post-parse checks compare a finding's claim
 * against what the cited line actually says.
 */
export declare function diffLineTexts(files: readonly {
    filename: string;
    patch?: string | undefined;
}[]): Map<string, Map<number, string>>;
/**
 * Drop nit/q findings that ask to remove or revert text the cited diff
 * line itself contains — i.e. findings that would undo wording the PR
 * deliberately added ("remove `inconclusive`", "replace 'self-reported'
 * with 'self-reported'"). Verdict-driving findings (bug/risk, security-
 * category, configured blocking severities) are never touched: if the
 * claim is real, severity stays the reviewer's call.
 */
export declare function filterRevertNits(findings: readonly ReviewFinding[], textsByFile: Map<string, Map<number, string>>, blockSeverities?: readonly string[]): {
    kept: ReviewFinding[];
    dropped: ReviewFinding[];
};
/**
 * Drop findings whose line isn't visible in the file's diff. A finding on
 * a file the diff doesn't touch, or at a line outside every hunk, is
 * unverifiable and unpostable — misnumbered and fabricated citations land
 * here. Line-less (file-level) findings always survive. Verdict-driving
 * findings (bug/risk, security-category, configured blocking severities)
 * are never dropped — a misnumbered cite on a real defect must still
 * gate; the post-time isOnDiff check keeps its comment off the PR.
 */
export declare function filterToDiffLines(findings: readonly ReviewFinding[], rangesByFile: Map<string, [number, number][]>, blockSeverities?: readonly string[]): {
    kept: ReviewFinding[];
    dropped: ReviewFinding[];
};
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
