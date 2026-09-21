export type CallKind = 'ground' | 'heal' | 'assert' | 'code' | 'decide'

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

/** Decisions API (`/api/alpha/decisions`) usage shape — no `cost_details`. */
export interface DecisionsResponse {
  id?: string
  model?: string
  provider?: ProviderValue
  answers?: Record<string, unknown>
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cost?: number
  }
}

export function makeDecisionsCallCost(response: DecisionsResponse, kind: CallKind): CallCost {
  const providerName =
    typeof response.provider === 'string' ? response.provider : response.provider?.name ?? 'unknown'
  const usage = response.usage ?? {}
  // Coerce — a string cost would throw downstream at toFixed and discard
  // a valid decision; a string token count would concatenate.
  return {
    model: response.model ?? 'unknown',
    provider: providerName,
    tokens: (Number(usage.input_tokens) || 0) + (Number(usage.output_tokens) || 0),
    costUsd: Number(usage.cost) || 0,
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
