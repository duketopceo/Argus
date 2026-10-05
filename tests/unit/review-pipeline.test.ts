import { describe, expect, it } from 'vitest'

import { OpenRouterBatchClient } from '../../src/vision/batch.js'
import { lines, reply, runReview, ScriptedClient } from './review-pipeline.helpers.js'

describe('review scope exclusions', () => {
  it('keeps fixture, golden and dist paths out of the model input and reports it', async () => {
    const client = new ScriptedClient([reply([])])
    const r = await runReview({
      head: {
        'src/a.ts': 'export const a = 1\n',
        'fixtures/manifests/m.json': '{"file":"src/discount.ts"}\n',
        'tests/goldens/comment/g.md': 'src/pager.ts\n',
        'dist/cli.js': 'var x\n',
      },
      client,
    })
    expect(r.code).toBe(0)
    expect(client.prompts).toHaveLength(1)
    expect(client.prompts[0]).toContain('src/a.ts')
    expect(client.prompts[0]).not.toContain('discount.ts')
    expect(client.prompts[0]).not.toContain('pager.ts')
    expect(r.report.scope).toMatchObject({ totalFiles: 4, reviewedFiles: 1, excludedFiles: 3 })
    expect(r.report.summary).toContain('Reviewed 1 of 4 changed files')
  })

  it('config exclude list overrides the defaults', async () => {
    const client = new ScriptedClient([reply([])])
    const r = await runReview({
      head: { 'src/a.ts': 'a\n', 'fixtures/f.json': '{}\n', 'gen/x.ts': 'g\n' },
      client,
      config: { review: { exclude: ['gen/**'] } },
    })
    expect(client.prompts[0]).toContain('fixtures/f.json')
    expect(client.prompts[0]).not.toContain('gen/x.ts')
    expect(r.report.scope.excludedFiles).toBe(1)
  })

  it('skips with a reason when every file is excluded', async () => {
    const client = new ScriptedClient([])
    const r = await runReview({ head: { 'dist/a.js': 'x\n' }, client })
    expect(r.report.skipped).toBe(true)
    expect(r.report.summary).toContain('review.exclude')
  })
})


describe('finding validation', () => {
  it('drops findings outside the diff and reports counts and reasons', async () => {
    const client = new ScriptedClient([
      reply([
        { file: 'src/a.ts', line: 2, severity: 'bug', category: 'correctness', message: 'L2: real' },
        { file: 'src/discount.ts', line: 6, severity: 'bug', category: 'correctness', message: 'L6: ghost' },
        { file: 'src/a.ts', line: 90, severity: 'risk', category: 'correctness', message: 'L90: past eof' },
      ]),
    ])
    const r = await runReview({
      base: { 'src/a.ts': lines(5) },
      head: { 'src/a.ts': lines(5).replace('line 2', 'LINE 2') },
      client,
    })
    expect(r.report.findings.map((x: { message: string }) => x.message)).toEqual(['L2: real'])
    expect(r.report.validation.dropped).toBe(2)
    expect(r.report.validation.byReason).toEqual({ file_not_in_diff: 1, line_outside_diff: 1 })
    expect(r.report.validation.examples).toHaveLength(2)
  })

  it('downgrades the verdict when every blocking finding was dropped', async () => {
    const client = new ScriptedClient([
      reply([{ file: 'src/ghost.ts', line: 1, severity: 'bug', category: 'correctness', message: 'L1: ghost' }]),
    ])
    const r = await runReview({ head: { 'src/a.ts': 'x\n' }, client })
    expect(r.report.findings).toHaveLength(0)
    expect(r.report.verdict).toBe('pass')
  })
})

