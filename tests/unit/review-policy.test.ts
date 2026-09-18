import { describe, expect, it } from 'vitest'

import { parseCodeReview } from '../../src/cli.js'
import {
  resolveBlockSeverities,
  resolveConfig,
  resolveMaxComments,
} from '../../src/config.js'

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
    for (const bad of ['abc', '2.5', '-1', '']) {
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
