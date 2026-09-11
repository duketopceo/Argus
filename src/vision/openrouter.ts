import { ProviderRules } from '../config.js'
import { CallCost, CallKind, makeCallCost, OpenRouterResponse } from './cost.js'

export interface TextContentPart {
  type: 'text'
  text: string
}

export interface ImageContentPart {
  type: 'image'
  source: string
}

export type ContentPart = TextContentPart | ImageContentPart

export interface Message {
  role: 'user' | 'system' | 'assistant'
  content: ContentPart[]
}

export interface JsonSchema {
  name: string
  schema: Record<string, unknown>
  strict?: boolean
}

export interface OpenRouterClientOptions {
  apiKey: string
  fetch?: typeof fetch
  /**
   * Extra metadata sent on every request. `trace` is merged into the request
   * body `trace` field for cost attribution. `headers` are merged into the
   * request headers (e.g. HTTP-Referer, X-Title).
   */
  trace?: Record<string, string>
  headers?: Record<string, string>
  /**
   * Called once for every successful OpenRouter request with the resolved
   * model, cost, and token usage. Useful for per-call logging.
   */
  onCall?: (call: {
    id: string
    model: string
    kind: CallKind
    costUsd: number
    tokens: number
    trace?: Record<string, string>
  }) => void
}

export class OpenRouterClient {
  private _apiKey: string
  private _fetch: typeof fetch
  private _trace: Record<string, string> | undefined
  private _headers: Record<string, string> | undefined
  private _onCall: OpenRouterClientOptions['onCall']

  constructor(opts: OpenRouterClientOptions) {
    if (!opts.apiKey) {
      throw new Error('OPENROUTER_API_KEY is required: pass a non-empty apiKey at construction')
    }
    this._apiKey = opts.apiKey
    this._fetch = opts.fetch ?? globalThis.fetch
    this._trace = opts.trace
    this._headers = opts.headers
    this._onCall = opts.onCall
  }

  async complete(opts: {
    model: string
    messages: Message[]
    schema?: JsonSchema
    escalationModels?: string[]
    provider?: ProviderRules
    kind?: CallKind
  }): Promise<{ id: string; content: string; cost: CallCost; model: string }> {
    const candidates = [opts.model, ...(opts.escalationModels ?? [])]
    const errors: Error[] = []
    const kind = opts.kind ?? 'ground'

    for (let i = 0; i < candidates.length; i++) {
      const model = candidates[i]
      if (model === undefined) continue
      const remaining = candidates.slice(i + 1)
      try {
        const response = await this._tryComplete({
          model,
          messages: opts.messages,
          ...(opts.schema !== undefined ? { schema: opts.schema } : {}),
          ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
          models: remaining,
          kind,
        })
        const cost = makeCallCost(response, kind)
        this._onCall?.({
          id: response.id,
          model: response.model,
          kind,
          costUsd: cost.costUsd,
          tokens: cost.tokens,
          ...(this._trace ? { trace: this._trace } : {}),
        })
        return { id: response.id, content: this._extractContent(response), cost, model: response.model }
      } catch (e) {
        errors.push(e as Error)
      }
    }

    throw new Error(
      `OpenRouter completion failed for all candidate models: ${errors.map((e) => e.message).join('; ')}`,
    )
  }

  async reconcile(id: string): Promise<{ costUsd: number }> {
    const res = await this._fetch(
      `https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(id)}`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${this._apiKey}` },
      },
    )
    if (!res.ok) {
      throw new Error(`OpenRouter generation reconcile failed: ${res.status} ${res.statusText}`)
    }
    const data = (await res.json()) as { data?: { total_cost?: number }; total_cost?: number }
    const total = data.data?.total_cost ?? data.total_cost ?? 0
    return { costUsd: total }
  }

  private async _tryComplete(req: {
    model: string
    messages: Message[]
    schema?: JsonSchema
    provider?: ProviderRules
    models?: string[]
    kind: CallKind
  }): Promise<OpenRouterResponse> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: this._toApiMessages(req.messages),
    }
    if (req.provider) {
      body.provider = req.provider
    }
    if (req.models && req.models.length > 0) {
      body.models = req.models
    }
    if (req.schema) {
      body.response_format = {
        type: 'json_schema',
        json_schema: {
          name: req.schema.name,
          schema: req.schema.schema,
          strict: req.schema.strict ?? true,
        },
      }
    }
    if (this._trace) {
      body.trace = this._trace
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this._apiKey}`,
      'Content-Type': 'application/json',
      'X-Title': 'argus-reviewer',
      'X-OpenRouter-Metadata': 'enabled',
      ...(this._headers ?? {}),
    }

    const res = await this._fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      throw new Error(`OpenRouter request failed: ${res.status} ${res.statusText}`)
    }
    return (await res.json()) as OpenRouterResponse
  }

  private _toApiMessages(messages: Message[]): unknown[] {
    return messages.map((m) => ({
      role: m.role,
      content: m.content
        .map((part) => {
          if (part.type === 'text') {
            return { type: 'text', text: part.text }
          }
          return {
            type: 'image_url',
            image_url: { url: `data:image/jpeg;base64,${part.source}` },
          }
        })
        .sort((a) => (a.type === 'text' ? -1 : 1)),
    }))
  }

  private _extractContent(response: OpenRouterResponse): string {
    const first = response.choices[0]
    const content = first?.message?.content
    if (typeof content === 'string') return content
    return ''
  }
}
