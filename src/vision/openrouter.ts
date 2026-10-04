import { ProviderRules } from '../config.js'
import { debug } from '../debug.js'
import { classifyHttpStatus, CliError, pickProviderError } from '../ui/errors.js'
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

/**
 * Per-request timeout for OpenRouter calls. A hung connection otherwise
 * blocks the caller forever — observed in the wild pinning a self-hosted
 * review job for 90+ minutes on one socket.
 */
const REQUEST_TIMEOUT_MS = 120_000


/** One request inside an async batch; `customId` maps the result back. */
export interface BatchRequest {
  customId: string
  messages: Message[]
  schema?: JsonSchema
  provider?: ProviderRules
}

/** Exactly one of `result` / `error` is set. */
export interface BatchItemResult {
  customId: string
  result?: { id: string; content: string; cost: CallCost; model: string }
  error?: string
}

const BATCH_TERMINAL = new Set(['completed', 'failed', 'expired', 'cancelled'])
/** Default poll cadence; a real batch probe took about six minutes. */
const BATCH_POLL_INTERVAL_MS = 10_000

export interface OpenRouterClientOptions {
  apiKey: string
  fetch?: typeof fetch
  /** Per-request timeout in ms. Default 120_000. */
  timeoutMs?: number
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
  private _timeoutMs: number
  private _trace: Record<string, string> | undefined
  private _extraHeaders: Record<string, string> | undefined
  private _onCall: OpenRouterClientOptions['onCall']

  constructor(opts: OpenRouterClientOptions) {
    if (!opts.apiKey) {
      throw new Error('OPENROUTER_API_KEY is required: pass a non-empty apiKey at construction')
    }
    this._apiKey = opts.apiKey
    this._fetch = opts.fetch ?? globalThis.fetch
    this._timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS
    this._trace = opts.trace
    this._extraHeaders = opts.headers
    this._onCall = opts.onCall
  }