describe('test-file handling', () => {
  it('caps a test-file bug at nit and lets the verdict follow', async () => {
    const client = new ScriptedClient([
      reply([
        { file: 'tests/a.test.ts', line: 1, severity: 'bug', category: 'correctness', message: 'L1: assertion restates behavior' },
      ]),
    ])
    const r = await runReview({
      head: { 'src/a.ts': 'x\n', 'tests/a.test.ts': 'expect(1).toBe(1)\n' },
      client,
    })
    expect(r.report.findings[0].severity).toBe('nit')
    expect(r.report.verdict).toBe('approve')
    expect(r.report.testFileCapped).toBe(1)
    expect(client.prompts[0]).toContain('assertions describe expected behavior')
  })
})

describe('large PRs', () => {
  const big = (i: number) => ({ [`src/f${i}.ts`]: lines(1500, `f${i}`) })
  const head = Object.assign({}, ...Array.from({ length: 6 }, (_, i) => big(i))) as Record<string, string>

  it('reviews every chunk and says how much was reviewed', async () => {
    const client = new ScriptedClient(Array.from({ length: 20 }, () => reply([], 'pass')))
    const r = await runReview({ head, client })
    expect(r.code).toBe(0)
    expect(client.prompts.length).toBeGreaterThan(2)
    expect(r.report.scope.reviewedFiles).toBe(6)
    expect(r.report.scope.chunks).toBe(r.report.scope.reviewedChunks)
    expect(r.report.summary).toMatch(/Reviewed 6 of 6 changed files \(\d+ of \d+ chunks/)
  })

  it('a failed chunk is disclosed and the rest of the review survives', async () => {
    const probe = new ScriptedClient(Array.from({ length: 20 }, () => reply([], 'pass')))
    await runReview({ head, client: probe })
    const n = probe.prompts.length - 1 // minus synthesis
    const replies: (ReturnType<typeof reply> | Error)[] = []
    for (let i = 0; i < n; i++) {
      replies.push(
        i === 1
          ? new Error('boom')
          : reply([{ file: 'src/f0.ts', line: 1, severity: 'nit', category: 'other', message: 'L1: n' }], 'approve'),
      )
    }
    replies.push(reply([], 'approve'))
    const r = await runReview({ head, client: new ScriptedClient(replies) })
    expect(r.code).toBe(0)
    expect(r.report.scope.failedChunks).toBe(1)
    expect(r.report.scope.reviewedFiles).toBeLessThan(6)
    expect(r.report.summary).toMatch(/Reviewed \d of 6 changed files/)
    expect(r.report.verdict).toBe('needs_changes')
    expect(r.report.ok).toBe(false)
  })

  it('still fails when no chunk could be reviewed', async () => {
    const r = await runReview({ head, client: new ScriptedClient(Array.from({ length: 20 }, () => new Error('down'))) })
    expect(r.code).toBe(1)
  })
})

describe('batch mode', () => {
  const head = { 'src/a.ts': 'export const a = 1\n' }
  const finding = { file: 'src/a.ts', line: 1, severity: 'nit', category: 'other', message: 'L1: n' }

  function batchDeps(script: (c: { url: string; method: string; body?: string }) => { status?: number; json?: unknown }) {
    const calls: { url: string; method: string; body?: string }[] = []
    const fetchFn = (async (url: unknown, init?: RequestInit) => {
      const c = {
        url: String(url),
        method: init?.method ?? 'GET',
        ...(typeof init?.body === 'string' ? { body: init.body } : {}),
      }
      calls.push(c)
      const r = script(c)
      return new Response(JSON.stringify(r.json ?? {}), { status: r.status ?? 200 })
    }) as unknown as typeof fetch
    let t = 0
    return {
      calls,
      deps: {
        createBatchClient: (o: Record<string, unknown>) =>
          new OpenRouterBatchClient({
            ...(o as { apiKey: string }),
            fetch: fetchFn,
            sleep: async (ms: number) => {
              t += ms
            },
            now: () => t,
          }),
      },
    }
  }

  const completed = (text: string) => ({
    json: {
      id: 'b1',
      status: 'completed',
      model: 'batch/model',
      usage: { total_tokens: 500, cost: 0.0042 },
      results: [
        {
          custom_id: 'chunk-0',
          response: { status_code: 200, body: { choices: [{ message: { content: text } }] } },
          error: null,
        },
      ],
    },
  })

  it('realtime is the default: no batch call', async () => {
    const client = new ScriptedClient([reply([])])
    const h = batchDeps(() => ({ status: 500 }))
    await runReview({ head, client, deps: h.deps })
    expect(h.calls).toHaveLength(0)
    expect(client.prompts).toHaveLength(1)
  })

  it('batch mode submits chunks, uses inline results, and meters the batch cost', async () => {
    const client = new ScriptedClient([])
    const h = batchDeps((c) =>
      c.method === 'POST' ? { status: 202, json: { id: 'b1', status: 'validating' } } : completed(JSON.stringify({ summary: 's', verdict: 'approve', findings: [finding] })),
    )
    const r = await runReview({
      head,
      client,
      config: { review: { mode: 'batch', batchModel: 'cheap/batch-model' } },
      deps: h.deps,
    })
    expect(r.code).toBe(0)
    expect(client.prompts).toHaveLength(0)
    expect(JSON.parse(h.calls[0]?.body ?? '{}').model).toBe('cheap/batch-model')
    expect(r.report.findings).toHaveLength(1)
    expect(r.report.visionCostUsd).toBeCloseTo(0.0042)
    expect(r.report.calls).toHaveLength(1)
    expect(r.report.batch).toMatchObject({ batchId: 'b1', model: 'cheap/batch-model', requests: 1 })
    expect(r.report.batch.fallback).toBeUndefined()
  })

  it('--mode batch on the CLI overrides config', async () => {
    const client = new ScriptedClient([])
    const h = batchDeps((c) =>
      c.method === 'POST' ? { json: { id: 'b1', status: 'validating' } } : completed(JSON.stringify({ summary: 's', verdict: 'pass', findings: [] })),
    )
    const r = await runReview({ head, client, args: ['--mode', 'batch'], deps: h.deps })
    expect(h.calls.length).toBeGreaterThan(0)
    expect(r.report.batch.batchId).toBe('b1')
  })

  it('falls back to realtime when the batch fails, and says so', async () => {
    const client = new ScriptedClient([reply([finding], 'approve')])
    const h = batchDeps((c) =>
      c.method === 'POST' ? { json: { id: 'b1', status: 'validating' } } : { json: { id: 'b1', status: 'failed', error: { message: 'nope' } } },
    )
    const r = await runReview({ head, client, config: { review: { mode: 'batch' } }, deps: h.deps })
    expect(r.code).toBe(0)
    expect(client.prompts).toHaveLength(1)
    expect(r.report.batch.fallback).toContain('failed')
    expect(r.report.findings).toHaveLength(1)
  })

  it('falls back to realtime when the poll deadline passes', async () => {
    const client = new ScriptedClient([reply([], 'pass')])
    const h = batchDeps((c) =>
      c.method === 'POST' ? { json: { id: 'b1', status: 'validating' } } : { json: { id: 'b1', status: 'in_progress' } },
    )
    const r = await runReview({ head, client, config: { review: { mode: 'batch' } }, deps: h.deps })
    expect(client.prompts).toHaveLength(1)
    expect(r.report.batch.fallback).toContain('timeout')
    expect(h.calls.some((c) => c.url.endsWith('/cancel'))).toBe(true)
  })

  it('reviews a chunk whose individual batch request errored in realtime', async () => {
    const client = new ScriptedClient([reply([], 'pass')])
    const h = batchDeps((c) =>
      c.method === 'POST'
        ? { json: { id: 'b1', status: 'validating' } }
        : { json: { id: 'b1', status: 'completed', usage: { total_tokens: 1, cost: 0.001 }, results: [{ custom_id: 'chunk-0', response: null, error: { message: 'x' } }] } },
    )
    const r = await runReview({ head, client, config: { review: { mode: 'batch' } }, deps: h.deps })
    expect(client.prompts).toHaveLength(1)
    expect(r.report.batch.fallbackChunks).toBe(1)
  })
})
