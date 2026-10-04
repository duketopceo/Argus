import { describe, expect, it } from 'vitest'

// @ts-expect-error plain-node action helper — no type declarations
import { validateBudget } from '../../action/runtime.mjs'
import {
  DEFAULT_BUDGET_USD,
  parseBudgetSetting,
  resolveConfig,
  UNCAPPED_WARNING,
} from '../../src/config.js'
import type { VisionClient } from '../../src/engine/loop.js'
import {
  affordableBatchPrefix,
  estimateRequestCostUsd,
} from '../../src/pipeline/budget.js'
import type { BatchItemResult, BatchRequest } from '../../src/vision/openrouter.js'
import { reply, runReview, ScriptedClient } from './review-pipeline.helpers.js'

describe('default per-run budget cap', () => {
  it('defaults budgetUsd to $1 and codeReviewBudgetUsd follows it', () => {
    expect(DEFAULT_BUDGET_USD).toBe(1)
    const c = resolveConfig({})
    expect(c.budgetUsd).toBe(1)
    expect(c.codeReviewBudgetUsd).toBe(1)
  })

  it('config overrides the default; codeReviewBudgetUsd can differ', () => {
    expect(resolveConfig({ budgetUsd: 5 }).budgetUsd).toBe(5)
    expect(resolveConfig({ budgetUsd: 5 }).codeReviewBudgetUsd).toBe(5)
    const c = resolveConfig({ budgetUsd: 5, codeReviewBudgetUsd: 0.25 })
    expect(c.budgetUsd).toBe(5)
    expect(c.codeReviewBudgetUsd).toBe(0.25)
  })

  it('budgetUsd: 0 is the explicit unlimited switch', () => {
    const c = resolveConfig({ budgetUsd: 0 })
    expect(c.budgetUsd).toBeUndefined()
    expect(c.codeReviewBudgetUsd).toBeUndefined()
    // review-only unlimited
    const r = resolveConfig({ codeReviewBudgetUsd: 0 })
    expect(r.budgetUsd).toBe(1)
    expect(r.codeReviewBudgetUsd).toBeUndefined()
  })

  it('a mis-typed budget degrades to the cap, never to unlimited', () => {
    for (const bad of [-1, Number.NaN, '5' as never, null as never]) {
      expect(resolveConfig({ budgetUsd: bad }).budgetUsd).toBe(1)
    }
  })
})

describe('parseBudgetSetting (env / action input)', () => {
  it('classifies values', () => {
    expect(parseBudgetSetting(undefined)).toEqual({ kind: 'unset' })
    expect(parseBudgetSetting('')).toEqual({ kind: 'unset' })
    expect(parseBudgetSetting('2.5')).toEqual({ kind: 'cap', usd: 2.5 })
    expect(parseBudgetSetting('0')).toEqual({ kind: 'unlimited' })
    expect(parseBudgetSetting('-1')).toEqual({ kind: 'invalid' })
    expect(parseBudgetSetting('abc')).toEqual({ kind: 'invalid' })
  })
  it('action input accepts 0 for unlimited and rejects negatives', () => {
    expect(validateBudget('0')).toBe(0)
    expect(validateBudget('3')).toBe(3)
    expect(() => validateBudget('-1')).toThrow(/non-negative/)
  })
})

const head: Record<string, string> = {}
for (let i = 0; i < 12; i++) {
  head[`pkg${i % 3}/f${i}.ts`] =
    Array.from({ length: 200 }, (_, j) => `const v${i}_${j} = ${j} // padding padding padding`).join('\n') + '\n'
}

describe('code-review budget wiring', () => {
  it('stops realtime chunking at the DEFAULT $1 cap with no config', async () => {
    // each stub call costs $0.4 -> third chunk would project to $1.2 > $1
    class Pricey extends ScriptedClient {
      override async complete(o: Parameters<ScriptedClient['complete']>[0]) {
        const r = await super.complete(o)
        return { ...r, cost: { ...r.cost, costUsd: 0.4 } }
      }
    }
    const client = new Pricey(Array.from({ length: 40 }, () => reply([])))
    const r = await runReview({ head, client })
    expect(client.prompts.length).toBe(2)
    expect(r.report.budgetExceeded).toBe(true)
    expect(r.err.join('\n')).not.toContain(UNCAPPED_WARNING)
  })

  it('ARGUS_BUDGET_USD overrides the default', async () => {
    const client = new ScriptedClient(Array.from({ length: 40 }, () => reply([])))
    const r = await runReview({ head, client, env: { ARGUS_BUDGET_USD: '0.0025' } })
    expect(client.prompts.length).toBe(2)
    expect(r.report.budgetExceeded).toBe(true)
  })

  it('ARGUS_BUDGET_USD=0 runs uncapped and warns loudly', async () => {
    const client = new ScriptedClient(Array.from({ length: 40 }, () => reply([])))
    const r = await runReview({
      head,
      client,
      config: { codeReviewBudgetUsd: 0.0025 },
      env: { ARGUS_BUDGET_USD: '0' },
    })
    expect(client.prompts.length).toBeGreaterThan(3)
    expect(r.report.budgetExceeded).toBe(false)
    expect(r.err.join('\n')).toContain(UNCAPPED_WARNING)
  })

  it('config budgetUsd: 0 warns too', async () => {
    const client = new ScriptedClient(Array.from({ length: 40 }, () => reply([])))
    const r = await runReview({ head, client, config: { budgetUsd: 0 } })
    expect(r.err.join('\n')).toContain(UNCAPPED_WARNING)
  })

  it('invalid ARGUS_BUDGET_USD is ignored and the default cap stays', async () => {
    const client = new ScriptedClient(Array.from({ length: 40 }, () => reply([])))
    const r = await runReview({ head, client, env: { ARGUS_BUDGET_USD: 'nope' } })
    expect(r.err.join('\n')).toContain('ignoring invalid ARGUS_BUDGET_USD')
    expect(r.err.join('\n')).not.toContain(UNCAPPED_WARNING)
  })
})

