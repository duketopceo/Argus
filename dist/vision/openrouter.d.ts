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
    role: 'user' | 'system' | 'assistant' | 'tool';
    content: ContentPart[];
    /** Assistant-outbound tool calls (U9 repo-context tools). */
    toolCalls?: {
        id: string;
        name: string;
        arguments: string;
    }[];
    /** Tool-response messages carry the call id they answer. */
    toolCallId?: string;
}
export interface JsonSchema {
    name: string;
    schema: Record<string, unknown>;
    strict?: boolean;
}
/**
 * A read-only tool the model may call mid-completion (U9). `run` executes
 * the call and returns the text the model sees — implementers gate and
 * bound the read; this client only routes.
 */
export interface ToolSpec {
    name: string;
    description: string;
    /** JSON-schema object describing the arguments. */
    parameters: Record<string, unknown>;
}
/** One executed tool call, recorded for the report's `toolUse` transcript. */
export interface ToolCallRecord {
    name: string;
    /** Parsed arguments as sent (already masked by the caller's executor). */
    args: Record<string, unknown>;
    ok: boolean;
    /** Result text the model saw (executor-masked, excerpt-safe). */
    result: string;
    round: number;
}
export interface ToolLoopResult {
    id: string;
    content: string;
    /** Every round's CallCost, in order — the caller ledgers each. */
    costs: CallCost[];
    model: string;
    toolCalls: ToolCallRecord[];
    rounds: number;
    /** Why the loop stopped asking: 'budget' or 'rounds' (undefined = answered). */
    abortReason?: 'budget' | 'rounds';
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
     * Opt-in tool-call loop (U9): like `complete` — same candidate escalation,
     * per-request timeout and onCall tap — but when the model answers with
     * `tool_calls` the caller's `execute` runs them and the results feed back
     * as `role: 'tool'` messages. Bounded by `maxRounds`; `canSpend` is checked
     * between rounds — false forces a final tool-free answer (degrade to
     * gathered context) instead of burning budget on more reads. Tool results
     * that error are returned to the model as text, never thrown.
     */
    completeWithTools(opts: {
        model: string;
        messages: Message[];
        schema?: JsonSchema;
        escalationModels?: string[];
        provider?: ProviderRules;
        kind?: CallKind;
        tools: ToolSpec[];
        execute: (name: string, args: Record<string, unknown>) => Promise<string>;
        maxRounds?: number;
        canSpend?: (spentUsd: number) => boolean;
    }): Promise<ToolLoopResult>;
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
