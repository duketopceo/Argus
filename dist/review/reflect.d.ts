import { DecisionClient } from '../vision/decisions.js';
/**
 * U4(b) reflection pass — one batched confidence-model decide() re-reads each
 * surviving model finding against its file's patch and drops findings whose
 * claim the diff does not support. This is the grounding check, distinct from
 * adjudication's worth-acting-on judgment: a finding citing code the patch
 * does not show, or faulting the diff for something it names but does not own,
 * is ungrounded regardless of severity.
 *
 * Unlike adjudication, reflection may drop a `bug`/`risk` — that is its
 * purpose — so it runs BEFORE adjudication and the rules union, keeping
 * ungrounded claims out of the gate and out of the probe lane. Dropped
 * findings stay in the audit record (records[].dropped) — nothing vanishes.
 * Rules-lane findings never enter; the deterministic lane cannot be reflected
 * away. A failed call is unchecked, not a wipe: degrade open, keep everything.
 */
export interface ReflectableFinding {
    file: string;
    line?: number;
    severity: string;
    category?: string;
    message: string;
}
interface FindingReflectionRecord {
    file: string;
    line?: number;
    severity: string;
    /** Finding text — capped; dropped findings keep their message in audit. */
    message: string;
    checked: boolean;
    /** Confidence-model P(the patch supports the finding's claim). */
    grounded?: number;
    /** grounded below the floor — kept for audit, removed from findings. */
    dropped?: boolean;
}
/** The audit half of the result — what report.reflection stores. */
export interface FindingReflectionAudit {
    records: FindingReflectionRecord[];
    /** Checked findings the reflector dropped as ungrounded. */
    dropped: number;
    /** Findings past MAX_CANDIDATES — unchecked, never dropped. */
    overflow: number;
    /** Whole-call failure — nothing checked, nothing dropped. */
    unchecked?: boolean;
}
export interface FindingReflectionResult<T extends ReflectableFinding> extends FindingReflectionAudit {
    /** Surviving findings. */
    findings: T[];
}
export declare function reflectFindings<T extends ReflectableFinding>(opts: {
    findings: T[];
    /** PR file patches keyed by filename — grounding context. */
    patchByFile?: Map<string, string>;
    floor?: number;
    client: DecisionClient;
    model?: string;
}): Promise<FindingReflectionResult<T>>;
export {};
