import { describe, expect, it } from 'vitest'

import { DecisionClient } from '../../src/vision/decisions.js'
import { adjudicateFindings } from '../../src/review/adjudicate.js'
import { MAX_CANDIDATES } from '../../src/review/secrets.js'

const FINDINGS = [
  { file: 'src/discount.ts', line: 6, severity: 'bug', message: 'L6: 🔴 bug: pct applied twice' },
  { file: 'docs/setup.md', line: 8, severity: 'nit', message: 'L8: 🔵 nit: label the example' },
  { file: 'src/query.ts', line: 12, severity: 'q', message: 'L12: ❓ q: is the index used?' },
]

function jevClient(noulByIdx: number[]): DecisionClient {
  const f = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      questions: Record<string, unknown>
      state: unknown[]
    }
    const answers: Record<string, { noul: number }> = {}
    Object.keys(body.questions).forEach((id) => {
      const idx = parseInt(id.replace('f_', ''), 10)
      answers[id] = { noul: noulByIdx[idx] ?? 0 }
    })
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

describe('adjudicateFindings', () => {
  it('annotate mode (threshold 1.0) keeps every finding and attaches p', async () => {
    const r = await adjudicateFindings({
      findings: FINDINGS,
      threshold: 1.0,
      client: jevClient([0.9, 0.1, 0.05]),
    })
    expect(r.findings).toHaveLength(3)
    expect(r.findings.map((f) => f.p)).toEqual([0.9, 0.1, 0.05])
    expect(r.records.every((rec) => rec.adjudicated && rec.suppressed !== true)).toBe(true)
  })

  it('threshold mode suppresses a low-p nit but never a bug or risk', async () => {
    // p < 1 - 0.8 = 0.2 → the nit (0.1) and q (0.05) suppress; the bug
    // at 0.1 would qualify by score but bug is never suppressible.
    const r = await adjudicateFindings({
      findings: FINDINGS,
      threshold: 0.8,
      client: jevClient([0.1, 0.1, 0.05]),
    })
    expect(r.findings).toHaveLength(1)
    expect(r.findings[0]!.severity).toBe('bug')
    expect(r.records.filter((rec) => rec.suppressed).map((rec) => rec.severity)).toEqual([
      'nit',
      'q',
    ])
    expect(r.records.find((rec) => rec.severity === 'bug')!.suppressed).toBeUndefined()
  })

  it('Jev failure → every finding unadjudicated, none suppressed, p absent', async () => {
    const r = await adjudicateFindings({
      findings: FINDINGS,
      threshold: 0.1, // aggressive threshold still cannot suppress
      client: failingClient(),
    })
    expect(r.unadjudicated).toBe(true)
    expect(r.findings).toHaveLength(3)
    expect(r.findings.every((f) => f.p === undefined)).toBe(true)
    expect(r.records.every((rec) => !rec.adjudicated && rec.suppressed !== true)).toBe(true)
  })

  it('findings past the cap are kept unadjudicated and counted overflow', async () => {
    const many = Array.from({ length: MAX_CANDIDATES + 3 }, (_, i) => ({
      file: `src/f${i}.ts`,
      line: 1,
      severity: 'nit',
      message: `L1: 🔵 nit: finding ${i}`,
    }))
    const r = await adjudicateFindings({
      findings: many,
      threshold: 0.9,
      client: jevClient(new Array(MAX_CANDIDATES).fill(0)),
    })
    expect(r.overflow).toBe(3)
    expect(r.records).toHaveLength(MAX_CANDIDATES)
    // Cap findings suppressed (p=0 < 0.1); the 3 overflow survive untouched.
    expect(r.findings).toHaveLength(3)
    expect(r.findings.every((f) => f.p === undefined)).toBe(true)
  })
})
