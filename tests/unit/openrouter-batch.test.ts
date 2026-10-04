import { describe, expect, it } from 'vitest'

import { resolveConfig } from '../../src/config.js'
import { Message, OpenRouterClient } from '../../src/vision/openrouter.js'

const msg: Message = { role: 'user', content: [{ type: 'text', text: 'review this' }] }

const completion = (id: string, cost: number) => ({
  id,
  model: 'deepseek/deepseek-v4.1-flash',
  provider: 'p',
  choices: [{ message: { content: `{"id":"${id}"}` } }],
  usage: { total_tokens: 50, cost, cost_details: { upstream_inference_cost: cost } },
})

interface Call {
  url: string
  method: string
  body: string | undefined
}

function stub(script: Array<{ status?: number; body: unknown }>) {
  const calls: Call[] = []
  let i = 0
  const fn: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push({ url, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? init.body : undefined })
    const next = script[i++]
    if (next === undefined) throw new Error('stub exhausted')
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200 })
  }
  return { fetch: fn, calls }
}

const reqs = [
  { customId: 'chunk-0', messages: [msg] },
  { customId: 'chunk-1', messages: [msg] },
]

describe('OpenRouterClient.completeBatch', () => {
  it('POSTs endpoint and model before requests, using the base slug', async () => {
    const s = stub([
      { body: { id: 'batch_1', status: 'validating' } },
      {
        body: {
          id: 'batch_1',
          status: 'completed',
          results: [
            { custom_id: 'chunk-0', response: completion('a', 0.001) },
            { custom_id: 'chunk-1', response: completion('b', 0.002) },
          ],
        },
      },
    ])
    const c = new OpenRouterClient({ apiKey: 'k', fetch: s.fetch })
    const out = await c.completeBatch({
      model: 'deepseek/deepseek-v4.1-flash:batch',
      requests: reqs,
      kind: 'code',
      pollIntervalMs: 1,
      deadlineMs: 5000,
    })
    const post = s.calls[0] as Call
    expect(post.url).toBe('https://openrouter.ai/api/v1/batches')
    expect(post.method).toBe('POST')
    const keys = Object.keys(JSON.parse(post.body as string))
    expect(keys.indexOf('endpoint')).toBeLessThan(keys.indexOf('requests'))
    expect(keys.indexOf('model')).toBeLessThan(keys.indexOf('requests'))
    const parsed = JSON.parse(post.body as string)
    expect(parsed.endpoint).toBe('/v1/chat/completions')
    expect(parsed.model).toBe('deepseek/deepseek-v4.1-flash')
    expect(parsed.requests.map((r: { custom_id: string }) => r.custom_id)).toEqual(['chunk-0', 'chunk-1'])
    expect(parsed.requests[0].body.messages[0].role).toBe('user')
    expect(s.calls[1]).toMatchObject({ url: 'https://openrouter.ai/api/v1/batches/batch_1', method: 'GET' })
    expect(out.map((o) => o.customId)).toEqual(['chunk-0', 'chunk-1'])
    expect(out[1]?.result?.cost.costUsd).toBe(0.002)
    expect(out[0]?.result?.content).toBe('{"id":"a"}')
  })

  it('polls through in-progress until completed, maps per-request errors', async () => {
    const s = stub([
      { body: { id: 'b2', status: 'validating' } },
      { body: { id: 'b2', status: 'in_progress' } },
      {
        body: {
          id: 'b2',
          status: 'completed',
          results: [
            { custom_id: 'chunk-0', response: completion('a', 0.001) },
            { custom_id: 'chunk-1', error: { message: 'bad request' } },
          ],
        },
      },
    ])
    const c = new OpenRouterClient({ apiKey: 'k', fetch: s.fetch })
    const out = await c.completeBatch({ model: 'm', requests: reqs, pollIntervalMs: 1, deadlineMs: 5000 })
    expect(s.calls).toHaveLength(3)
    expect(out[0]?.result).toBeDefined()
    expect(out[1]?.result).toBeUndefined()
    expect(out[1]?.error).toContain('bad request')
  })

  it.each(['failed', 'expired', 'cancelled'])('throws on terminal status %s', async (status) => {
    const s = stub([{ body: { id: 'b3', status: 'in_progress' } }, { body: { id: 'b3', status, results: [] } }])
    const c = new OpenRouterClient({ apiKey: 'k', fetch: s.fetch })
    await expect(
      c.completeBatch({ model: 'm', requests: reqs, pollIntervalMs: 1, deadlineMs: 5000 }),
    ).rejects.toThrow(new RegExp(status))
  })

  it('throws at the poll deadline when the batch never finishes', async () => {
    const calls: string[] = []
    const fn: typeof fetch = async (input) => {
      calls.push(typeof input === 'string' ? input : 'x')
      return new Response(JSON.stringify({ id: 'b4', status: 'in_progress' }), { status: 200 })
    }
    const c = new OpenRouterClient({ apiKey: 'k', fetch: fn })
    await expect(
      c.completeBatch({ model: 'm', requests: reqs, pollIntervalMs: 5, deadlineMs: 40 }),
    ).rejects.toThrow(/deadline/)
    expect(calls.length).toBeGreaterThan(1)
  })

  it('throws when the submit call is rejected', async () => {
    const s = stub([{ status: 400, body: { error: { message: 'nope' } } }])
    const c = new OpenRouterClient({ apiKey: 'k', fetch: s.fetch })
    await expect(
      c.completeBatch({ model: 'm', requests: reqs, pollIntervalMs: 1, deadlineMs: 5000 }),
    ).rejects.toThrow()
  })

  it('reports a request missing from the results as an error entry', async () => {
    const s = stub([
      { body: { id: 'b5', status: 'completed', results: [{ custom_id: 'chunk-0', response: completion('a', 0.001) }] } },
    ])
    const c = new OpenRouterClient({ apiKey: 'k', fetch: s.fetch })
    const out = await c.completeBatch({ model: 'm', requests: reqs, pollIntervalMs: 1, deadlineMs: 5000 })
    expect(out[1]?.error).toMatch(/no result/)
  })
})

describe('review.mode config', () => {
  it('defaults to realtime and rejects unknown values', () => {
    expect(resolveConfig({}).review.mode).toBe('realtime')
    expect(resolveConfig({ review: { mode: 'batch' } }).review.mode).toBe('batch')
    expect(resolveConfig({ review: { mode: 'bogus' as never } }).review.mode).toBe('realtime')
  })

  it('keeps the batch poll deadline inside the 15-minute job timeout', () => {
    expect(resolveConfig({}).review.batchTimeoutMs).toBe(480_000)
    expect(resolveConfig({ review: { batchTimeoutMs: 60_000 } }).review.batchTimeoutMs).toBe(60_000)
    expect(resolveConfig({ review: { batchTimeoutMs: -1 } }).review.batchTimeoutMs).toBe(480_000)
  })
})
