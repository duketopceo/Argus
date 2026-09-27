import { describe, expect, it } from 'vitest'

import { carryForwardSuggestions, parseCodeReview } from '../../src/cli.js'
import { resolveBlockSeverities, resolveConfig, resolveMaxComments } from '../../src/config.js'

describe('review policy config', () => {
  it('defaults: secretsThreshold 0.3, maxComments 20, severityGate unset', () => {
    const c = resolveConfig({})
    expect(c.review.secretsThreshold).toBe(0.3)
    expect(c.review.maxComments).toBe(20)
    expect(c.review.severityGate).toBeUndefined()
  })

  it('accepts valid values', () => {
    const c = resolveConfig({
      review: { secretsThreshold: 0.7, maxComments: 5, severityGate: 'risk' },
    })
    expect(c.review.secretsThreshold).toBe(0.7)
    expect(c.review.maxComments).toBe(5)
    expect(c.review.severityGate).toBe('risk')
  })

  it('maxComments 0 is valid — inline posting disabled', () => {
    expect(resolveConfig({ review: { maxComments: 0 } }).review.maxComments).toBe(0)
  })

  it('clamps out-of-range secretsThreshold to default', () => {
    for (const bad of [1.5, -0.2, NaN]) {
      expect(resolveConfig({ review: { secretsThreshold: bad } }).review.secretsThreshold).toBe(0.3)
    }
  })

  it('rejects non-integer/negative maxComments', () => {
    for (const bad of [-1, 2.5, NaN]) {
      expect(resolveConfig({ review: { maxComments: bad } }).review.maxComments).toBe(20)
    }
  })

  it('rejects unknown severityGate values', () => {
    for (const bad of ['blocker', 'q', '']) {
      expect(
        resolveConfig({ review: { severityGate: bad as 'bug' } }).review.severityGate,
      ).toBeUndefined()
    }
  })

  it('wrong-typed review block degrades to defaults', () => {
    const c = resolveConfig({ review: 'yes' as unknown as { secretsThreshold: number } })
    expect(c.review.maxComments).toBe(20)
    expect(c.review.secretsThreshold).toBe(0.3)
  })

  it('Jev-lane keys default: triage annotate, findingThreshold 1.0, lowRiskModel unset', () => {
    const c = resolveConfig({})
    expect(c.review.triage).toBe('annotate')
    expect(c.review.findingThreshold).toBe(1.0)
    expect(c.review.lowRiskModel).toBeUndefined()
  })

  it('rejects unknown triage modes — falls back to annotate', () => {
    for (const bad of ['gate', 'skip', '', 3]) {
      expect(resolveConfig({ review: { triage: bad as 'route' } }).review.triage).toBe('annotate')
    }
    expect(resolveConfig({ review: { triage: 'route' } }).review.triage).toBe('route')
    expect(resolveConfig({ review: { triage: 'off' } }).review.triage).toBe('off')
  })

  it('clamps out-of-range findingThreshold to annotate-only 1.0', () => {
    for (const bad of [1.5, -0.2, NaN]) {
      expect(resolveConfig({ review: { findingThreshold: bad } }).review.findingThreshold).toBe(1.0)
    }
    expect(resolveConfig({ review: { findingThreshold: 0.4 } }).review.findingThreshold).toBe(0.4)
  })

  it('empty/non-string lowRiskModel degrades to undefined — no routing tier', () => {
    for (const bad of ['', 7 as unknown as string, undefined]) {
      expect(resolveConfig({ review: { lowRiskModel: bad } }).review.lowRiskModel).toBeUndefined()
    }
    expect(resolveConfig({ review: { lowRiskModel: 'cheap/model' } }).review.lowRiskModel).toBe(
      'cheap/model',
    )
  })
})

describe('resolveBlockSeverities', () => {
  it('unset gate → config.severity list is authoritative', () => {
    const c = resolveConfig({ severity: ['bug', 'risk'] })
    expect(resolveBlockSeverities(c)).toEqual(['bug', 'risk'])
  })

  it('unset gate → defaults to [bug]', () => {
    expect(resolveBlockSeverities(resolveConfig({}))).toEqual(['bug'])
  })

  it("severityGate 'risk' fails on bug|risk regardless of severity list", () => {
    const c = resolveConfig({ severity: [], review: { severityGate: 'risk' } })
    expect(resolveBlockSeverities(c)).toEqual(['bug', 'risk'])
  })

  it("severityGate 'bug' narrows a wider severity list", () => {
    const c = resolveConfig({ severity: ['bug', 'risk'], review: { severityGate: 'bug' } })
    expect(resolveBlockSeverities(c)).toEqual(['bug'])
  })
})

