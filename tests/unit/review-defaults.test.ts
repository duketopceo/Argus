import { afterEach, describe, expect, it, vi } from 'vitest'

import { resolveBatchModel, resolveConfig } from '../../src/config.js'
import type { VisionClient } from '../../src/engine/loop.js'
import type { BatchItemResult, BatchRequest } from '../../src/vision/openrouter.js'
import { reply, runReview, ScriptedClient } from './review-pipeline.helpers.js'

const head = { 'src/a.ts': 'export const a = 2\n' }
const base = { 'src/a.ts': 'export const a = 1\n' }

describe('review defaults from the bake-off', () => {
  it('realtime review model defaults to deepseek-v4-flash, batch to v4.1-flash:batch', () => {
    const c = resolveConfig({})
    expect(c.code_model).toBe('deepseek/deepseek-v4-flash')
    expect(c.review.batchModel).toBeUndefined()
    expect(resolveBatchModel(c.code_model ?? c.model, c.review.batchModel)).toBe('deepseek/deepseek-v4.1-flash:batch')
    expect(c.review.requestTimeoutMs).toBe(120_000)
    expect(c.review.mode).toBe('realtime')
    // Safety nets stay on by default.
    expect(c.review.requestChanges).toBe(true)
    expect(c.review.findingThreshold).toBe(1.0)
  })

  it('leaves the vision-lane model default alone', () => {
    expect(resolveConfig({}).model).toBe('google/gemini-2.5-flash-lite')
  })
})

describe('review.requestTimeoutMs config', () => {
  it('accepts a positive integer up to 900000', () => {
    expect(resolveConfig({ review: { requestTimeoutMs: 600_000 } }).review.requestTimeoutMs).toBe(600_000)
    expect(resolveConfig({ review: { requestTimeoutMs: 900_000 } }).review.requestTimeoutMs).toBe(900_000)
  })
  it.each([0, -5, 1.5, 900_001, Number.NaN, '60000' as never])('rejects %s', (bad) => {
    expect(() => resolveConfig({ review: { requestTimeoutMs: bad } })).toThrow(/requestTimeoutMs/)
  })
})

describe('resolveBatchModel', () => {
  it('uses an explicit batchModel verbatim', () => {
    expect(resolveBatchModel('deepseek/deepseek-v4-flash', 'z-ai/glm-5.3:batch')).toBe('z-ai/glm-5.3:batch')
  })
  it('falls back to the default batch slug for a model with no :batch endpoint', () => {
    expect(resolveBatchModel('deepseek/deepseek-v4-flash', undefined)).toBe('deepseek/deepseek-v4.1-flash:batch')
    expect(resolveBatchModel('qwen/qwen3-coder', undefined)).toBe('deepseek/deepseek-v4.1-flash:batch')
    expect(resolveBatchModel('some/unknown-model', undefined)).toBe('deepseek/deepseek-v4.1-flash:batch')
  })
  it('derives <model>:batch only for models known to have one', () => {
    expect(resolveBatchModel('z-ai/glm-5.3', undefined)).toBe('z-ai/glm-5.3:batch')
    expect(resolveBatchModel('openai/gpt-oss-120b', undefined)).toBe('openai/gpt-oss-120b:batch')
    expect(resolveBatchModel('deepseek/deepseek-v4.1-flash', undefined)).toBe('deepseek/deepseek-v4.1-flash:batch')
  })
  it('keeps an already-suffixed model', () => {
    expect(resolveBatchModel('z-ai/glm-5.3:batch', undefined)).toBe('z-ai/glm-5.3:batch')
  })
})

class BatchClient extends ScriptedClient implements VisionClient {
  models: string[] = []
  rtModels: string[] = []
  constructor() {
    super(Array.from({ length: 10 }, () => reply([])))
  }
  override async complete(opts: Parameters<ScriptedClient['complete']>[0]) {
    this.rtModels.push(opts.model)
    return super.complete(opts)
  }
  async completeBatch(opts: { model: string; requests: BatchRequest[] }): Promise<BatchItemResult[]> {
    this.models.push(opts.model)
    return opts.requests.map((r) => ({
      customId: r.customId,
      result: {
        id: r.customId,
        content: reply([]).content,
        cost: { model: 'm', provider: 'p', tokens: 1, costUsd: 0.0001, kind: 'code' },
        model: 'm',
      },
    }))
  }
}

