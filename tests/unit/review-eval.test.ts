import { describe, expect, it } from 'vitest'

import { metricsFromReport } from '../../scripts/review-eval.mjs'

const report = {
  ok: true,
  skipped: false,
  verdict: 'needs_changes',
  findings: [
    { file: 'src/a.ts', line: 10, severity: 'blocker', message: 'npe' },
    { file: 'src/b.ts', line: 20, severity: 'nit', message: 'rename' },
    { file: 'dist/b.js', line: 5, severity: 'nit', message: 'lint it' },
    { file: 'docs/x.md', line: 1, severity: 'nit', message: 'typo' },
  ],
  reviewComments: [
    { path: 'src/a.ts', line: 10, side: 'RIGHT', body: 'x', dedupKey: 'k' },
    { path: 'src/b.ts', line: 20, side: 'RIGHT', body: 'y', dedupKey: 'l' },
    { path: 'dist/b.js', line: 5, side: 'RIGHT', body: 'z', dedupKey: 'm' },
  ],
  commentsOverflow: 1,
  droppedUnanchored: 2,
  droppedReverted: 1,
}

describe('metricsFromReport', () => {
  it('counts findings, comments, severities and path types', () => {
    const m = metricsFromReport(report)
    expect(m.findings).toBe(4)
    expect(m.comments).toBe(3)
    expect(m.bySeverity.nit).toBe(3)
    expect(m.bySeverity.blocker).toBe(1)
    expect(m.byPathType.src).toBe(2)
    expect(m.byPathType.generated).toBe(1)
    expect(m.byPathType.docs).toBe(1)
    expect(m.generatedPathComments).toBe(1)
    expect(m.nitShare).toBeCloseTo(0.75)
    expect(m.droppedOutsideDiff).toBe(2)
    expect(m.droppedReverted).toBe(1)
  })

  it('scores labels: precision from matched findings, recall from hit labels', () => {
    const labels = [
      { path: 'src/a.ts', fromLine: 8, toLine: 12, valid: true },
      { path: 'src/b.ts', fromLine: 19, toLine: 21, valid: true },
      { path: 'src/c.ts', fromLine: 1, toLine: 5, valid: true }, // missed
      { path: 'dist/b.js', fromLine: 4, toLine: 6, valid: false }, // invalid label: ignored for tp
    ]
    const m = metricsFromReport(report, labels)
    // findings at a.ts:10 and b.ts:20 hit valid labels; dist finding hits
    // an invalid label (not TP); docs finding hits nothing.
    expect(m.tp).toBe(2)
    expect(m.precision).toBeCloseTo(0.5) // 2 of 4 findings
    expect(m.recall).toBeCloseTo(2 / 3) // 2 of 3 valid labels hit
  })

  it('handles zero findings without NaN', () => {
    const m = metricsFromReport({ ...report, findings: [], reviewComments: [] }, [
      { path: 'x', fromLine: 1, toLine: 2, valid: true },
    ])
    expect(m.nitShare).toBe(0)
    expect(m.precision).toBe(0)
    expect(m.recall).toBe(0)
  })
})