describe('resolveMaxComments', () => {
  it('config cap applies when env unset', () => {
    const c = resolveConfig({ review: { maxComments: 3 } })
    expect(resolveMaxComments({}, c)).toBe(3)
  })

  it('ARGUS_MAX_COMMENTS overrides config', () => {
    const c = resolveConfig({ review: { maxComments: 20 } })
    expect(resolveMaxComments({ ARGUS_MAX_COMMENTS: '3' }, c)).toBe(3)
  })

  it('env 0 disables inline posting', () => {
    expect(resolveMaxComments({ ARGUS_MAX_COMMENTS: '0' }, resolveConfig({}))).toBe(0)
  })

  it('unparseable env falls back to config', () => {
    const c = resolveConfig({ review: { maxComments: 7 } })
    for (const bad of ['abc', '2.5', '-1', '', '0x10', '1e2', 'Infinity']) {
      expect(resolveMaxComments({ ARGUS_MAX_COMMENTS: bad }, c)).toBe(7)
    }
  })
})

describe('finding category normalization', () => {
  const review = (findings: unknown[]) =>
    parseCodeReview(JSON.stringify({ summary: 's', verdict: 'needs_changes', findings }))

  it('keeps a valid category', () => {
    const r = review([
      { file: 'a.ts', line: 1, severity: 'bug', category: 'security', message: 'L1: bug' },
    ])
    expect(r.findings[0].category).toBe('security')
  })

  it('normalizes an unknown category to other', () => {
    const r = review([
      { file: 'a.ts', line: 1, severity: 'risk', category: 'blocker', message: 'L1: risk' },
    ])
    expect(r.findings[0].category).toBe('other')
  })

  it('missing category defaults to other', () => {
    const r = review([{ file: 'a.ts', line: 1, severity: 'nit', message: 'L1: nit' }])
    expect(r.findings[0].category).toBe('other')
  })
})

describe('suggestion bounds', () => {
  const review = (findings: unknown[]) =>
    parseCodeReview(JSON.stringify({ summary: 's', verdict: 'needs_changes', findings }))

  it('keeps a valid suggestion + startLine', () => {
    const r = review([
      {
        file: 'a.ts',
        line: 10,
        severity: 'bug',
        message: 'm',
        suggestion: 'const u = x ?? fallback',
        startLine: 8,
      },
    ])
    expect(r.findings[0].suggestion).toBe('const u = x ?? fallback')
    expect(r.findings[0].startLine).toBe(8)
  })

  it('drops an over-2000-char suggestion, keeps the finding', () => {
    const r = review([
      { file: 'a.ts', line: 10, severity: 'bug', message: 'm', suggestion: 'x'.repeat(2001) },
    ])
    expect(r.findings).toHaveLength(1)
    expect(r.findings[0].suggestion).toBeUndefined()
  })

  it('drops a non-string suggestion, keeps the finding', () => {
    const r = review([
      { file: 'a.ts', line: 10, severity: 'bug', message: 'm', suggestion: 42 },
    ])
    expect(r.findings).toHaveLength(1)
    expect(r.findings[0].suggestion).toBeUndefined()
  })

  it('drops suggestion and startLine for startLine 0 or negative', () => {
    for (const startLine of [0, -3]) {
      const r = review([
        { file: 'a.ts', line: 10, severity: 'bug', message: 'm', suggestion: 's', startLine },
      ])
      expect(r.findings).toHaveLength(1)
      expect(r.findings[0].suggestion).toBeUndefined()
      expect(r.findings[0].startLine).toBeUndefined()
    }
  })

  it('drops both fields when startLine >= line', () => {
    for (const startLine of [10, 11]) {
      const r = review([
        { file: 'a.ts', line: 10, severity: 'bug', message: 'm', suggestion: 's', startLine },
      ])
      expect(r.findings).toHaveLength(1)
      expect(r.findings[0].suggestion).toBeUndefined()
      expect(r.findings[0].startLine).toBeUndefined()
    }
  })

  it('drops both fields when the replaced span exceeds 25 lines', () => {
    const r = review([
      { file: 'a.ts', line: 40, severity: 'bug', message: 'm', suggestion: 's', startLine: 14 },
    ])
    expect(r.findings[0].suggestion).toBeUndefined()
    expect(r.findings[0].startLine).toBeUndefined()
    // Boundary — a span of exactly 25 is kept.
    const ok = review([
      { file: 'a.ts', line: 40, severity: 'bug', message: 'm', suggestion: 's', startLine: 15 },
    ])
    expect(ok.findings[0].suggestion).toBe('s')
    expect(ok.findings[0].startLine).toBe(15)
  })

  it('drops both fields for a non-integer startLine', () => {
    for (const startLine of [2.5, '5']) {
      const r = review([
        { file: 'a.ts', line: 10, severity: 'bug', message: 'm', suggestion: 's', startLine },
      ])
      expect(r.findings[0].suggestion).toBeUndefined()
      expect(r.findings[0].startLine).toBeUndefined()
    }
  })

  it('drops both fields when the finding has no line to anchor the range', () => {
    const r = review([
      { file: 'a.ts', severity: 'bug', message: 'm', suggestion: 's', startLine: 3 },
    ])
    expect(r.findings[0].suggestion).toBeUndefined()
    expect(r.findings[0].startLine).toBeUndefined()
  })

  it('keeps a single-line suggestion with no startLine', () => {
    const r = review([
      { file: 'a.ts', line: 10, severity: 'bug', message: 'm', suggestion: 'x = 1' },
    ])
    expect(r.findings[0].suggestion).toBe('x = 1')
    expect(r.findings[0].startLine).toBeUndefined()
  })

  it('leaves findings without the fields untouched', () => {
    const r = review([{ file: 'a.ts', line: 10, severity: 'bug', message: 'm' }])
    expect(r.findings[0]).toEqual({
      file: 'a.ts',
      line: 10,
      severity: 'bug',
      category: 'other',
      message: 'm',
    })
  })
})

