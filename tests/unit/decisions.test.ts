import { describe, expect, it } from 'vitest'

import {
  DecisionClient,
  DecisionError,
  JEV_DEFAULT_MODEL,
  type DecisionQuestion,
} from '../../src/vision/decisions.js'

const QUESTIONS: Record<string, DecisionQuestion> = {
  is_live: { type: 'noul', instructions: 'Is this a live credential?' },
  lane: {
    type: 'choice',
    instructions: 'Which lane?',
    criteria: { a: 'lane a', b: 'lane b' },
  },
  rubric: {
    type: 'score',
    instructions: 'How severe?',
    criteria: ['low', 'medium', 'high'],
  },
}

const ANSWERS = {
  is_live: { noul: 0.21 },
  lane: { choice: 'b', probabilities: { a: 0.4, b: 0.6 }, confidence: 0.3 },
  rubric: { score: 2.1, probabilities: [0.1, 0.4, 0.5], confidence: 0.5 },
}

function okResponse(overrides: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      answers: ANSWERS,
      model: 'typesafe/jev-1.13-20260917',
      usage: { input_tokens: 1008, output_tokens: 180, cost: 0.000042336 },
      ...overrides,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

function stubFetch(handler: (body: Record<string, unknown>) => Response | Promise<Response>) {
  let calls = 0
  let lastBody: Record<string, unknown> = {}
  const f = (async (_url: unknown, init?: RequestInit) => {
    calls++
    lastBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    return handler(lastBody)
  }) as unknown as typeof fetch
  return { f, calls: () => calls, lastBody: () => lastBody }
}

describe('DecisionClient', () => {
  it('serializes a batched noul+choice+score request and maps answers by ID', async () => {
    const { f, lastBody } = stubFetch(() => okResponse())
    const client = new DecisionClient({ apiKey: 'k', fetch: f })
    const { answers, model } = await client.decide({ state: { x: 1 }, questions: QUESTIONS })
    const sent = lastBody()
    expect(sent.model).toBe(JEV_DEFAULT_MODEL)
    expect(sent.state).toEqual({ x: 1 })
    expect(sent.questions).toEqual(QUESTIONS)
    expect(answers.is_live).toEqual({ noul: 0.21 })
    expect(answers.lane).toMatchObject({ choice: 'b' })
    expect(answers.rubric).toMatchObject({ score: 2.1 })
    expect(model).toBe('typesafe/jev-1.13-20260917')
  })

  it('records usage as a decide CallCost and fires onCall', async () => {
    const calls: { kind: string; costUsd: number; tokens: number; model: string }[] = []
    const { f } = stubFetch(() => okResponse())
    const client = new DecisionClient({
      apiKey: 'k',
      fetch: f,
      onCall: (c) => calls.push(c),
    })
    const { cost } = await client.decide({ state: 's', questions: QUESTIONS })
    expect(cost.kind).toBe('decide')
    expect(cost.tokens).toBe(1008 + 180)
    expect(cost.costUsd).toBeCloseTo(0.000042336)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ kind: 'decide', model: 'typesafe/jev-1.13-20260917' })
  })

  it('uses the configured model override', async () => {
    const { f, lastBody } = stubFetch(() => okResponse())
    const client = new DecisionClient({ apiKey: 'k', fetch: f })
    await client.decide({ model: '~typesafe/jev-latest', state: 's', questions: QUESTIONS })
    expect(lastBody().model).toBe('~typesafe/jev-latest')
  })

  it('retries once on 429 honoring Retry-After, then succeeds', async () => {
    let n = 0
    const { f, calls } = stubFetch(() => {
      n++
      return n === 1
        ? new Response('rate limited', { status: 429, headers: { 'Retry-After': '0' } })
        : okResponse()
    })
    const client = new DecisionClient({ apiKey: 'k', fetch: f })
    const { answers } = await client.decide({ state: 's', questions: QUESTIONS })
    expect(calls()).toBe(2)
    expect(answers.is_live).toEqual({ noul: 0.21 })
  })

  it('second 429 surfaces rate_limited', async () => {
    const { f, calls } = stubFetch(
      () => new Response('rate limited', { status: 429, headers: { 'Retry-After': '0' } }),
    )
    const client = new DecisionClient({ apiKey: 'k', fetch: f })
    await expect(client.decide({ state: 's', questions: QUESTIONS })).rejects.toMatchObject({
      kind: 'rate_limited',
      retryable: true,
    })
    expect(calls()).toBe(2)
  })

  it('503 surfaces overloaded after one retry', async () => {
    const { f, calls } = stubFetch(() => new Response('nope', { status: 503 }))
    const client = new DecisionClient({ apiKey: 'k', fetch: f })
    await expect(client.decide({ state: 's', questions: QUESTIONS })).rejects.toMatchObject({
      kind: 'overloaded',
    })
    expect(calls()).toBe(2)
  })

  it('401 surfaces auth without retrying', async () => {
    const { f, calls } = stubFetch(() => new Response('denied', { status: 401 }))
    const client = new DecisionClient({ apiKey: 'k', fetch: f })
    await expect(client.decide({ state: 's', questions: QUESTIONS })).rejects.toMatchObject({
      kind: 'auth',
      retryable: false,
    })
    expect(calls()).toBe(1)
  })

  it('abort surfaces timeout after one retry', async () => {
    const f = ((_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_res, rej) => {
        init?.signal?.addEventListener('abort', () => {
          const e = new Error('aborted')
          e.name = 'AbortError'
          rej(e)
        })
      })) as unknown as typeof fetch
    const client = new DecisionClient({ apiKey: 'k', fetch: f, timeoutMs: 5 })
    await expect(client.decide({ state: 's', questions: QUESTIONS })).rejects.toMatchObject({
      kind: 'timeout',
      retryable: true,
    })
  })

  it('a malformed answer is dropped; the valid answers survive', async () => {
    // Per-question salvage: one bad answer must not void the batch —
    // callers degrade open per item (unadjudicated), so the call resolves.
    const { f } = stubFetch(() => okResponse({ answers: { ...ANSWERS, is_live: { noul: 7 } } }))
    const client = new DecisionClient({ apiKey: 'k', fetch: f })
    const { answers } = await client.decide({ state: 's', questions: QUESTIONS })
    expect(answers.is_live).toBeUndefined()
    expect(answers.lane).toMatchObject({ choice: 'b' })
    expect(answers.rubric).toMatchObject({ score: 2.1 })
  })

  it('a question with no answer is simply absent from the result', async () => {
    const { f } = stubFetch(() => okResponse({ answers: { is_live: { noul: 0.5 } } }))
    const client = new DecisionClient({ apiKey: 'k', fetch: f })
    const { answers } = await client.decide({ state: 's', questions: QUESTIONS })
    expect(answers).toEqual({ is_live: { noul: 0.5 } })
  })

  it('a choice answer outside the criteria is dropped', async () => {
    const { f } = stubFetch(() => okResponse({ answers: { ...ANSWERS, lane: { choice: 'z' } } }))
    const client = new DecisionClient({ apiKey: 'k', fetch: f })
    const { answers } = await client.decide({ state: 's', questions: QUESTIONS })
    expect(answers.lane).toBeUndefined()
    expect(answers.is_live).toMatchObject({ noul: 0.21 })
  })

  it('a prototype-chain choice answer is dropped', async () => {
    // 'constructor' in {} is true via the prototype chain — the criteria
    // check must use Object.hasOwn so inherited names are not valid IDs.
    const { f } = stubFetch(() =>
      okResponse({ answers: { ...ANSWERS, lane: { choice: 'constructor' } } }),
    )
    const client = new DecisionClient({ apiKey: 'k', fetch: f })
    const { answers } = await client.decide({ state: 's', questions: QUESTIONS })
    expect(answers.lane).toBeUndefined()
    expect(answers.is_live).toMatchObject({ noul: 0.21 })
  })

  it('local validation throws before any fetch: 0 questions', async () => {
    const { f, calls } = stubFetch(() => okResponse())
    const client = new DecisionClient({ apiKey: 'k', fetch: f })
    await expect(client.decide({ state: 's', questions: {} })).rejects.toBeInstanceOf(DecisionError)
    expect(calls()).toBe(0)
  })

  it('local validation throws before any fetch: >255 choice options', async () => {
    const { f, calls } = stubFetch(() => okResponse())
    const criteria = Object.fromEntries(
      Array.from({ length: 256 }, (_, i) => [`o${i}`, `opt ${i}`]),
    )
    const client = new DecisionClient({ apiKey: 'k', fetch: f })
    await expect(
      client.decide({
        state: 's',
        questions: { q: { type: 'choice', instructions: 'i', criteria } },
      }),
    ).rejects.toMatchObject({ kind: 'validation' })
    expect(calls()).toBe(0)
  })

  it('local validation throws before any fetch: 11-level score', async () => {
    const { f, calls } = stubFetch(() => okResponse())
    const client = new DecisionClient({ apiKey: 'k', fetch: f })
    await expect(
      client.decide({
        state: 's',
        questions: {
          q: {
            type: 'score',
            instructions: 'i',
            criteria: Array.from({ length: 11 }, (_, i) => `${i}`),
          },
        },
      }),
    ).rejects.toMatchObject({ kind: 'validation' })
    expect(calls()).toBe(0)
  })

  it('a single question is a valid call', async () => {
    const { f } = stubFetch(() => okResponse({ answers: { is_live: { noul: 0.03 } } }))
    const client = new DecisionClient({ apiKey: 'k', fetch: f })
    const { answers } = await client.decide({
      state: 's',
      questions: { is_live: QUESTIONS.is_live! },
    })
    expect(answers.is_live).toEqual({ noul: 0.03 })
  })
})
