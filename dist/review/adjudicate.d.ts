import { DecisionClient } from '../vision/decisions.js';
/**
 * U8 finding adjudication — one batched Jev decide() scores each
 * synthesized finding's true-positive probability before posting. Same
 * posture as the secrets lane: Jev annotates/routes, never gates.
 * `p` lands on the finding record and the sticky confidence column;
 * suppression is scoped to `nit`/`q` severities whose false-positive
 * confidence exceeds `findingThreshold` — `bug`/`risk` are never
 * suppressed, and a Jev outage leaves every finding unadjudicated and
 * unsuppressed (degrade open).
 *
 * `findingThreshold` is the required P(false positive): a nit/q is
 * suppressed when `1 - p > threshold`, i.e. `p < 1 - threshold`.
 * Default 1.0 → nothing can exceed 100% FP → annotate-only.
 */
export interface AdjudicableFinding {
    file: string;
    line?: number;
    severity: string;
    category?: string;
    message: string;
}
export interface FindingAdjudicationRecord {
    file: string;
    line?: number;
    severity: string;
    category?: string;
    /** Finding text — capped; suppressed findings keep their message in audit. */
    message: string;
    adjudicated: boolean;
    /** Jev P(true positive) for this finding. */
    p?: number;
    /** nit/q below the FP bar — kept for audit, removed from findings. */
    suppressed?: boolean;
}
/** The audit half of the result — what report.findingAdjudication stores. */
export interface FindingAdjudicationAudit {
    records: FindingAdjudicationRecord[];
    /** Findings past MAX_CANDIDATES — unadjudicated, never suppressed. */
    overflow: number;
    /** Whole-call failure — nothing adjudicated, nothing suppressed. */
    unadjudicated?: boolean;
}
export interface FindingAdjudicationResult<T extends AdjudicableFinding> extends FindingAdjudicationAudit {
    /** Surviving findings — adjudicated ones carry `p`. */
    findings: (T & {
        p?: number;
    })[];
}
export declare function adjudicateFindings<T extends AdjudicableFinding>(opts: {
    findings: T[];
    /** PR file patches keyed by filename — Jev state context. */
    patchByFile?: Map<string, string>;
    threshold: number;
    /**
     * User-configured blocking severities — a severity listed here drives
     * the verdict, so it must never be suppressed even if it is nit/q
     * (otherwise Jev suppression could flip the commit-status gate).
     */
    blockSeverities?: string[];
    client: DecisionClient;
    model?: string;
}): Promise<FindingAdjudicationResult<T>>;
