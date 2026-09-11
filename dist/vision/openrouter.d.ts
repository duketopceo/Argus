import { ProviderRules } from '../config.js';
import { CallCost, CallKind } from './cost.js';
export interface TextContentPart {
    type: 'text';
    text: string;
}
export interface ImageContentPart {
    type: 'image';
    source: string;
}
export type ContentPart = TextContentPart | ImageContentPart;
export interface Message {
    role: 'user' | 'system' | 'assistant';
    content: ContentPart[];
}
export interface JsonSchema {
    name: string;
    schema: Record<string, unknown>;
    strict?: boolean;
}
export interface OpenRouterClientOptions {
    apiKey: string;
    fetch?: typeof fetch;
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
    private _trace;
    private _headers;
    private _onCall;
    constructor(opts: OpenRouterClientOptions);
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
    reconcile(id: string): Promise<{
        costUsd: number;
    }>;
    private _tryComplete;
    private _toApiMessages;
    private _extractContent;
}
