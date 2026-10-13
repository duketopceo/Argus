import { describe, expect, it } from 'vitest'

import { DecisionClient } from '../../src/vision/decisions.js'
import { reflectFindings } from '../../src/review/reflect.js'
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
      state: { findings: unknown[]; patches: Record<string, string> }
    }
    const answers: Record<string, { noul: number }> = {}
    Object.keys(body.questions).forEach((id) => {
      const idx = parseInt(id.replace('f_', ''), 10)
      answers[id] = { noul: noulByIdx[idx] ?? 1 }
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

describe('reflectFindings', () => {
  it('all-grounded findings survive untouched', async () => {
    const r = await reflectFindings({
      findings: FINDINGS,
      client: jevClient([0.9, 0.8, 0.95]),
    })
    expect(r.findings).toHaveLength(3)
    expect(r.dropped).toBe(0)
    expect(r.records.every((rec) => rec.checked && rec.dropped !== true)).toBe(true)
    expect(r.records.map((rec) => rec.grounded)).toEqual([0.9, 0.8, 0.95])
  })

  it('drops a clearly-ungrounded finding at any severity — bug included', async () => {
    const r = await reflectFindings({
      findings: FINDINGS,
      client: jevClient([0.1, 0.8, 0.9]),
    })
    expect(r.findings).toHaveLength(2)
    expect(r.findings.map((f) => f.severity)).toEqual(['nit', 'q'])
    expect(r.dropped).toBe(1)
    const rec = r.records.find((rec) => rec.severity === 'bug')
    expect(rec!.dropped).toBe(true)
    expect(rec!.message).toContain('pct applied twice')
  })

  it('the floor is exclusive — grounded == 0.3 survives', async () => {
    const r = await reflectFindings({
      findings: FINDINGS.slice(0, 1),
      client: jevClient([0.3]),
    })
    expect(r.findings).toHaveLength(1)
    expect(r.dropped).toBe(0)
  })

  it('custom floor shifts the drop boundary', async () => {
    const r = await reflectFindings({
      findings: FINDINGS,
      floor: 0.9,
      client: jevClient([0.85, 0.8, 0.95]),
    })
    expect(r.findings).toHaveLength(1)
    expect(r.findings[0]!.severity).toBe('q')
    expect(r.dropped).toBe(2)
  })

  it('a missing noul answer keeps the finding, unchecked', async () => {
    // The mock answers every question — simulate a gap with a client that
    // omits f_1 entirely.
    const f = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        questions: Record<string, unknown>
      }
      const answers: Record<string, { noul: number }> = {}
      Object.keys(body.questions).forEach((id) => {
        if (id !== 'f_1') answers[id] = { noul: 0.1 }
      })
      return new Response(
        JSON.stringify({ answers, model: 'm', usage: { input_tokens: 1, output_tokens: 1 } }),
        { status: 200 },
      )
    }) as unknown as typeof fetch
    const r = await reflectFindings({
      findings: FINDINGS,
      client: new DecisionClient({ apiKey: 'k', fetch: f }),
    })
    // f_0 and f_2 grounded at 0.1 -> dropped; f_1 unanswered -> kept.
    expect(r.findings).toHaveLength(1)
    expect(r.findings[0]!.severity).toBe('nit')
    expect(r.records.find((rec) => rec.severity === 'nit')!.checked).toBe(false)
  })

  it('client failure -> unchecked audit, every finding kept', async () => {
    const r = await reflectFindings({
      findings: FINDINGS,
      client: failingClient(),
    })
    expect(r.findings).toHaveLength(3)
    expect(r.dropped).toBe(0)
    expect(r.unchecked).toBe(true)
    expect(r.records.every((rec) => !rec.checked)).toBe(true)
  })

  it('overflow past MAX_CANDIDATES is kept unchecked and counted', async () => {
    const many = Array.from({ length: MAX_CANDIDATES + 3 }, (_, i) => ({
      file: `src/f${i}.ts`,
      line: 1,
      severity: 'nit',
      message: `L1: nit ${i}`,
    }))
    const r = await reflectFindings({
      findings: many,
      client: jevClient(Array.from({ length: MAX_CANDIDATES }, () => 0.9)),
    })
    expect(r.overflow).toBe(3)
    expect(r.records).toHaveLength(MAX_CANDIDATES)
    expect(r.findings).toHaveLength(MAX_CANDIDATES + 3)
  })

  it('sends each file patch once, bounded, keyed by filename', async () => {
    let seenState: { patches: Record<string, string> } | undefined
    const f = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}'))
      seenState = body.state
      const answers: Record<string, { noul: number }> = {}
      Object.keys(body.questions).forEach((id) => (answers[id] = { noul: 0.9 }))
      return new Response(JSON.stringify({ answers, model: 'm' }), { status: 200 })
    }) as unknown as typeof fetch
    const patchByFile = new Map([
      ['src/discount.ts', 'P'.repeat(5000)],
      ['src/query.ts', 'small patch'],
    ])
    await reflectFindings({
      findings: FINDINGS,
      patchByFile,
      client: new DecisionClient({ apiKey: 'k', fetch: f }),
    })
    expect(seenState!.patches['src/discount.ts']).toHaveLength(4000)
    expect(seenState!.patches['src/query.ts']).toBe('small patch')
    expect(seenState!.patches['docs/setup.md']).toBeUndefined()
  })
})
