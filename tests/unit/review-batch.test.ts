import { describe, expect, it } from 'vitest'

import type { VisionClient } from '../../src/engine/loop.js'
import type { CallCost } from '../../src/vision/cost.js'
import type { BatchItemResult, BatchRequest } from '../../src/vision/openrouter.js'
import { reply, runReview, ScriptedClient } from './review-pipeline.helpers.js'

const bigBody = (n: number, tag: string): string =>
  Array.from({ length: n }, (_, i) => `const ${tag}${i} = ${i} // padding padding padding padding`).join('\n') + '\n'

const head: Record<string, string> = {}
for (let i = 0; i < 12; i++) head[`pkg${i % 3}/f${i}.ts`] = bigBody(200, `v${i}`)

const cost = (costUsd: number): CallCost => ({ model: 'm', provider: 'p', tokens: 20, costUsd, kind: 'code' })

class BatchClient extends ScriptedClient implements VisionClient {
  batches: BatchRequest[][] = []
  models: string[] = []
  constructor(
    realtime: ConstructorParameters<typeof ScriptedClient>[0],
    private behave: (reqs: BatchRequest[]) => BatchItemResult[] | Error,
  ) {
    super(realtime)
  }
  async completeBatch(opts: { model: string; requests: BatchRequest[] }): Promise<BatchItemResult[]> {
    this.batches.push(opts.requests)
    this.models.push(opts.model)
    const out = this.behave(opts.requests)
    if (out instanceof Error) throw out
    return out
  }
}

const ok = (customId: string, costUsd = 0.0005): BatchItemResult => ({
  customId,
  result: { id: customId, content: reply([]).content, cost: cost(costUsd), model: 'm' },
})

describe('review.mode', () => {
  it('realtime (default) never touches the batch API', async () => {
    const client = new BatchClient(Array.from({ length: 30 }, () => reply([])), () => new Error('unused'))
    const r = await runReview({ head, client })
    expect(client.batches).toHaveLength(0)
    expect(r.report.batch).toBeUndefined()
  })

  it('batch mode submits every chunk once, meters batch cost, and merges findings', async () => {
    const finding = { file: 'pkg0/f0.ts', line: 1, severity: 'bug', category: 'correctness', message: 'L1: 🔴 bug: x. fix.' }
    const client = new BatchClient([reply([])], (reqs) =>
      reqs.map((q, i) => ({
        customId: q.customId,
        result: {
          id: q.customId,
          content: reply(i === 0 ? [finding] : []).content,
          cost: cost(0.0005),
          model: 'm',
        },
      })),
    )
    const r = await runReview({ head, client, config: { review: { mode: 'batch' } } })
    const n = client.batches[0]?.length ?? 0
    expect(client.batches).toHaveLength(1)
    expect(n).toBeGreaterThan(2)
    // only the synthesis call went realtime
    expect(client.prompts).toHaveLength(1)
    expect(r.report.batch).toMatchObject({ used: true, chunks: n })
    expect(r.report.calls.filter((c: { costUsd: number }) => c.costUsd === 0.0005)).toHaveLength(n)
    expect(r.report.visionCostUsd).toBeCloseTo(n * 0.0005 + 0.001, 6)
    expect(r.report.findings.length).toBeGreaterThan(0)
    expect(r.report.scope.chunksReviewed).toBe(n)
  })

  it('--mode batch on the CLI overrides config, and env overrides config too', async () => {
    const mk = () => new BatchClient([reply([])], (reqs) => reqs.map((q) => ok(q.customId)))
    const a = mk()
    await runReview({ head, client: a, args: ['--mode', 'batch'] })
    expect(a.batches).toHaveLength(1)
    const b = mk()
    await runReview({ head, client: b, env: { ARGUS_REVIEW_MODE: 'batch' } })
    expect(b.batches).toHaveLength(1)
    const c = new BatchClient(Array.from({ length: 30 }, () => reply([])), () => new Error('unused'))
    await runReview({ head, client: c, config: { review: { mode: 'batch' } }, args: ['--mode', 'realtime'] })
    expect(c.batches).toHaveLength(0)
  })

  it('falls back to realtime for every chunk when the batch fails or times out', async () => {
    const client = new BatchClient(Array.from({ length: 30 }, () => reply([])), () => new Error('batch deadline 480s'))
    const r = await runReview({ head, client, config: { review: { mode: 'batch' } } })
    expect(r.code).toBe(0)
    expect(client.batches).toHaveLength(1)
    const n = client.batches[0]?.length ?? 0
    expect(client.prompts.length).toBeGreaterThanOrEqual(n)
    expect(r.report.batch).toMatchObject({ used: false })
    expect(r.report.batch.fellBack).toContain('deadline')
    expect(r.report.scope.chunksReviewed).toBe(n)
    expect(r.err.join('\n')).toContain('falling back to realtime')
  })

  it('re-runs only the chunks whose batch request errored', async () => {
    const client = new BatchClient(Array.from({ length: 30 }, () => reply([])), (reqs) =>
      reqs.map((q, i) => (i === 1 ? { customId: q.customId, error: 'upstream 500' } : ok(q.customId))),
    )
    const r = await runReview({ head, client, config: { review: { mode: 'batch' } } })
    const n = client.batches[0]?.length ?? 0
    // one realtime chunk retry + one synthesis
    expect(client.prompts).toHaveLength(2)
    expect(r.report.batch).toMatchObject({ used: true, chunks: n, retriedRealtime: 1 })
    expect(r.report.scope.chunksReviewed).toBe(n)
  })

  it('a client without batch support degrades to realtime', async () => {
    const client = new ScriptedClient(Array.from({ length: 30 }, () => reply([])))
    const r = await runReview({ head, client, config: { review: { mode: 'batch' } } })
    expect(r.code).toBe(0)
    expect(r.report.batch).toMatchObject({ used: false })
  })
})
