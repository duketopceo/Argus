import { debug } from '../debug.js';
import { makeDecisionsCallCost } from './cost.js';
/**
 * Pinned Jev slug — the alias `~typesafe/jev-latest` drifts silently and
 * adjudication thresholds are calibrated to a version. The alias stays
 * usable via `config.decisionModel` for experimentation.
 */
export const JEV_DEFAULT_MODEL = 'typesafe/jev-1.13-20260917';
const DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions';
const TIMEOUT_MS = 15_000;
const MAX_CHOICE_OPTIONS = 255;
const MIN_SCORE_LEVELS = 2;
const MAX_SCORE_LEVELS = 10;
export class DecisionError extends Error {
    kind;
    retryable;
    constructor(kind, message, retryable) {
        super(message);
        this.kind = kind;
        this.retryable = retryable;
        this.name = 'DecisionError';
    }
}
/** Type guards over the answer union — one `in` check per lane otherwise. */
export const isNoulAnswer = (a) => 'noul' in a;
export const isChoiceAnswer = (a) => 'choice' in a;
export const isScoreAnswer = (a) => 'score' in a;
/** Short error label for lane debug lines: DecisionError kind, else message. */
export function describeDecisionError(e) {
    return e instanceof DecisionError ? e.kind : e.message;
}
/** Shared per-call batch cap for the Jev lanes (secrets, findings, triage). */
export const MAX_CANDIDATES = 50;
function isRecord(v) {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function validateQuestions(questions) {
    const entries = Object.entries(questions);
    if (entries.length === 0) {
        throw new DecisionError('validation', 'decide: at least one question is required', false);
    }
    for (const [id, q] of entries) {
        if (id === '') {
            throw new DecisionError('validation', 'decide: question IDs must be non-empty', false);
        }
        if (q.type === 'choice') {
            const n = Object.keys(q.criteria).length;
            if (n === 0 || n > MAX_CHOICE_OPTIONS) {
                throw new DecisionError('validation', `decide: choice question "${id}" needs 1-${MAX_CHOICE_OPTIONS} options, got ${n}`, false);
            }
        }
        else if (q.type === 'score') {
            const n = q.criteria.length;
            if (n < MIN_SCORE_LEVELS || n > MAX_SCORE_LEVELS) {
                throw new DecisionError('validation', `decide: score question "${id}" needs ${MIN_SCORE_LEVELS}-${MAX_SCORE_LEVELS} levels, got ${n}`, false);
            }
        }
        else if (q.type !== 'noul') {
            throw new DecisionError('validation', `decide: question "${id}" has unknown type`, false);
        }
    }
}
function validateAnswers(questions, answers) {
    // Per-question salvage: a missing or malformed answer is skipped, not
    // fatal — every caller degrades open per item (undefined answer →
    // unadjudicated), so one bad f_i must not void the whole batch.
    const out = {};
    for (const [id, q] of Object.entries(questions)) {
        const a = answers[id];
        if (!isRecord(a))
            continue;
        if (q.type === 'noul') {
            if (typeof a.noul === 'number' && Number.isFinite(a.noul) && a.noul >= 0 && a.noul <= 1) {
                out[id] = { noul: a.noul };
            }
        }
        else if (q.type === 'choice') {
            const confOk = a.confidence === undefined ||
                (typeof a.confidence === 'number' &&
                    Number.isFinite(a.confidence) &&
                    a.confidence >= 0 &&
                    a.confidence <= 1);
            if (typeof a.choice === 'string' && Object.hasOwn(q.criteria, a.choice) && confOk) {
                out[id] = a;
            }
        }
        else {
            // Score answers must land inside the rubric — an out-of-range
            // score could otherwise satisfy a low-risk routing predicate.
            const maxScore = Array.isArray(q.criteria) ? q.criteria.length : 0;
            if (typeof a.score === 'number' &&
                Number.isFinite(a.score) &&
                a.score >= 1 &&
                a.score <= maxScore) {
                out[id] = a;
            }
        }
    }
    return out;
}
function classifyStatus(status) {
    if (status === 401 || status === 403) {
        return new DecisionError('auth', `decide: HTTP ${status} — check OPENROUTER_API_KEY`, false);
    }
    if (status === 400 || status === 404 || status === 422) {
        return new DecisionError('validation', `decide: HTTP ${status} — request rejected`, false);
    }
    if (status === 429) {
        return new DecisionError('rate_limited', 'decide: HTTP 429 rate limited', true);
    }
    if (status === 503) {
        return new DecisionError('overloaded', 'decide: HTTP 503 provider overloaded', true);
    }
    if (status >= 500) {
        return new DecisionError('server_error', `decide: HTTP ${status}`, true);
    }
    return new DecisionError('unexpected', `decide: HTTP ${status}`, false);
}
function retryDelayMs(res) {
    const retryAfterMs = res.headers.get('retry-after-ms');
    if (retryAfterMs !== null) {
        const parsed = Number(retryAfterMs);
        if (Number.isFinite(parsed) && parsed >= 0)
            return Math.min(parsed, 30_000);
    }
    const retryAfter = res.headers.get('retry-after');
    if (retryAfter !== null) {
        const parsed = Number(retryAfter);
        if (Number.isFinite(parsed) && parsed >= 0)
            return Math.min(parsed * 1000, 30_000);
    }
    return 1_000;
}
export class DecisionClient {
    _apiKey;
    _fetch;
    _trace;
    _timeoutMs;
    _onCall;
    constructor(opts) {
        if (!opts.apiKey) {
            throw new Error('OPENROUTER_API_KEY is required: pass a non-empty apiKey at construction');
        }
        this._apiKey = opts.apiKey;
        this._fetch = opts.fetch ?? globalThis.fetch;
        this._trace = opts.trace;
        this._timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
        this._onCall = opts.onCall;
    }
    /**
     * Ask typed questions about `state`. Throws a typed `DecisionError` on
     * any failure — callers catch and degrade to unadjudicated; a decision
     * failure must never suppress findings (KTD6).
     */
    async decide(opts) {
        const model = opts.model ?? JEV_DEFAULT_MODEL;
        validateQuestions(opts.questions);
        const body = {
            model,
            state: opts.state,
            questions: opts.questions,
        };
        if (this._trace)
            body.trace = this._trace;
        let lastErr;
        for (let attempt = 0; attempt < 2; attempt++) {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), this._timeoutMs);
            try {
                const res = await this._fetch(DECISIONS_URL, {
                    method: 'POST',
                    signal: controller.signal,
                    headers: {
                        Authorization: `Bearer ${this._apiKey}`,
                        'Content-Type': 'application/json',
                        'X-Title': 'argus-reviewer',
                    },
                    body: JSON.stringify(body),
                });
                if (!res.ok) {
                    const err = classifyStatus(res.status);
                    if (err.retryable && attempt === 0) {
                        const delay = retryDelayMs(res);
                        debug('decisions', `${err.kind} — retrying in ${delay}ms`);
                        await new Promise((r) => setTimeout(r, delay));
                        continue;
                    }
                    throw err;
                }
                const data = (await res.json());
                if (!isRecord(data.answers)) {
                    throw new DecisionError('unexpected', 'decide: response has no answers object', false);
                }
                const answers = validateAnswers(opts.questions, data.answers);
                const cost = makeDecisionsCallCost(data, 'decide');
                debug('decisions', `model=${cost.model} provider=${cost.provider} tokens=${cost.tokens} costUsd=${cost.costUsd.toFixed(6)}`);
                this._onCall?.({
                    id: data.id ?? '',
                    model: cost.model,
                    provider: cost.provider,
                    kind: 'decide',
                    costUsd: cost.costUsd,
                    tokens: cost.tokens,
                    ...(this._trace ? { trace: this._trace } : {}),
                });
                return { answers, cost, model: cost.model };
            }
            catch (e) {
                if (e instanceof DecisionError) {
                    lastErr = e;
                    // Validation/unexpected errors never retry — they retry identically.
                    break;
                }
                const err = e;
                if (err.name === 'AbortError') {
                    lastErr = new DecisionError('timeout', `decide: timed out after ${this._timeoutMs}ms`, true);
                    if (attempt === 0) {
                        debug('decisions', 'timeout — retrying once');
                        continue;
                    }
                    break;
                }
                lastErr = new DecisionError('unexpected', `decide: ${err.message}`, false);
                break;
            }
            finally {
                clearTimeout(timeout);
            }
        }
        throw lastErr ?? new DecisionError('unexpected', 'decide: failed', false);
    }
}
