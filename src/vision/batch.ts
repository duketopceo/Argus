/**
 * OpenRouter Batch API client (async, discounted, no latency guarantee).
 *
 * POST /api/v1/batches with { endpoint, model, requests: [{ custom_id, body }] },
 * then poll GET /api/v1/batches/:id until a terminal status. Results come
 * back inline on the completed batch. Cost is reported once, on the batch
 * `usage`, so the whole batch is metered as one call.
 *
 * Every non-success path throws BatchError with a reason so the caller can
 * fall back to realtime. The poll deadline is a hard bound.
 */
import { debug } from '../debug.js'
import type { ProviderRules } from '../config.js'
import type { CallCost } from './cost.js'
import { responseFormatOf, toApiMessages, type JsonSchema, type Message } from './openrouter.js'

const BATCH_URL = 'https://openrouter.ai/api/v1/batches'
const TERMINAL = new Set(['completed', 'failed', 'expired', 'cancelled'])

/** Default poll deadline: inside the 15 minute review job, leaving room for the realtime fallback. */
export const BATCH_DEADLINE_MS = 8 * 60_000
export const BATCH_POLL_MS = 5_000
const REQUEST_TIMEOUT_MS = 30_000

export type BatchFailure = 'timeout' | 'failed' | 'expired' | 'cancelled' | 'http' | 'malformed'

export class BatchError extends Error {
  constructor(
    readonly reason: BatchFailure,
    message: string,
    readonly batchId?: string,
  ) {
    super(message)
    this.name = 'BatchError'
  }
}

export interface BatchRequest {
  customId: string
  messages: Message[]
  schema?: JsonSchema
  provider?: ProviderRules
}

export interface BatchRunResult {
  batchId: string
  /** custom_id -> assistant content; absent when that request errored. */
  contents: Map<string, string>
  /** custom_ids whose individual request failed. */
  failedIds: string[]
  cost: CallCost
}

export interface BatchRunner {
  run(opts: {
    model: string
    requests: BatchRequest[]
    deadlineMs?: number
    pollMs?: number
  }): Promise<BatchRunResult>
}

export interface BatchClientOptions {
  apiKey: string
  fetch?: typeof fetch
  trace?: Record<string, string>
  headers?: Record<string, string>
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

interface BatchObject {
  id?: string
  status?: string
  usage?: { total_tokens?: number; cost?: number } | null
  results?: {
    custom_id?: string
    response?: { status_code?: number; body?: { choices?: { message?: { content?: unknown } }[] } } | null
    error?: { message?: string } | null
  }[] | null
  error?: { message?: string } | null
  model?: string
}

export class OpenRouterBatchClient implements BatchRunner {
  private _fetch: typeof fetch
  private _sleep: (ms: number) => Promise<void>
  private _now: () => number

  constructor(private opts: BatchClientOptions) {
    if (!opts.apiKey) throw new Error('OPENROUTER_API_KEY is required for batch mode')
    this._fetch = opts.fetch ?? globalThis.fetch
    this._sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this._now = opts.now ?? Date.now
  }

  private _headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.opts.apiKey}`,
      'Content-Type': 'application/json',
      'X-Title': 'argus-reviewer',
      ...(this.opts.headers ?? {}),
    }
  }

  private async _call(url: string, init: RequestInit): Promise<BatchObject> {
    let res: Response
    try {
      res = await this._fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    } catch (e) {
      throw new BatchError('http', `batch request failed: ${(e as Error).message}`)
    }
    if (!res.ok) throw new BatchError('http', `batch request failed: ${res.status} ${res.statusText}`)
    try {
      return (await res.json()) as BatchObject
    } catch {
      throw new BatchError('malformed', 'batch response was not JSON')
    }
  }

  async run(opts: {
    model: string
    requests: BatchRequest[]
    deadlineMs?: number
    pollMs?: number
  }): Promise<BatchRunResult> {
    const deadline = this._now() + (opts.deadlineMs ?? BATCH_DEADLINE_MS)
    const pollMs = opts.pollMs ?? BATCH_POLL_MS
    // Key order matters to the API: endpoint and model serialize before requests.
    const body = JSON.stringify({
      endpoint: '/v1/chat/completions',
      model: opts.model,
      requests: opts.requests.map((r) => ({
        custom_id: r.customId,
        body: {
          model: opts.model,
          messages: toApiMessages(r.messages),
          ...(r.schema !== undefined ? { response_format: responseFormatOf(r.schema) } : {}),
          ...(r.provider !== undefined ? { provider: r.provider } : {}),
          ...(this.opts.trace !== undefined ? { trace: this.opts.trace } : {}),
        },
      })),
    })
    const created = await this._call(BATCH_URL, { method: 'POST', headers: this._headers(), body })
    const id = created.id
    if (typeof id !== 'string' || id === '') throw new BatchError('malformed', 'batch create returned no id')
    debug('batch', `created ${id} status=${created.status} requests=${opts.requests.length}`)

    let batch = created
    while (!TERMINAL.has(batch.status ?? '')) {
      if (this._now() >= deadline) {
        await this._cancel(id)
        throw new BatchError('timeout', `batch ${id} not finished before the poll deadline`, id)
      }
      await this._sleep(pollMs)
      batch = await this._call(`${BATCH_URL}/${encodeURIComponent(id)}`, {
        method: 'GET',
        headers: this._headers(),
      })
    }
    if (batch.status !== 'completed') {
      const detail = batch.error?.message !== undefined ? `: ${batch.error.message}` : ''
      throw new BatchError(batch.status as BatchFailure, `batch ${id} ${batch.status}${detail}`, id)
    }
    if (!Array.isArray(batch.results)) {
      throw new BatchError('malformed', `batch ${id} completed without inline results`, id)
    }
    const contents = new Map<string, string>()
    const failedIds: string[] = []
    for (const r of batch.results) {
      const cid = r.custom_id
      if (typeof cid !== 'string') continue
      const content = r.response?.body?.choices?.[0]?.message?.content
      if (r.error == null && r.response?.status_code === 200 && typeof content === 'string') {
        contents.set(cid, content)
      } else {
        failedIds.push(cid)
      }
    }
    const usage = batch.usage ?? {}
    const cost: CallCost = {
      model: batch.model ?? opts.model,
      provider: 'openrouter-batch',
      tokens: Number(usage.total_tokens) || 0,
      costUsd: Number(usage.cost) || 0,
      kind: 'code',
    }
    return { batchId: id, contents, failedIds, cost }
  }

  /** Best-effort: stop a batch we stopped waiting for so it cannot bill beside the fallback. */
  private async _cancel(id: string): Promise<void> {
    try {
      await this._fetch(`${BATCH_URL}/${encodeURIComponent(id)}/cancel`, {
        method: 'POST',
        headers: this._headers(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (e) {
      debug('batch', `cancel ${id} failed: ${(e as Error).message}`)
    }
  }
}
