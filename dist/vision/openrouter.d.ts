import { ProviderRules } from '../config.js';
import { CallCost, CallKind } from './cost.js';
interface TextContentPart {
    type: 'text';
    text: string;
}
interface ImageContentPart {
    type: 'image';
    source: string;
}
type ContentPart = TextContentPart | ImageContentPart;
export interface Message {
    role: 'user' | 'system' | 'assistant';
    content: ContentPart[];
}
export interface JsonSchema {
    name: string;
    schema: Record<string, unknown>;
    strict?: boolean;
}
/** One request inside an async batch; `customId` maps the result back. */
export interface BatchRequest {
    customId: string;
    messages: Message[];
    schema?: JsonSchema;
    provider?: ProviderRules;
}
/** Exactly one of `result` / `error` is set. */
export interface BatchItemResult {
    customId: string;
    result?: {
        id: string;
        content: string;
        cost: CallCost;
        model: string;
    };
    error?: string;
}
export interface OpenRouterClientOptions {
    apiKey: string;
    fetch?: typeof fetch;
    /** Per-request timeout in ms. Default 120_000. */
    timeoutMs?: number;
    /**
     * Extra metadata sent on every request. `trace` is merged into the request
     * body `trace` field for cost attribution. `headers` are merged into the
     * request headers (e.g. HTTP-Referer, X-Title).
     */
    trace?: Record<string, string>;
    headers?: Record<string, string>;
    /**
     * Called once for every successful OpenRouter request with the resolved
     * model, cost, and token usage. Useful for per-call logging.
     */
    onCall?: (call: {
        id: string;
        model: string;
        kind: CallKind;
        costUsd: number;
        tokens: number;
        trace?: Record<string, string>;
    }) => void;
}
export declare class OpenRouterClient {
    private _apiKey;
    private _fetch;
    private _timeoutMs;
    private _trace;
    private _extraHeaders;
    private _onCall;
    constructor(opts: OpenRouterClientOptions);
    private _request;
    complete(opts: {
        model: string;
        messages: Message[];
        schema?: JsonSchema;
        escalationModels?: string[];
        provider?: ProviderRules;
        kind?: CallKind;
    }): Promise<{
        id: string;
        content: string;
        cost: CallCost;
        model: string;
    }>;
    /**
     * Async Batch API: submit every request in one POST, poll until a terminal
     * status, and map the inline results back by `custom_id`. Throws when the
     * batch fails/expires/cancels or the poll deadline passes — callers fall
     * back to realtime. A per-request error is returned, not thrown.
     * `endpoint` and `model` are serialized before `requests`.
     */
    completeBatch(opts: {
        /** Base slug; a trailing `:batch` variant suffix is stripped. */
        model: string;
        requests: BatchRequest[];
        kind?: CallKind;
        pollIntervalMs?: number;
        /** Total time to wait for a terminal status before throwing. */
        deadlineMs: number;
    }): Promise<BatchItemResult[]>;
    reconcile(id: string): Promise<{
        costUsd: number;
    }>;
    private _buildBody;
    private _requestHeaders;
    private _tryComplete;
    private _toApiMessages;
    private _extractContent;
}
export {};
