import { type ExecFn } from '../detect.js';
import { DecisionClient } from '../vision/decisions.js';
/**
 * Deterministic secrets scan over the PR's local merge-base diff,
 * optionally adjudicated by the Decisions API (Jev). The lane is
 * additive-only: findings are unioned into the review AFTER model
 * synthesis so a prompt-injected synthesis can never erase them, and a
 * Jev outage degrades to regex-only findings rather than silence.
 *
 * Masking contract: raw literals transit to Jev inside `state` (KTD9 —
 * adjudication needs the shape, and the full diff already crosses to
 * OpenRouter in the review call) and appear NOWHERE else — not in
 * findings, comments, the report, or logs.
 */
export interface SecretCandidate {
    file: string;
    /** Line number in the post-change file. */
    line: number;
    patternClass: string;
    /** Diff line text with every occurrence of the literal replaced by `***`. */
    contextExcerpt: string;
    /** Raw literal — Jev `state` only, never emitted. */
    literal: string;
    /** Full raw added-line text — Jev `state` only, never emitted. */
    rawText: string;
}
export interface SecretScanRecord {
    file: string;
    line: number;
    patternClass: string;
    /** True when Jev answered for this candidate. */
    adjudicated: boolean;
    pLive?: number;
    /** Jev scored below threshold — recorded for audit, not a finding. */
    suppressed?: boolean;
}
export interface SecretsScanResult {
    /** Findings to union into the review — messages are fully masked. */
    findings: {
        file: string;
        line?: number;
        severity: string;
        category?: string;
        message: string;
    }[];
    /** Audit records for report.secretsScan — literals never included. */
    records: SecretScanRecord[];
    /** Candidates past MAX_CANDIDATES — reported count-only, never sent to Jev. */
    overflow: number;
    /** Why the lane produced nothing (e.g. base unfetchable). */
    skipped?: string;
}
export declare const MAX_CANDIDATES = 50;
export declare const DEFAULT_SECRETS_THRESHOLD = 0.3;
/**
 * Parse `git diff` text into secret candidates from added (`+`) lines.
 * Removed/context lines are not scanned — a rotated-out-but-live secret
 * in a `-` line is a deliberate open question (plan OQ), and context
 * lines would re-flag pre-existing secrets the PR did not introduce.
 */
export declare function scanDiffForSecrets(diffText: string): SecretCandidate[];
/**
 * Materialize the merge-base diff locally — the PR-files API `patch`
 * field omits large/binary files, so the API diff is not a complete
 * scan surface.
 */
export declare function materializeMergeBaseDiff(opts: {
    cwd: string;
    baseSha: string;
    token?: string;
    exec?: ExecFn;
}): Promise<{
    diff: string;
} | {
    skipped: string;
}>;
/**
 * Full lane: scan candidates (capped), Jev-adjudicate when a client and
 * threshold are available, and emit masked findings + audit records.
 * `client === undefined` (decisionModel unset) or any DecisionError →
 * every candidate unadjudicated — regex-only mode, never silence.
 */
export declare function scanSecrets(opts: {
    diff: string;
    threshold?: number;
    client?: DecisionClient;
    model?: string;
}): Promise<SecretsScanResult>;