describe('realtime vs batch model selection in code-review', () => {
  it('realtime uses code_model; batch uses a different slug (batchModel default)', async () => {
    const rt = new BatchClient()
    await runReview({ base, head, client: rt })
    expect(rt.rtModels[0]).toBe('deepseek/deepseek-v4-flash')
    expect(rt.models).toHaveLength(0)

    const b = new BatchClient()
    await runReview({ base, head, client: b, args: ['--mode', 'batch'] })
    expect(b.models).toEqual(['deepseek/deepseek-v4.1-flash:batch'])
  })

  it('--batch-model beats ARGUS_BATCH_MODEL beats review.batchModel', async () => {
    const cfg = { review: { batchModel: 'cfg/m:batch' } }
    const a = new BatchClient()
    await runReview({ base, head, client: a, config: cfg, args: ['--mode', 'batch'] })
    expect(a.models).toEqual(['cfg/m:batch'])
    const e = new BatchClient()
    await runReview({ base, head, client: e, config: cfg, args: ['--mode', 'batch'], env: { ARGUS_BATCH_MODEL: 'env/m:batch' } })
    expect(e.models).toEqual(['env/m:batch'])
    const f = new BatchClient()
    await runReview({
      base, head, client: f, config: cfg,
      args: ['--mode', 'batch', '--batch-model', 'flag/m:batch'],
      env: { ARGUS_BATCH_MODEL: 'env/m:batch' },
    })
    expect(f.models).toEqual(['flag/m:batch'])
  })

  it('a pinned code_model with a known :batch endpoint batches on its own slug', async () => {
    const c = new BatchClient()
    await runReview({ base, head, client: c, args: ['--mode', 'batch'], env: { ARGUS_CODE_MODEL: 'z-ai/glm-5.3' } })
    expect(c.models).toEqual(['z-ai/glm-5.3:batch'])
  })
})

describe('request timeout wiring', () => {
  afterEach(() => vi.restoreAllMocks())

  it('passes review.requestTimeoutMs to the config handed to createClient', async () => {
    let seen: number | undefined
    await runReview({
      base, head, client: new ScriptedClient([reply([])]),
      config: { review: { requestTimeoutMs: 300_000 } },
      deps: { createClient: (cfg: { review: { requestTimeoutMs: number } }) => { seen = cfg.review.requestTimeoutMs; return new ScriptedClient([reply([])]) } },
    })
    expect(seen).toBe(300_000)
  })

  it('ARGUS_REQUEST_TIMEOUT_MS overrides config', async () => {
    let seen: number | undefined
    await runReview({
      base, head, client: new ScriptedClient([reply([])]),
      config: { review: { requestTimeoutMs: 300_000 } },
      env: { ARGUS_REQUEST_TIMEOUT_MS: '450000' },
      deps: { createClient: (cfg: { review: { requestTimeoutMs: number } }) => { seen = cfg.review.requestTimeoutMs; return new ScriptedClient([reply([])]) } },
    })
    expect(seen).toBe(450_000)
  })

  it.each(['abc', '0', '-1', '1.5', '900001'])('ARGUS_REQUEST_TIMEOUT_MS=%s is a usage error (exit 2)', async (v) => {
    const r = await runReview({ base, head, client: new ScriptedClient([]), env: { ARGUS_REQUEST_TIMEOUT_MS: v } })
    expect(r.code).toBe(2)
    expect([...r.out, ...r.err].join('\n')).toMatch(/ARGUS_REQUEST_TIMEOUT_MS/)
  })

  it('the real OpenRouter client uses the configured timeout (fetch mocked, no network)', async () => {
    const spy = vi.spyOn(AbortSignal, 'timeout')
    const body = {
      id: 'x', model: 'deepseek/deepseek-v4-flash', provider: 'p',
      choices: [{ message: { content: reply([]).content } }],
      usage: { total_tokens: 5, cost: 0.0001 },
    }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })))
    try {
      const r = await runReview({
        base, head, client: undefined as never,
        config: { review: { requestTimeoutMs: 333_000 } },
        deps: { createClient: undefined },
      })
      expect(r.code).toBe(0)
      expect(spy).toHaveBeenCalledWith(333_000)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
