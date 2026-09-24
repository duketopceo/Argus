import type { CallCost, ProviderValue } from './cost.js';
/**
 * Pinned Jev slug — the alias `~typesafe/jev-latest` drifts silently and
 * adjudication thresholds are calibrated to a version. The alias stays
 * usable via `config.decisionModel` for experimentation.
 */
export declare const JEV_DEFAULT_MODEL = "typesafe/jev-1.13-20260917";
export type DecisionErrorKind = 'auth' | 'validation' | 'rate_limited' | 'overloaded' | 'server_error' | 'timeout' | 'unexpected';
export declare class DecisionError extends Error {
    readonly kind: DecisionErrorKind;
    readonly retryable: boolean;
    constructor(kind: DecisionErrorKind, message: string, retryable: boolean);
}
export interface NoulQuestion {
    type: 'noul';
    instructions: string;
    /** Optional yes/no clarifications, sent verbatim. */
    true?: string;
    false?: string;
}
export interface ChoiceQuestion {
    type: 'choice';
    instructions: string;
    /** Option ID -> description. Up to 255 options. */
    criteria: Record<string, string>;
}
export interface ScoreQuestion {
    type: 'score';
    instructions: string;
    /** 2-10 ordered rubric levels, low to high. */
    criteria: string[];
}
export type DecisionQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;
export interface NoulAnswer {
    noul: number;
}
export interface ChoiceAnswer {
    choice: string;
    probabilities?: Record<string, number>;
    confidence?: number;
}
export interface ScoreAnswer {
    score: number;
    legend?: string[];
    probabilities?: number[];
    confidence?: number;
}
export type DecisionAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;
/** Type guards over the answer union — one `in` check per lane otherwise. */
export declare const isNoulAnswer: (a: DecisionAnswer) => a is NoulAnswer;
export declare const isChoiceAnswer: (a: DecisionAnswer) => a is ChoiceAnswer;
export declare const isScoreAnswer: (a: DecisionAnswer) => a is ScoreAnswer;
/** Short error label for lane debug lines: DecisionError kind, else message. */
export declare function describeDecisionError(e: unknown): string;
/** Shared per-call batch cap for the Jev lanes (secrets, findings, triage). */
export declare const MAX_CANDIDATES = 50;
export interface DecisionClientOptions {
    apiKey: string;
    fetch?: typeof fetch;
    trace?: Record<string, string>;
    /** Request timeout in ms. Default 15_000. */
    timeoutMs?: number;
    onCall?: (call: {
        id: string;
        model: string;
        provider: string;
        kind: 'decide';
        costUsd: number;
        tokens: number;
        trace?: Record<string, string>;
    }) => void;
}
export declare class DecisionClient {
    private _apiKey;
    private _fetch;
    private _trace;
    private _timeoutMs;
    private _onCall;
    constructor(opts: DecisionClientOptions);
    /**
     * Ask typed questions about `state`. Throws a typed `DecisionError` on
     * any failure — callers catch and degrade to unadjudicated; a decision
     * failure must never suppress findings (KTD6).
     */
    decide(opts: {
        model?: string;
        state: unknown;
        questions: Record<string, DecisionQuestion>;
    }): Promise<{
        answers: Record<string, DecisionAnswer>;
        cost: CallCost;
        model: string;
    }>;
}
export type { ProviderValue };