class BatchClient extends ScriptedClient implements VisionClient {
  submitted: BatchRequest[][] = []
  constructor(private realtimeCostUsd = 0.001) {
    super(Array.from({ length: 40 }, () => reply([])))
  }
  override async complete(o: Parameters<ScriptedClient['complete']>[0]) {
    const r = await super.complete(o)
    return { ...r, cost: { ...r.cost, costUsd: this.realtimeCostUsd } }
  }
  async completeBatch(opts: { model: string; requests: BatchRequest[] }): Promise<BatchItemResult[]> {
    this.submitted.push(opts.requests)
    return opts.requests.map((q) => ({
      customId: q.customId,
      result: {
        id: q.customId,
        content: reply([]).content,
        cost: { model: 'm', provider: 'p', tokens: 1, costUsd: 0.0001, kind: 'code' },
        model: 'm',
      },
    }))
  }
}

describe('batch pre-submit guard', () => {
  it('estimates cost from request size and takes the affordable prefix', () => {
    const req = (n: number): BatchRequest =>
      ({
        customId: 'x',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'a'.repeat(n) }] }],
        schema: {},
      }) as never
    const small = estimateRequestCostUsd(req(400))
    const big = estimateRequestCostUsd(req(40_000))
    expect(big).toBeGreaterThan(small)
    expect(small).toBeGreaterThan(0)
    const reqs = [req(4000), req(4000), req(4000)]
    const each = estimateRequestCostUsd(reqs[0] as BatchRequest)
    expect(affordableBatchPrefix(reqs, undefined, 0)).toBe(3)
    expect(affordableBatchPrefix(reqs, 1, 0)).toBe(3)
    expect(affordableBatchPrefix(reqs, each * 2.5, 0)).toBe(2)
    expect(affordableBatchPrefix(reqs, each * 2.5, each)).toBe(1)
    expect(affordableBatchPrefix(reqs, each * 0.5, 0)).toBe(0)
  })

  it('submits every chunk when the default cap covers the estimate', async () => {
    const client = new BatchClient()
    const r = await runReview({ head, client, config: { review: { mode: 'batch' } } })
    expect(client.submitted).toHaveLength(1)
    expect(client.submitted[0]?.length).toBe(r.report.scope.chunksTotal)
  })

  it('never submits a batch whose projected cost exceeds the cap', async () => {
    const client = new BatchClient()
    const r = await runReview({
      head,
      client,
      config: { review: { mode: 'batch' }, codeReviewBudgetUsd: 0.00001 },
    })
    expect(client.submitted).toHaveLength(0)
    expect(r.err.join('\n')).toMatch(/batch skipped: projected cost/)
    expect(r.report.batch).toMatchObject({ used: false })
  })

  it('submits only the affordable prefix; the rest is realtime-gated', async () => {
    const probe = new BatchClient()
    await runReview({ head, client: probe, config: { review: { mode: 'batch' } } })
    const all = probe.submitted[0] as BatchRequest[]
    const per = estimateRequestCostUsd(all[0] as BatchRequest)
    // realtime chunks are pricey: the first one blows the cap, so the
    // second leftover chunk must be refused by the per-chunk gate.
    const client = new BatchClient(per * 10)
    const r = await runReview({
      head,
      client,
      config: { review: { mode: 'batch' }, codeReviewBudgetUsd: per * 2.5 },
    })
    expect(client.submitted[0]?.length).toBe(2)
    expect(all.length).toBeGreaterThanOrEqual(4)
    expect(client.prompts.length).toBe(1)
    expect(r.report.budgetExceeded).toBe(true)
  })
})
