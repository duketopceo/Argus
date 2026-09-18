import { describe, expect, it } from 'vitest'

import { DecisionClient } from '../../src/vision/decisions.js'
import { buildTriageState, routeModel, triagePr } from '../../src/review/triage.js'

const FILES = [
  { filename: 'src/auth/session.ts', patch: '@@ +token check removed' },
  { filename: 'docs/readme.md', patch: '@@ +typo fix' },
]

function jevClient(opts: {
  noul?: number
  score?: number
  choice?: string
  confidence?: number
}): DecisionClient {
  const f = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      questions: Record<string, { type: string }>
    }
    const answers: Record<string, unknown> = {}
    for (const [id, q] of Object.entries(body.questions)) {
      if (q.type === 'noul') answers[id] = { noul: opts.noul ?? 0.9 }
      if (q.type === 'score') answers[id] = { score: opts.score ?? 4 }
      if (q.type === 'choice')
        answers[id] = { choice: opts.choice ?? 'auth', confidence: opts.confidence ?? 0.8 }
    }
    return new Response(
      JSON.stringify({
        answers,
        model: 'typesafe/jev-1.13-20260917',
        usage: { input_tokens: 100, output_tokens: 10, cost: 0.00001 },
      }),
      { status: 200 },
    )
  }) as unknown as typeof fetch
  return new DecisionClient({ apiKey: 'k', fetch: f })
}

function failingClient(): DecisionClient {
  const f = (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch
  return new DecisionClient({ apiKey: 'k', fetch: f })
}

const STATE = buildTriageState({ title: 'fix session', body: 'touches auth', files: FILES })

describe('buildTriageState', () => {
  it('bounds title/body/diff excerpt and lists files', () => {
    const s = buildTriageState({
      title: 'x'.repeat(1000),
      body: 'y'.repeat(5000),
      files: FILES,
    })
    expect(s.title).toHaveLength(300)
    expect(s.body).toHaveLength(2000)
    expect(s.files).toEqual(['src/auth/session.ts', 'docs/readme.md'])
    expect(s.diffExcerpt.length).toBeLessThanOrEqual(12_000)
  })
})

describe('triagePr', () => {
  it('maps typed answers into the triage record', async () => {
    const rec = await triagePr({
      client: jevClient({ noul: 0.87, score: 4, choice: 'auth', confidence: 0.9 }),
      model: 'typesafe/jev-1.13-20260917',
      state: STATE,
      mode: 'annotate',
    })
    expect(rec).toMatchObject({
      mode: 'annotate',
      needsDeepReview: 0.87,
      risk: 4,
      topRiskArea: 'auth',
      topRiskAreaConfidence: 0.9,
      model: 'typesafe/jev-1.13-20260917',
    })
    expect(rec.unadjudicated).toBeUndefined()
  })

  it('degrades open — DecisionError produces an unadjudicated record', async () => {
    const rec = await triagePr({
      client: failingClient(),
      model: 'typesafe/jev-1.13-20260917',
      state: STATE,
      mode: 'route',
    })
    expect(rec.unadjudicated).toBe(true)
    expect(rec.mode).toBe('route')
  })

  it('empty answers → unadjudicated marker', async () => {
    const f = (async () =>
      new Response(
        JSON.stringify({
          answers: {},
          model: 'm',
          usage: { input_tokens: 1, output_tokens: 1, cost: 0 },
        }),
        { status: 200 },
      )) as unknown as typeof fetch
    const rec = await triagePr({
      client: new DecisionClient({ apiKey: 'k', fetch: f }),
      state: STATE,
      mode: 'annotate',
    })
    expect(rec.unadjudicated).toBe(true)
  })
})

describe('routeModel', () => {
  const base = { mode: 'route' as const, model: 'jev' }

  it('routes to lowRiskModel only on a clear low-risk signal', () => {
    const r = routeModel({
      record: { ...base, risk: 2, needsDeepReview: 0.2 },
      configured: 'strong/model',
      lowRiskModel: 'cheap/model',
    })
    expect(r.model).toBe('cheap/model')
  })

  it('keeps configured model on elevated risk or deep-review need', () => {
    for (const partial of [
      { risk: 4, needsDeepReview: 0.2 },
      { risk: 1, needsDeepReview: 0.9 },
      { risk: 3, needsDeepReview: 0.9 },
    ]) {
      const r = routeModel({
        record: { ...base, ...partial },
        configured: 'strong/model',
        lowRiskModel: 'cheap/model',
      })
      expect(r.model).toBe('strong/model')
    }
  })

  it('never routes on ambiguity — annotate mode, unadjudicated, missing fields, no cheap tier', () => {
    for (const rec of [
      { mode: 'annotate' as const, model: 'jev', risk: 1, needsDeepReview: 0.1 },
      { ...base, risk: 1, needsDeepReview: 0.1, unadjudicated: true },
      { ...base, needsDeepReview: 0.1 },
      { ...base, risk: 1 },
    ]) {
      expect(
        routeModel({ record: rec, configured: 'strong/model', lowRiskModel: 'cheap/model' }).model,
      ).toBe('strong/model')
    }
    expect(
      routeModel({
        record: { ...base, risk: 1, needsDeepReview: 0.1 },
        configured: 'strong/model',
        lowRiskModel: undefined,
      }).model,
    ).toBe('strong/model')
  })
})