describe('carryForwardSuggestions', () => {
  const originals = [
    {
      file: 'a.ts',
      line: 10,
      severity: 'bug',
      message: 'L10: bug — null deref',
      suggestion: 'const u = x ?? fallback',
      startLine: 9,
    },
    { file: 'b.ts', line: 5, severity: 'nit', message: 'L5: nit — rename', suggestion: 'const n = 0' },
  ]

  it('restores the original suggestion verbatim on a surviving finding', () => {
    const out = carryForwardSuggestions(
      [
        {
          file: 'a.ts',
          line: 10,
          severity: 'bug',
          message: 'L10: bug — null deref',
          suggestion: 'SYNTHESIZED',
          startLine: 1,
        },
      ],
      originals,
    )
    expect(out[0].suggestion).toBe('const u = x ?? fallback')
    expect(out[0].startLine).toBe(9)
  })

  it('matches on whitespace-normalized message', () => {
    const out = carryForwardSuggestions(
      [{ file: 'a.ts', line: 10, severity: 'bug', message: '  L10:  bug — null deref\n' }],
      originals,
    )
    expect(out[0].suggestion).toBe('const u = x ?? fallback')
    expect(out[0].startLine).toBe(9)
  })

  it('drops synthesized suggestion when no pre-image exists', () => {
    const out = carryForwardSuggestions(
      [
        {
          file: 'c.ts',
          line: 3,
          severity: 'bug',
          message: 'L3: new finding',
          suggestion: 'fix()',
          startLine: 2,
        },
      ],
      originals,
    )
    expect(out[0].suggestion).toBeUndefined()
    expect(out[0].startLine).toBeUndefined()
    expect(out[0].message).toBe('L3: new finding')
  })

  it('restores nothing when the matched original had no suggestion', () => {
    const out = carryForwardSuggestions(
      [
        {
          file: 'a.ts',
          line: 10,
          severity: 'bug',
          message: 'L10: bug — null deref',
          suggestion: 'spoofed',
          startLine: 8,
        },
      ],
      [{ file: 'a.ts', line: 10, severity: 'bug', message: 'L10: bug — null deref' }],
    )
    expect(out[0].suggestion).toBeUndefined()
    expect(out[0].startLine).toBeUndefined()
  })

  it('does not match on file+message alone — line must agree', () => {
    const out = carryForwardSuggestions(
      [
        {
          file: 'a.ts',
          line: 11,
          severity: 'bug',
          message: 'L10: bug — null deref',
          suggestion: 'x',
        },
      ],
      originals,
    )
    expect(out[0].suggestion).toBeUndefined()
  })

  it('leaves findings without the fields untouched', () => {
    const out = carryForwardSuggestions(
      [{ file: 'z.ts', line: 1, severity: 'q', message: 'L1: q' }],
      originals,
    )
    expect(out[0]).toEqual({ file: 'z.ts', line: 1, severity: 'q', message: 'L1: q' })
  })
})
