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
    // Coerce — a string cost would throw downstream at toFixed and discard
    // a valid decision; a string token count would concatenate.
    return {
        model: response.model ?? 'unknown',
        provider: providerName,
        tokens: (Number(usage.input_tokens) || 0) + (Number(usage.output_tokens) || 0),
        costUsd: Number(usage.cost) || 0,
        kind,
    };
}
export function extractUsageCost(response) {
    return {
        costUsd: response.usage.cost,
        upstreamCostUsd: response.usage.cost_details.upstream_inference_cost,
    };
}
