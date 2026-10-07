import type { DecisionClient } from '../vision/decisions.js';
import { type SecretsScanResult } from './secrets.js';
/**
 * U8 — named deterministic ruleset lane. Pure functions over the PR's
 * materialized scan diff (the same surface the secrets lane consumes:
 * fixture/local-review/incremental/merge-base) emitting findings that
 * union into the review AFTER synthesis — a prompt-injected synthesis can
 * never erase them, and a throwing rule degrades open (failure audit
 * entry, the other rules still run, the review completes).
 *
 * Severity ceiling: no rule may emit `bug` without adjudication — the
 * runner demotes unadjudicated `bug` claims to `risk` and audits the
 * demotion. The secrets rule's confidence-model adjudication (`p`) is
 * the only adjudication hook in the lane today.
 *
 * Masking contract: rules emit pattern classes and positions, never raw
 * line text — a matched line can itself contain a secret.
 */
export interface RuleFinding {
    file: string;
    line?: number;
    severity: string;
    category?: string;
    message: string;
    /** Adjudicated confidence (secrets rule) — the only `bug` license. */
    p?: number;
    /** Stamped by the runner — provenance survives the post-synthesis union. */
    rule?: string;
}
export interface RuleRecord {
    rule: string;
    file: string;
    line?: number;
    /** Pattern class or construct matched — never raw line text. */
    detail: string;
    /** Why the hit was recorded but did not become a finding. */
    suppressed?: string;
    adjudicated?: boolean;
    pLive?: number;
}
export interface RuleFailure {
    rule: string;
    error: string;
}
interface RuleOutput {
    findings: RuleFinding[];
    records: Omit<RuleRecord, 'rule'>[];
    /** The secrets rule's native result — feeds report.secretsScan. */
    secretsScan?: SecretsScanResult;
}
export interface RuleRunContext {
    /** Confidence-model adjudication for the secrets rule. */
    decisionClient?: DecisionClient;
    decisionModel?: string;
    secretsThreshold?: number;
}
export interface ReviewRule {
    id: string;
    description: string;
    run(diff: string, ctx: RuleRunContext): Promise<RuleOutput> | RuleOutput;
}
export interface RulesRunResult {
    findings: RuleFinding[];
    /** Every rule hit — suppressed or finding-bound — rule-tagged. */
    records: RuleRecord[];
    /** Rules that threw; their findings are absent, the lane completes. */
    failures: RuleFailure[];
    /** Rule ids that ran. */
    ran: string[];
    /** SecretsScanResult when the secrets rule ran — report.secretsScan. */
    secretsScan?: SecretsScanResult;
}
/** Per-rule hit cap — a formatter churning TODOs must not flood the report. */
export declare const RULE_HITS_CAP = 200;
/**
 * Per-rule audit-record bound — records stay complete for realistic
 * inputs; a pathological diff (generated churn) collapses past the cap
 * into one count-preserving aggregate record instead of an unbounded
 * report payload.
 */
export declare const RULE_RECORDS_CAP = 2000;
/** The rule registry — curated, not a plugin surface. */
export declare const REVIEW_RULES: readonly ReviewRule[];
/** All registered rule ids — the default `review.rules` enabled set. */
export declare const REVIEW_RULE_IDS: string[];
/**
 * Run the enabled rules over the materialized scan diff. Additive union
 * input for the review — output feeds report.rulesScan plus, for the
 * secrets rule, report.secretsScan (unchanged shape).
 */
export declare function runRules(diff: string, opts?: {
    /** Enabled ids; undefined = all. [] disables the lane. */
    enabled?: string[];
    /** Test seam — swap the registry. */
    rules?: ReviewRule[];
} & RuleRunContext): Promise<RulesRunResult>;
export {};
