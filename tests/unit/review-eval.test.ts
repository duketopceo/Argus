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

import { selectPrs, toCorpus } from '../../scripts/aacr-corpus.mjs'

const row = (over) => ({
  project_main_language: 'TypeScript',
  pr_url: 'https://github.com/o/r/pull/1',
  pr_source_commit: 'aaa',
  pr_target_commit: 'bbb',
  pr_change_line_count: '50',
  pr_category: 'x',
  is_ai_comment: 'True',
  note: '',
  path: 'src/a.ts',
  side: 'right',
  source_model: 'm',
  from_line: '10',
  to_line: '12',
  category: 'Logic',
  context: 'line',
  label: 1,
  ...over,
})

describe('selectPrs', () => {
  it('keeps only label=1 right-side rows as labels', () => {
    const rows = [
      row({}),
      row({ label: 0, path: 'src/bad.ts' }),
      row({ side: 'left', path: 'src/old.ts' }),
    ]
    const [pr] = selectPrs(rows)
    expect(pr.labels).toHaveLength(1)
    expect(pr.labels[0].path).toBe('src/a.ts')
    expect(pr.labels[0].valid).toBe(true)
  })

  it('accepts numeric or string labels and drops PRs with no valid labels', () => {
    const rows = [row({ label: 0, pr_url: 'https://github.com/o/r/pull/2' })]
    expect(selectPrs(rows)).toHaveLength(0)
    expect(selectPrs([row({ label: '1' })])).toHaveLength(1)
  })

  it('filters by language and diff size, sorts by diff size, caps count', () => {
    const rows = [
      row({ pr_url: 'https://github.com/o/r/pull/1', pr_change_line_count: '300' }),
      row({ pr_url: 'https://github.com/o/r/pull/2', pr_change_line_count: '10' }),
      row({ pr_url: 'https://github.com/o/r/pull/3', project_main_language: 'C++' }),
    ]
    const prs = selectPrs(rows, { langs: ['TypeScript'], maxLines: 2000, maxPrs: 1 })
    expect(prs).toHaveLength(1)
    expect(prs[0].url).toBe('https://github.com/o/r/pull/2')
    expect(selectPrs(rows, { maxLines: 5 })).toHaveLength(0)
  })

  it('marks file-level labels for path-only matching', () => {
    const [pr] = selectPrs([row({ context: 'File Level' })])
    expect(pr.labels[0].fileLevel).toBe(true)
  })
})

describe('toCorpus', () => {
  it('emits corpus entries with repo URL, commits, labels', () => {
    const [entry] = toCorpus(selectPrs([row({})]))
    expect(entry.name).toBe('aacr-o-r-1')
    expect(entry.repo).toBe('https://github.com/o/r')
    expect(entry.base).toBe('aaa')
    expect(entry.head).toBe('bbb')
    expect(entry.labels[0].fromLine).toBe(10)
  })
})

describe('metricsFromReport labels', () => {
  it('matches fileLevel labels on path alone', () => {
    const m = metricsFromReport(report, [
      { path: 'docs/x.md', fromLine: 0, toLine: 0, valid: true, fileLevel: true },
    ])
    expect(m.tp).toBe(1)
    expect(m.recall).toBe(1)
  })
})
