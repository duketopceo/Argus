export type CallKind = 'ground' | 'heal' | 'assert' | 'code' | 'decide';
export interface CallCost {
    model: string;
    provider: string;
    tokens: number;
    costUsd: number;
    kind: CallKind;
}
export interface ChoiceMessage {
    content?: unknown;
}
export interface Choice {
    message?: ChoiceMessage;
}
export interface Usage {
    total_tokens: number;
    cost: number;
    cost_details: {
        upstream_inference_cost: number;
    };
}
export type ProviderValue = string | {
    name?: string;
} | undefined;
export interface OpenRouterResponse {
    id: string;
    model: string;
    provider?: ProviderValue;
    choices: Choice[];
    usage: Usage;
}
export declare function makeCallCost(response: OpenRouterResponse, kind: CallKind): CallCost;
/** Decisions API (`/api/alpha/decisions`) usage shape — no `cost_details`. */
export interface DecisionsResponse {
    id?: string;
    model?: string;
    provider?: ProviderValue;
    answers?: Record<string, unknown>;
    usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cost?: number;
    };
}
export declare function makeDecisionsCallCost(response: DecisionsResponse, kind: CallKind): CallCost;
export declare function extractUsageCost(response: OpenRouterResponse): {
    costUsd: number;
    upstreamCostUsd: number;
};
