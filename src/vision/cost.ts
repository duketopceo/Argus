export type CallKind = 'ground' | 'heal' | 'assert' | 'code'

export interface CallCost {
  model: string
  provider: string
  tokens: number
  costUsd: number
  kind: CallKind
}

export interface ChoiceMessage {
  content?: unknown
}

export interface Choice {
  message?: ChoiceMessage
}

export interface Usage {
  total_tokens: number
  cost: number
  cost_details: {
    upstream_inference_cost: number
  }
}

export type ProviderValue = string | { name?: string } | undefined

export interface OpenRouterResponse {
  id: string
  model: string
  provider?: ProviderValue
  choices: Choice[]
  usage: Usage
}

export function makeCallCost(response: OpenRouterResponse, kind: CallKind): CallCost {
  const providerName =
    typeof response.provider === 'string' ? response.provider : response.provider?.name ?? 'unknown'
  return {
    model: response.model,
    provider: providerName,
    tokens: response.usage.total_tokens,
    costUsd: response.usage.cost,
    kind,
  }
}

export function extractUsageCost(response: OpenRouterResponse): {
  costUsd: number
  upstreamCostUsd: number
} {
  return {
    costUsd: response.usage.cost,
    upstreamCostUsd: response.usage.cost_details.upstream_inference_cost,
  }
}
