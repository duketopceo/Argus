import { describe, expect, it } from 'vitest'

import { DecisionClient } from '../../src/vision/decisions.js'
import {
  buildTriageState,
  routeModel,
  triageAreaSignal,
  triagePr,
} from '../../src/review/triage.js'

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

  it('caps each file excerpt so one huge patch cannot starve the rest', () => {
    const s = buildTriageState({
      files: [
        { filename: 'a-lock.json', patch: 'x'.repeat(50_000) },
        { filename: 'src/risky.ts', patch: '@@ +dangerous change' },
      ],
    })
    // Without the per-file cap the 50KB first patch would consume the
    // entire 12KB budget and the risky file would contribute nothing.
    expect(s.diffExcerpt).toContain('dangerous change')
    expect(s.diffExcerpt.length).toBeLessThanOrEqual(12_000)
  })

  it('skips patch-less files and reports totalFiles beyond the 100-name cap', () => {
    const s = buildTriageState({
      files: [
        ...Array.from({ length: 150 }, (_, i) => ({ filename: `f${i}.ts` })),
        { filename: 'binary.png' },
      ],
    })
    expect(s.files).toHaveLength(100)
    expect(s.totalFiles).toBe(151)
    expect(s.diffExcerpt).toBe('')
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

  it('salvages valid answers when one is malformed — no all-or-nothing loss', async () => {
    const f = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        questions: Record<string, { type: string }>
      }
      const answers: Record<string, unknown> = {}
      for (const [id, q] of Object.entries(body.questions)) {
        if (q.type === 'noul') answers[id] = { noul: 0.9 }
        if (q.type === 'score') answers[id] = 'not-an-answer-object'
        if (q.type === 'choice') answers[id] = { choice: 'billing', confidence: 0.7 }
      }
      return new Response(
        JSON.stringify({
          answers,
          model: 'm',
          usage: { input_tokens: 1, output_tokens: 1, cost: 0 },
        }),
        { status: 200 },
      )
    }) as unknown as typeof fetch
    const rec = await triagePr({
      client: new DecisionClient({ apiKey: 'k', fetch: f }),
      state: STATE,
      mode: 'annotate',
    })
    // The bad score answer degrades per-question — the good ones survive.
    expect(rec.needsDeepReview).toBe(0.9)
    expect(rec.topRiskArea).toBe('billing')
    expect(rec.risk).toBeUndefined()
    expect(rec.unadjudicated).toBeUndefined()
  })

  it('rejects out-of-rubric score answers — a malformed low score must not route cheap', async () => {
    // Jev legitimately emits fractional rubric positions (e.g. 2.1), so
    // only values outside [1, rubric-levels] — or non-finite — are dropped.
    for (const score of [0, 0.5, -2, 99, NaN]) {
      const rec = await triagePr({
        client: jevClient({ noul: 0.1, score, choice: 'none', confidence: 0.9 }),
        state: STATE,
        mode: 'route',
      })
      expect(rec.risk).toBeUndefined()
    }
    const rec = await triagePr({
      client: jevClient({ noul: 0.1, score: 1.5, choice: 'none', confidence: 0.9 }),
      state: STATE,
      mode: 'route',
    })
    expect(rec.risk).toBe(1.5)
  })

  it('rejects NaN and out-of-range noul answers', async () => {
    for (const noul of [NaN, -0.1, 1.1]) {
      const rec = await triagePr({
        client: jevClient({ noul, score: 4, choice: 'none' }),
        state: STATE,
        mode: 'annotate',
      })
      expect(rec.needsDeepReview).toBeUndefined()
    }
  })
})

describe('routeModel', () => {
  const base = { mode: 'route' as const, model: 'jev', diffExcerptChars: 500 }

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

  it('never downgrades on a title/body-only triage — diff evidence required', () => {
    // PR title/body are fully attacker-controlled text; a "low risk"
    // read with zero diff content must not swap in the cheap model.
    for (const diffExcerptChars of [0, undefined]) {
      expect(
        routeModel({
          record: { mode: 'route', model: 'jev', risk: 1, needsDeepReview: 0.1, diffExcerptChars },
          configured: 'strong/model',
          lowRiskModel: 'cheap/model',
        }).model,
      ).toBe('strong/model')
    }
  })
})

describe('triageAreaSignal', () => {
  it('emits the signal only for a real adjudicated area with confidence', () => {
    expect(
      triageAreaSignal({
        mode: 'annotate',
        model: 'jev',
        topRiskArea: 'billing',
        topRiskAreaConfidence: 0.9,
      }),
    ).toEqual({ area: 'billing', confidence: 0.9 })
  })

  it('suppresses the none sentinel — no meaningful area is not an ordering signal', () => {
    expect(
      triageAreaSignal({
        mode: 'annotate',
        model: 'jev',
        topRiskArea: 'none',
        topRiskAreaConfidence: 0.95,
      }),
    ).toBeUndefined()
  })

  it('suppresses unadjudicated, absent, and confidence-less records', () => {
    expect(triageAreaSignal(undefined)).toBeUndefined()
    expect(
      triageAreaSignal({ mode: 'annotate', model: 'jev', unadjudicated: true }),
    ).toBeUndefined()
    expect(
      triageAreaSignal({ mode: 'annotate', model: 'jev', topRiskArea: 'auth' }),
    ).toBeUndefined()
  })
})
