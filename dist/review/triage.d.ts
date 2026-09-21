import { type DecisionClient, type DecisionQuestion } from '../vision/decisions.js';
export declare const TRIAGE_AREAS: readonly ["auth", "billing", "data", "ops", "none"];
export type TriageArea = (typeof TRIAGE_AREAS)[number];
export interface TriageRecord {
    mode: 'annotate' | 'route';
    /** noul 0–1 — does this PR warrant careful review. */
    needsDeepReview?: number;
    /** score 1–5 blast-radius rubric. */
    risk?: number;
    topRiskArea?: TriageArea;
    /** Choice-answer confidence when the API provides one. */
    topRiskAreaConfidence?: number;
    /** decide() failed or answers failed validation — degrade-open marker. */
    unadjudicated?: boolean;
    /** Decision model that produced the record (empty when none ran). */
    model: string;
}
export interface TriageState {
    title: string;
    body: string;
    files: string[];
    diffExcerpt: string;
}
export declare function buildTriageState(opts: {
    title?: string | undefined;
    body?: string | undefined;
    files: {
        filename: string;
        patch?: string;
    }[];
}): TriageState;
export declare function buildTriageQuestions(): Record<string, DecisionQuestion>;
export declare function triagePr(opts: {
    client: DecisionClient;
    model?: string;
    state: TriageState;
    mode: 'annotate' | 'route';
}): Promise<TriageRecord>;
/**
 * 'route' mode model selection — cheap tier only on a clear low-risk
 * signal (risk ≤ 2 AND deep-review < 0.5). Any ambiguity (missing
 * fields, unadjudicated, unset lowRiskModel) keeps the configured model:
 * coverage stays constant and the expensive path is the default.
 */
export declare function routeModel(opts: {
    record: TriageRecord | undefined;
    configured: string;
    lowRiskModel: string | undefined;
}): {
    model: string;
    reason: string;
};