  private _request(url: string, init: RequestInit): Promise<Response> {
    return this._fetch(url, { ...init, signal: AbortSignal.timeout(this._timeoutMs) })
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

    debug('openrouter', `kind=${kind} candidates=[${candidates.join(', ')}] messages=${opts.messages.length}`)
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
        debug(
          'openrouter',
          `model=${response.model} tokens=${cost.tokens} costUsd=${cost.costUsd.toFixed(6)} content_len=${this._extractContent(response).length}`,
        )
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
        const err = e as Error
        debug('openrouter', `candidate ${model} failed: ${err.message}`)
        errors.push(err)
      }
    }

    const prefix = 'OpenRouter completion failed for all candidate models'
    // When every candidate failed for a provider/account reason, keep the
    // class (R15) so the CLI can name it and offer the matching fix.
    const classified = pickProviderError(errors)
    if (classified !== undefined) {
      throw new CliError(classified.code, classified.message, {
        cause: classified,
        ...(classified.retryAfterSeconds !== undefined
          ? { retryAfterSeconds: classified.retryAfterSeconds }
          : {}),
        ...(classified.httpStatus !== undefined ? { httpStatus: classified.httpStatus } : {}),
      })
    }
    throw new Error(`${prefix}: ${errors.map((e) => e.message).join('; ')}`)
  }

  /**
   * Async Batch API: submit every request in one POST, poll until a terminal
   * status, and map the inline results back by `custom_id`. Throws when the
   * batch fails/expires/cancels or the poll deadline passes — callers fall
   * back to realtime. A per-request error is returned, not thrown.
   * `endpoint` and `model` are serialized before `requests`.
   */
  async completeBatch(opts: {
    /** Base slug; a trailing `:batch` variant suffix is stripped. */
    model: string
    requests: BatchRequest[]
    kind?: CallKind
    pollIntervalMs?: number
    /** Total time to wait for a terminal status before throwing. */
    deadlineMs: number
  }): Promise<BatchItemResult[]> {
    const kind = opts.kind ?? 'code'
    const model = opts.model.replace(/:batch$/, '')
    const submit = {
      endpoint: '/v1/chat/completions',
      model,
      requests: opts.requests.map((r) => ({
        custom_id: r.customId,
        body: this._buildBody({
          model,
          messages: r.messages,
          ...(r.schema !== undefined ? { schema: r.schema } : {}),
          ...(r.provider !== undefined ? { provider: r.provider } : {}),
        }),
      })),
    }
    const started = Date.now()
    const post = await this._request('https://openrouter.ai/api/v1/batches', {
      method: 'POST',
      headers: this._requestHeaders(),
      body: JSON.stringify(submit),
    })
    if (!post.ok) {
      throw (
        classifyHttpStatus(post.status, post.headers) ??
        new Error(`OpenRouter batch submit failed: ${post.status} ${post.statusText}`)
      )
    }
    let batch = unwrapBatch(await post.json())
    const id = batch.id
    if (typeof id !== 'string' || id === '') throw new Error('OpenRouter batch submit returned no id')
    const interval = opts.pollIntervalMs ?? BATCH_POLL_INTERVAL_MS
    while (!BATCH_TERMINAL.has(String(batch.status))) {
      if (Date.now() - started + interval > opts.deadlineMs) {
        throw new Error(
          `OpenRouter batch ${id} not finished at the ${Math.round(opts.deadlineMs / 1000)}s poll deadline (status ${String(batch.status)})`,
        )
      }
      await new Promise((r) => setTimeout(r, interval))
      const res = await this._request(`https://openrouter.ai/api/v1/batches/${encodeURIComponent(id)}`, {
        method: 'GET',
        headers: this._requestHeaders(),
      })
      if (!res.ok) {
        throw (
          classifyHttpStatus(res.status, res.headers) ??
          new Error(`OpenRouter batch poll failed: ${res.status} ${res.statusText}`)
        )
      }
      batch = unwrapBatch(await res.json())
    }
    if (batch.status !== 'completed') {
      throw new Error(`OpenRouter batch ${id} ended ${String(batch.status)}`)
    }
    const byId = new Map<string, { response?: unknown; error?: unknown }>()
    for (const row of Array.isArray(batch.results) ? batch.results : []) {
      const r = row as { custom_id?: unknown; response?: unknown; error?: unknown }
      if (typeof r.custom_id === 'string') byId.set(r.custom_id, r)
    }
    return opts.requests.map((req): BatchItemResult => {
      const row = byId.get(req.customId)
      if (row === undefined) return { customId: req.customId, error: 'no result returned for request' }
      if (row.error !== undefined && row.error !== null) {
        const e = row.error as { message?: unknown }
        return { customId: req.customId, error: typeof e.message === 'string' ? e.message : JSON.stringify(row.error) }
      }
      // Tolerate both a bare completion and a {status_code, body} envelope.
      const raw = row.response as { body?: unknown } | undefined
      const response = (raw?.body !== undefined && typeof raw.body === 'object' ? raw.body : raw) as
        | OpenRouterResponse
        | undefined
      if (response === undefined || response.usage === undefined || !Array.isArray(response.choices)) {
        return { customId: req.customId, error: 'malformed batch response' }
      }
      const cost = makeCallCost(response, kind)
      this._onCall?.({
        id: response.id,
        model: response.model,
        kind,
        costUsd: cost.costUsd,
        tokens: cost.tokens,
        ...(this._trace ? { trace: this._trace } : {}),
      })
      return {
        customId: req.customId,
        result: { id: response.id, content: this._extractContent(response), cost, model: response.model },
      }
    })
  }

  async reconcile(id: string): Promise<{ costUsd: number }> {
    const res = await this._request(
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

  private _buildBody(req: {
    model: string
    messages: Message[]
    schema?: JsonSchema
    provider?: ProviderRules
    models?: string[]
  }): Record<string, unknown> {
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
    return body
  }

  private _requestHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this._apiKey}`,
      'Content-Type': 'application/json',
      'X-Title': 'argus-reviewer',
      'X-OpenRouter-Metadata': 'enabled',
      ...(this._extraHeaders ?? {}),
    }
  }

  private async _tryComplete(req: {
    model: string
    messages: Message[]
    schema?: JsonSchema
    provider?: ProviderRules
    models?: string[]
    kind: CallKind
  }): Promise<OpenRouterResponse> {
    const body = this._buildBody(req)

    const headers = this._requestHeaders()

    const res = await this._request('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      throw (
        classifyHttpStatus(res.status, res.headers) ??
        new Error(`OpenRouter request failed: ${res.status} ${res.statusText}`)
      )
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

function unwrapBatch(json: unknown): { id?: unknown; status?: unknown; results?: unknown } {
  const o = (json ?? {}) as { data?: unknown }
  const inner = o.data !== undefined && typeof o.data === 'object' && o.data !== null ? o.data : o
  return inner as { id?: unknown; status?: unknown; results?: unknown }
}
