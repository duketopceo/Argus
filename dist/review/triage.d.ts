import { type DecisionClient } from '../vision/decisions.js';
declare const RISK_AREA_CRITERIA: {
    readonly auth: "authentication, authorization, tokens, sessions, permissions";
    readonly billing: "payments, invoices, usage metering, cost accounting";
    readonly data: "persistence, migrations, integrity, serialization, caching";
    readonly ops: "CI, deploy, infra, configuration, tooling, observability";
    readonly none: "no meaningful risk area in this diff";
};
export declare const TRIAGE_AREAS: TriageArea[];
export type TriageArea = keyof typeof RISK_AREA_CRITERIA;
export interface TriageRecord {
    mode: 'annotate' | 'route';
    /** noul 0–1 — does this PR warrant careful review. */
    needsDeepReview?: number;
    /** score 1–5 blast-radius rubric. */
    risk?: number;
    topRiskArea?: TriageArea;
    /** Choice-answer confidence when the API provides one. */
    topRiskAreaConfidence?: number;
    /** Chars of diff evidence Jev saw — route mode won't downgrade on 0. */
    diffExcerptChars?: number;
    /** decide() failed or answers failed validation — degrade-open marker. */
    unadjudicated?: boolean;
    /** Decision model that produced (or attempted) the record. */
    model: string;
}
export interface TriageState {
    title: string;
    body: string;
    files: string[];
    totalFiles: number;
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
export declare function triagePr(opts: {
    client: DecisionClient;
    model?: string;
    state: TriageState;
    mode: 'annotate' | 'route';
}): Promise<TriageRecord>;
/**
 * 'route' mode model selection — cheap tier only on a clear low-risk
 * signal (risk ≤ 2 AND deep-review < 0.5) backed by actual diff
 * evidence. Any ambiguity (missing fields, unadjudicated, unset
 * lowRiskModel, or a title/body-only triage — fully attacker-steerable
 * text) keeps the configured model: coverage stays constant and the
 * expensive path is the default.
 */
export declare function routeModel(opts: {
    record: TriageRecord | undefined;
    configured: string;
    lowRiskModel: string | undefined;
}): {
    model: string;
    reason: string;
};
/** U9 ordering signal consumed by the probe lane. */
export interface TriageAreaSignal {
    area: TriageArea;
    confidence: number;
}
/**
 * U9 — the probe lane's advisory ordering signal. Present only when
 * triage adjudicated a real area with its confidence attached; 'none'
 * is the null-area sentinel, not an ordering signal, and the
 * confidence floor itself is queue policy (MIN_AREA_CONFIDENCE).
 */
export declare function triageAreaSignal(rec: TriageRecord | undefined): TriageAreaSignal | undefined;
export {};
