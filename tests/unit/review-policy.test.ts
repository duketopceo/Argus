import { describe, expect, it } from 'vitest'

import {
  carryForwardSuggestions,
  computeReviewEvent,
  P_TRUE_POSITIVE_THRESHOLD,
  parseCodeReview,
  renderReviewComments,
  type ReviewFinding,
} from '../../src/cli.js'
import {
  INLINE_SENTINEL,
  inlineDedupKey,
  normalizeFindingMessage,
  parseInlineBody,
} from '../../src/review/inline.js'
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

  it('requestChanges defaults true — only literal false opts out', () => {
    expect(resolveConfig({}).review.requestChanges).toBe(true)
    expect(resolveConfig({ review: { requestChanges: false } }).review.requestChanges).toBe(false)
    for (const bad of ['no', 0, '', undefined]) {
      expect(
        resolveConfig({ review: { requestChanges: bad as unknown as boolean } }).review
          .requestChanges,
      ).toBe(true)
    }
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

describe('computeReviewEvent', () => {
  const block = ['bug']
  const finding = (over: Partial<ReviewFinding> = {}): ReviewFinding => ({
    file: 'a.ts',
    line: 1,
    severity: 'bug',
    message: 'L1: bug: boom',
    ...over,
  })

  it('requests changes for a blocker at/above the true-positive gate', () => {
    const r = computeReviewEvent([finding({ p: 0.9 })], block, true)
    expect(r.reviewEvent).toBe('request_changes')
    expect(r.highConfidenceBlockers).toBe(1)
    expect(r.provenBlockers).toBe(0)
  })

  it('boundary: p exactly at the threshold escalates', () => {
    const r = computeReviewEvent([finding({ p: P_TRUE_POSITIVE_THRESHOLD })], block, true)
    expect(r.reviewEvent).toBe('request_changes')
  })

  it('comments when p is below the gate', () => {
    const r = computeReviewEvent([finding({ p: 0.4 })], block, true)
    expect(r.reviewEvent).toBe('comment')
    expect(r.highConfidenceBlockers).toBe(0)
  })

  it('requests changes for a reproduced blocker with no p', () => {
    const r = computeReviewEvent(
      [finding({ evidence: { status: 'reproduced', detail: 'probe failed on head' } })],
      block,
      true,
    )
    expect(r.reviewEvent).toBe('request_changes')
    expect(r.provenBlockers).toBe(1)
    expect(r.highConfidenceBlockers).toBe(0)
  })

  it('ignores confident findings whose severity is not blocking', () => {
    const r = computeReviewEvent([finding({ severity: 'nit', p: 1.0 })], block, true)
    expect(r.reviewEvent).toBe('comment')
    expect(r.highConfidenceBlockers).toBe(0)
    const r2 = computeReviewEvent([finding({ severity: 'nit', p: 1.0 })], ['bug', 'nit'], true)
    expect(r2.reviewEvent).toBe('request_changes')
  })

  it('allowRequestChanges=false always comments — counts stay honest', () => {
    const r = computeReviewEvent(
      [finding({ p: 0.99, evidence: { status: 'reproduced', detail: 'd' } })],
      block,
      false,
    )
    expect(r.reviewEvent).toBe('comment')
    expect(r.provenBlockers).toBe(1)
    expect(r.highConfidenceBlockers).toBe(1)
  })

  it('unadjudicated blocker (no p, not reproduced) never escalates', () => {
    const r = computeReviewEvent([finding({})], block, true)
    expect(r.reviewEvent).toBe('comment')
  })

  it('non-reproduced evidence statuses do not escalate', () => {
    for (const status of ['exercised', 'corroborated', 'not_exercised', 'inconclusive'] as const) {
      const r = computeReviewEvent(
        [finding({ evidence: { status, detail: 'd' } })],
        block,
        true,
      )
      expect(r.reviewEvent).toBe('comment')
      expect(r.provenBlockers).toBe(0)
    }
  })

  it('secrets-style finding with carried p=0.9 + bug severity escalates', () => {
    const r = computeReviewEvent([finding({ category: 'security', p: 0.9 })], block, true)
    expect(r.reviewEvent).toBe('request_changes')
  })

  it('a reproduced AND confident blocker counts in both buckets', () => {
    const r = computeReviewEvent(
      [finding({ p: 0.9, evidence: { status: 'reproduced', detail: 'd' } })],
      block,
      true,
    )
    expect(r.reviewEvent).toBe('request_changes')
    expect(r.provenBlockers).toBe(1)
    expect(r.highConfidenceBlockers).toBe(1)
  })

  it('empty findings → comment with zero counts', () => {
    expect(computeReviewEvent([], block, true)).toEqual({
      reviewEvent: 'comment',
      provenBlockers: 0,
      highConfidenceBlockers: 0,
    })
  })
})

describe('renderReviewComments', () => {
  const finding = (over: Partial<ReviewFinding> = {}): ReviewFinding => ({
    file: 'a.ts',
    line: 1,
    severity: 'bug',
    message: 'L1: bug: boom',
    ...over,
  })

  it('sorts bug>risk>nit>q before slicing at the cap', () => {
    const { comments, overflow } = renderReviewComments(
      [
        finding({ severity: 'nit', line: 3, message: 'n' }),
        finding({ severity: 'bug', line: 1, message: 'b1' }),
        finding({ severity: 'q', line: 5, message: 'q' }),
        finding({ severity: 'risk', line: 2, message: 'r' }),
        finding({ severity: 'bug', line: 4, message: 'b2' }),
      ],
      3,
    )
    expect(comments.map((c) => c.line)).toEqual([1, 4, 2])
    expect(overflow).toBe(2)
  })

  it('excludes file:"-", empty file, and non-positive/non-integer lines', () => {
    const { comments, overflow } = renderReviewComments(
      [
        finding({ file: '-', line: 0 }),
        finding({ file: '', line: 3 }),
        finding({ file: 'a.ts', line: 0 }),
        finding({ file: 'a.ts', line: -2 }),
        finding({ file: 'a.ts', line: 2.5 }),
        { file: 'a.ts', severity: 'bug', message: 'no line' },
        finding({ file: 'ok.ts', line: 7 }),
      ],
      20,
    )
    expect(comments).toHaveLength(1)
    expect(comments[0].path).toBe('ok.ts')
    expect(overflow).toBe(0)
  })

  it('cap 0 posts nothing and counts all eligible as overflow', () => {
    const r = renderReviewComments([finding({}), finding({ line: 2 })], 0)
    expect(r.comments).toHaveLength(0)
    expect(r.overflow).toBe(2)
  })

  it('empty findings → no comments, no overflow', () => {
    expect(renderReviewComments([], 20)).toEqual({ comments: [], overflow: 0 })
  })

  it('fences a suggestion past its longest backtick run', () => {
    const { comments } = renderReviewComments(
      [finding({ suggestion: 'x = 1\n````\ny = 2' })],
      20,
    )
    const m = /(`{4,})suggestion\n/.exec(comments[0].body)
    expect(m?.[1].length).toBeGreaterThanOrEqual(5)
    expect(comments[0].body).toContain(`\n${m?.[1]}\n`)
    expect(comments[0].body).toContain('review before committing')
  })

  it('no disclaimer on comments without a suggestion', () => {
    const { comments } = renderReviewComments([finding({})], 20)
    expect(comments[0].body).not.toContain('suggestion')
    expect(comments[0].body).not.toContain('review before committing')
  })

  it('neutralizes fences, @mentions, and newlines in the message', () => {
    const { comments } = renderReviewComments(
      [finding({ message: 'first\n```suggestion\nrm -rf /\n```\nping @user now' })],
      20,
    )
    const messageLine = comments[0].body.split('\n')[2]
    expect(comments[0].body.split('\n')[1]).toBe('◆ **bug** · ▰▱▱▱ suspected')
    expect(messageLine).not.toMatch(/```|~~~/)
    expect(messageLine).not.toContain('@user')
    expect(messageLine).toContain('first')
    expect(messageLine).toContain('rm -rf /')
  })

  it('multi-line suggestion sets start_line/start_side only when startLine < line', () => {
    const [c] = renderReviewComments(
      [finding({ line: 5, startLine: 3, suggestion: 'fixed()' })],
      20,
    ).comments
    expect(c.start_line).toBe(3)
    expect(c.start_side).toBe('RIGHT')
    expect(c.side).toBe('RIGHT')
    // startLine == line → single-line comment, no start fields.
    const [single] = renderReviewComments(
      [finding({ line: 5, startLine: 5, suggestion: 'fixed()' })],
      20,
    ).comments
    expect(single.start_line).toBeUndefined()
    expect(single.start_side).toBeUndefined()
  })

  it('dedupKey changes when only the suggestion changes; stable otherwise', () => {
    const a = renderReviewComments([finding({ suggestion: 'x = 1' })], 20).comments[0]
    const b = renderReviewComments([finding({ suggestion: 'x = 2' })], 20).comments[0]
    const c = renderReviewComments([finding({ suggestion: 'x = 1' })], 20).comments[0]
    const d = renderReviewComments([finding({})], 20).comments[0]
    expect(a.dedupKey).not.toBe(b.dedupKey)
    expect(a.dedupKey).toBe(c.dedupKey)
    expect(a.dedupKey).not.toBe(d.dedupKey)
    expect(a.dedupKey).toMatch(/^a\.ts:1:bug:boom:[0-9a-f]{8}$/)
  })

  it('marks a reproduced finding with the probe line', () => {
    const { comments } = renderReviewComments(
      [finding({ evidence: { status: 'reproduced', detail: 'd' } })],
      20,
    )
    expect(comments[0].body).toContain('Reproduced by an Argus probe')
  })
})

describe('Ocellus inline comments (U6, R7, KTD4)', () => {
  const finding = (over: Partial<ReviewFinding> = {}): ReviewFinding => ({
    file: 'src/user.ts',
    line: 42,
    severity: 'bug',
    category: 'correctness',
    message: 'L42: 🔴 bug: `user` can be null. Add guard.',
    ...over,
  })
  const render = (f: ReviewFinding) => renderReviewComments([f], 20).comments[0]!

  it('renders severity line, message line and suggestion fence with no tool prefix', () => {
    const c = render(
      finding({ evidence: { status: 'reproduced', detail: 'probe failed on head' }, suggestion: 'if (!user) return' }),
    )
    const lines = c.body.split('\n')
    expect(lines[0]).toBe(INLINE_SENTINEL)
    expect(lines[1]).toBe('◆ **bug** · ▰▰▰▰ reproduced')
    expect(lines[2]).toBe('`user` can be null. Add guard.')
    expect(c.body).toContain('\n\n````suggestion\nif (!user) return\n````\n')
    expect(c.body).not.toContain('argus-reviewer bug')
    expect(c.body).not.toMatch(/\*\*argus-reviewer/)
    expect(c.body).not.toMatch(/\p{Extended_Pictographic}/u)
    expect(c.body).not.toContain('—')
    // Exactly one evidence line, after the suggestion.
    expect(c.body.match(/Reproduced by an Argus probe/g)).toHaveLength(1)
    expect(c.body.indexOf('Reproduced by')).toBeGreaterThan(c.body.indexOf('````\n'))
  })

  it('renders a question with its word, and an unknown severity without a glyph', () => {
    expect(render(finding({ severity: 'q' })).body.split('\n')[1]).toBe('□ **question** · ▰▱▱▱ suspected')
    expect(render(finding({ severity: 'critical' })).body.split('\n')[1]).toBe('**critical** · ▰▱▱▱ suspected')
  })

  it('adds no evidence line when the evidence is not proof', () => {
    for (const status of ['inconclusive', 'not_exercised', 'exercised'] as const) {
      const c = render(finding({ evidence: { status, detail: 'no repo index, run `argus-reviewer index` first' } }))
      expect(c.body).not.toContain('repo index')
      expect(c.body.split('\n')).toHaveLength(3)
    }
    const corroborated = render(finding({ evidence: { status: 'corroborated', detail: 'test check `unit` failed on this head' } }))
    expect(corroborated.body.split('\n')[1]).toBe('◆ **bug** · ▰▰▱▱ corroborated')
    expect(corroborated.body).toContain('CI evidence: test check `unit` failed on this head')
  })

  it('never starts the message line with L<n>: or a severity emoji', () => {
    for (const message of [
      'L42: 🔴 bug: boom',
      'L88-140: 🔵 nit: long fn',
      '🟡 risk: L23: no retry',
      '❓ q: why?',
      '❓️ q: variation selector',
      'L3: plain',
    ]) {
      const line = render(finding({ message })).body.split('\n')[2]!
      expect(line).not.toMatch(/^L\d+/)
      expect(line).not.toMatch(/^\p{Extended_Pictographic}/u)
      expect(line).not.toMatch(/^(bug|risk|nit|q):/)
      expect(line).not.toBe('')
    }
  })

  it('two findings on the same line with different messages get different keys', () => {
    const { comments } = renderReviewComments(
      [finding({ message: 'L42: 🔴 bug: null deref.' }), finding({ message: 'L42: 🔴 bug: off by one.' })],
      20,
    )
    expect(comments[0]!.dedupKey).not.toBe(comments[1]!.dedupKey)
  })

  it('a changed suggestion on the same finding changes the key', () => {
    expect(render(finding({ suggestion: 'a()' })).dedupKey).not.toBe(render(finding({ suggestion: 'b()' })).dedupKey)
  })

  it('legacy-to-new: an already-posted legacy comment yields the same key (no re-post after upgrade)', () => {
    // The body the pre-U6 renderer posted for this exact finding.
    const legacy = '**argus-reviewer bug:** L42: 🔴 bug: `user` can be null. Add guard. `correctness`'
    const fresh = render(finding({}))
    expect(inlineDedupKey('src/user.ts', 42, legacy)).toBe(fresh.dedupKey)
    expect(fresh.dedupKey).toBe('src/user.ts:42:bug:`user` can be null. Add guard.:' + fresh.dedupKey.slice(-8))

    // With evidence and a suggestion, as the legacy renderer laid them out.
    const legacyFull =
      '**argus-reviewer bug:** L42: 🔴 bug: `user` can be null. Add guard. `correctness`\n\n' +
      '*🧪 Reproduced by an Argus probe — fails on this PR head, clean on base. See workflow artifacts.*\n\n' +
      '````suggestion\nif (!user) return\n````\n\n' +
      '*Suggested change — review before committing.*'
    const freshFull = render(
      finding({ evidence: { status: 'reproduced', detail: 'd' }, suggestion: 'if (!user) return' }),
    )
    expect(inlineDedupKey('src/user.ts', 42, legacyFull)).toBe(freshFull.dedupKey)

    // A legacy question used the `q` keyword; the new body says "question".
    const legacyQ = '**argus-reviewer q:** L42: ❓ q: why is this sync? `other`'
    const freshQ = render(finding({ severity: 'q', category: 'other', message: 'L42: ❓ q: why is this sync?' }))
    expect(inlineDedupKey('src/user.ts', 42, legacyQ)).toBe(freshQ.dedupKey)
  })

  it('the serialized key is the key the poster reconstructs from the posted body', () => {
    const c = render(finding({ suggestion: 'x()' }))
    expect(inlineDedupKey(c.path, c.line, c.body)).toBe(c.dedupKey)
  })

  it('parses both formats and rejects bodies that are not Argus comments', () => {
    expect(parseInlineBody('**argus-reviewer risk:** L1: 🟡 risk: slow `performance`')).toEqual({
      severity: 'risk',
      message: 'slow',
    })
    expect(parseInlineBody(`${INLINE_SENTINEL}\n◈ **risk** · ▰▱▱▱ suspected\nslow`)).toEqual({
      severity: 'risk',
      message: 'slow',
    })
    expect(parseInlineBody('◆ **bug** · ▰▰▰▰ reproduced\nhuman quoting the format')).toBeUndefined()
    expect(parseInlineBody('> **argus-reviewer bug:** quoted')).toBeUndefined()
  })

  it('normalizeFindingMessage strips the model prefix and keeps the sentence', () => {
    expect(normalizeFindingMessage('L42: 🔴 bug: `user` can be null.')).toBe('`user` can be null.')
    expect(normalizeFindingMessage('L88-140: 🔵 nit: x')).toBe('x')
    expect(normalizeFindingMessage('plain sentence')).toBe('plain sentence')
  })
})

describe('severity parsing stays emoji-aware (R4 input path)', () => {
  const sev = (message: string) =>
    parseCodeReview(JSON.stringify({ verdict: 'needs_changes', findings: [{ file: 'a.ts', line: 1, message }] }))
      .findings[0]!.severity
  it('deriveSeverity still reads emoji and keywords out of model output', () => {
    expect(sev('L1: 🔴 something')).toBe('bug')
    expect(sev('L1: 🟡 something')).toBe('risk')
    expect(sev('L1: 🔵 something')).toBe('nit')
    expect(sev('L1: ❓ something')).toBe('q')
    expect(sev('L1: risk: something')).toBe('risk')
  })
})
