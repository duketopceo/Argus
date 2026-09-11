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
export function extractUsageCost(response) {
    return {
        costUsd: response.usage.cost,
        upstreamCostUsd: response.usage.cost_details.upstream_inference_cost,
    };
}
