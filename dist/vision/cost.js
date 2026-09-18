export function makeCallCost(response, kind) {
    const providerName = typeof response.provider === 'string' ? response.provider : response.provider?.name ?? 'unknown';
    return {
        model: response.model,
        provider: providerName,
        tokens: response.usage.total_tokens,
        costUsd: response.usage.cost,
        kind,
    };
}
export function makeDecisionsCallCost(response, kind) {
    const providerName = typeof response.provider === 'string' ? response.provider : response.provider?.name ?? 'unknown';
    const usage = response.usage ?? {};
    return {
        model: response.model ?? 'unknown',
        provider: providerName,
        tokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
        costUsd: usage.cost ?? 0,
        kind,
    };
}
export function extractUsageCost(response) {
    return {
        costUsd: response.usage.cost,
        upstreamCostUsd: response.usage.cost_details.upstream_inference_cost,
    };
}
