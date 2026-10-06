import type { RuleFailure, RuleFinding, RuleRecord } from '../review/rules.js';
import type { SecretsScanResult } from '../review/secrets.js';
/**
 * U7 — the standalone audit report for `argus scan <path>`. Deliberately
 * not CodeReviewReport (which is PR/headBinding-shaped) and not the run
 * manifest (which is replay-shaped): a tree audit has no PR, no head
 * binding, and no gate — findings and lane audit trails are the payload.
 */
export declare const SCAN_REPORT_SCHEMA_VERSION = 1;
export interface ScanSkipped {
    /** Lane or stage that did not complete ('rules', 'model', 'index'). */
    lane: string;
    reason: string;
}
export interface ScanSpend {
    calls: number;
    tokens: number;
    costUsd: number;
}
export interface ScanReport {
    schemaVersion: typeof SCAN_REPORT_SCHEMA_VERSION;
    generatedAt: string;
    /** Resolved absolute scan root — printed before any model call. */
    root: string;
    /** Whether the root is a git work tree (informational). */
    gitRepo: boolean;
    /** Files that produced a synthesized new-file diff section. */
    filesScanned: number;
    /** Files skipped by the walk or mid-synthesis (oversized/unreadable). */
    filesSkipped: number;
    /** Present when the scan diff came from `git diff <base>` instead of the tree. */
    diffRange?: {
        base: string;
        baseSha: string;
        headSha: string;
    };
    verdict: 'pass' | 'approve' | 'needs_changes';
    findings: RuleFinding[];
    /**
     * The deterministic lane's audit trail — `ran` lists rules that ran;
     * `skipped` is set when the lane itself could not run.
     */
    rulesScan?: {
        ran: string[];
        records: RuleRecord[];
        failures: RuleFailure[];
    } | {
        skipped: string;
    };
    secretsScan?: SecretsScanResult | {
        skipped: string;
    };
    /** Model-pass summary — present only under --model. */
    model?: {
        model: string;
        /** Chunks actually reviewed (≤ chunksPlanned when budget stopped early). */
        chunks: number;
        chunksPlanned: number;
        findings: number;
        /** Model findings dropped by diff-anchor validation. */
        dropped: number;
        budgetExceeded: boolean;
    };
    /** Real spend — always {0,0,0} without --model. */
    spend: ScanSpend;
    /** Lanes/stages that failed open — partial report is still written. */
    skipped: ScanSkipped[];
}
