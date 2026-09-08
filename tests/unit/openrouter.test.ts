import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../../src/config.js'
import { Ledger } from '../../src/vision/ledger.js'
import { Message, OpenRouterClient } from '../../src/vision/openrouter.js'

interface StubCall {
  body: string | undefined
  url: string
}

interface StubResponse {
  status: number
  body?: unknown
}

function makeStubFetch(responses: StubResponse[]) {
  let i = 0
  const calls: StubCall[] = []
  const fn: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const body = typeof init?.body === 'string' ? init.body : undefined
    calls.push({ url, body })
    const resp = responses[i++]
    if (!resp) throw new Error('No more stubbed responses')
    const payload = resp.body ? JSON.stringify(resp.body) : 'error'
    return new Response(payload, { status: resp.status, statusText: 'OK' })
  }
  return { fetch: fn, calls }
}

function okResponse(overrides: { model?: string; cost?: number } = {}) {
  return {
    id: 'gen-123',
    model: overrides.model ?? 'qwen/qwen3.7-flash',
    provider: 'deepinfra',
    choices: [{ message: { content: '{"x":1}' } }],
    usage: {
      total_tokens: 100,
      cost: overrides.cost ?? 0.001,
      cost_details: { upstream_inference_cost: 0.0008 },
    },
  }
}

const sampleMessage: Message = {
  role: 'user',
  content: [{ type: 'text', text: 'find the button' }],
}

describe('OpenRouterClient', () => {
  it('fails fast when OPENROUTER_API_KEY is missing', () => {
    expect(() => new OpenRouterClient({ apiKey: '' })).toThrow(/OPENROUTER_API_KEY is required/)
  })

  it('sends the provider denylist verbatim on the request body', async () => {
    const config = resolveConfig()
    const { fetch: stub, calls } = makeStubFetch([{ status: 200, body: okResponse() }])
    const client = new OpenRouterClient({ apiKey: 'test', fetch: stub })

    await client.complete({
      model: config.model,
      messages: [sampleMessage],
      provider: config.provider,
    })

    const body = JSON.parse(calls[0].body ?? '{}')
    expect(body.provider).toEqual({
      ignore: ['siliconflow', 'novitaai', 'atlascloud', 'streamlake', 'chutes'],
    })
  })

  it('extracts usage.cost and rolls it into the ledger', async () => {
    const { fetch: stub } = makeStubFetch([
      { status: 200, body: okResponse({ cost: 0.012 }) },
      { status: 200, body: okResponse({ cost: 0.009 }) },
    ])
    const client = new OpenRouterClient({ apiKey: 'test', fetch: stub })
    const ledger = new Ledger(undefined)

    const r1 = await client.complete({ model: 'qwen/qwen3.7-flash', messages: [sampleMessage] })
    const r2 = await client.complete({ model: 'qwen/qwen3.7-flash', messages: [sampleMessage] })
    ledger.recordCall(r1.cost)
    ledger.recordCall(r2.cost)

    expect(ledger.visionCostUsd).toBeCloseTo(0.021, 6)
    expect(ledger.calls).toHaveLength(2)
    expect(ledger.calls[0].costUsd).toBe(0.012)
    expect(ledger.calls[1].costUsd).toBe(0.009)
  })

  it('changes the outgoing model and ledger when the config model is swapped', async () => {
    const config = resolveConfig({ model: 'custom/custom-v1' })
    const { fetch: stub, calls } = makeStubFetch([
      { status: 200, body: okResponse({ model: 'custom/custom-v1', cost: 0.003 }) },
    ])
    const client = new OpenRouterClient({ apiKey: 'test', fetch: stub })
    const ledger = new Ledger(undefined)

    const r = await client.complete({
      model: config.model,
      messages: [sampleMessage],
      provider: config.provider,
    })
    ledger.recordCall(r.cost)

    const body = JSON.parse(calls[0].body ?? '{}')
    expect(body.model).toBe('custom/custom-v1')
    expect(r.cost.model).toBe('custom/custom-v1')
    expect(ledger.visionCostUsd).toBe(0.003)
  })

  it('escalates to the fallback model only after the primary model fails', async () => {
    const { fetch: stub, calls } = makeStubFetch([
      { status: 503, body: { error: 'primary unavailable' } },
      { status: 200, body: okResponse({ model: 'moonshotai/kimi-k2.5', cost: 0.005 }) },
    ])
    const client = new OpenRouterClient({ apiKey: 'test', fetch: stub })

    const r = await client.complete({
      model: 'qwen/qwen3.7-flash',
      escalationModels: ['moonshotai/kimi-k2.5'],
      messages: [sampleMessage],
    })

    expect(calls).toHaveLength(2)
    const body1 = JSON.parse(calls[0].body ?? '{}')
    const body2 = JSON.parse(calls[1].body ?? '{}')
    expect(body1.model).toBe('qwen/qwen3.7-flash')
    expect(body1.models).toEqual(['moonshotai/kimi-k2.5'])
    expect(body2.model).toBe('moonshotai/kimi-k2.5')
    expect(r.model).toBe('moonshotai/kimi-k2.5')
    expect(r.cost.model).toBe('moonshotai/kimi-k2.5')
  })

  it('sends image_url parts with text first', async () => {
    const { fetch: stub, calls } = makeStubFetch([{ status: 200, body: okResponse() }])
    const client = new OpenRouterClient({ apiKey: 'test', fetch: stub })

    const imageMessage: Message = {
      role: 'user',
      content: [
        { type: 'image', source: 'abc123' },
        { type: 'text', text: 'describe' },
      ],
    }

    await client.complete({
      model: 'qwen/qwen3.7-flash',
      messages: [imageMessage],
    })

    const body = JSON.parse(calls[0].body ?? '{}')
    const content = body.messages[0].content
    expect(content[0].type).toBe('text')
    expect(content[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/jpeg;base64,abc123' },
    })
  })

  it('sends response_format json_schema when a schema is given', async () => {
    const { fetch: stub, calls } = makeStubFetch([
      { status: 200, body: okResponse({ cost: 0.002 }) },
    ])
    const client = new OpenRouterClient({ apiKey: 'test', fetch: stub })

    await client.complete({
      model: 'qwen/qwen3.7-flash',
      messages: [sampleMessage],
      schema: { name: 'action', schema: { type: 'object', properties: {} } },
    })

    const body = JSON.parse(calls[0].body ?? '{}')
    expect(body.response_format).toEqual({
      type: 'json_schema',
      json_schema: {
        name: 'action',
        schema: { type: 'object', properties: {} },
        strict: true,
      },
    })
  })
})
