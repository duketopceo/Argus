import { describe, expect, it } from 'vitest'

import { buildCodeReviewMessages } from '../../src/cli.js'
import { capPlanDocFindings, isPlanDocPath } from '../../src/review/plandocs.js'

describe('isPlanDocPath', () => {
  it('recognizes plan/spec-type documents', () => {
    for (const p of [
      'docs/plans/x.md',
      'docs/plans/2026-10-27-0015-feat-points-timed-to-speech-plan.md',
      'foo-plan.md',
      'docs/foo-spec.md',
      'docs/specs/a.mdx',
      'docs/rfcs/0001.md',
      'docs/adr/0003-use-x.md',
      'docs/brainstorms/idea.md',
      'proposals/p.md',
      './docs/design/a-design.md',
      'a-rfc.md',
    ]) {
      expect(isPlanDocPath(p), p).toBe(true)
    }
  })

  it('leaves ordinary docs and code alone', () => {
    for (const p of [
      'README.md',
      'CHANGELOG.md',
      'docs/quickstart.md',
      'src/plan.ts',
      'src/plans/x.ts',
      'docs/plans.md',
      'docs/planning-notes.md',
    ]) {
      expect(isPlanDocPath(p), p).toBe(false)
    }
  })
})

describe('capPlanDocFindings', () => {
  const doc = 'docs/plans/x-plan.md'
  const diffFiles = ['src/cli.ts', doc]
  const f = (file: string, severity: string, message: string, extra = {}) => ({
    file,
    line: 1,
    severity,
    message,
    ...extra,
  })

  it('caps bug and risk on plan docs at nit', () => {
    const r = capPlanDocFindings([f(doc, 'bug', 'R6 contradicts R4'), f(doc, 'risk', 'x')], diffFiles)
    expect(r.findings.map((x) => x.severity)).toEqual(['nit', 'nit'])
    expect(r.capped).toBe(2)
  })

  it('leaves nit, q, and non-plan findings alone', () => {
    const r = capPlanDocFindings(
      [f(doc, 'nit', 'a'), f(doc, 'q', 'why'), f('src/cli.ts', 'bug', 'real'), f('README.md', 'bug', 'r')],
      diffFiles,
    )
    expect(r.findings.map((x) => x.severity)).toEqual(['nit', 'q', 'bug', 'bug'])
    expect(r.capped).toBe(0)
  })

  it('keeps severity when reproduced or citing a non-doc diff file', () => {
    const r = capPlanDocFindings(
      [
        f(doc, 'bug', 'src/cli.ts drops the flag the plan requires'),
        f(doc, 'bug', 'fails', { evidence: { status: 'reproduced' } }),
      ],
      diffFiles,
    )
    expect(r.findings.map((x) => x.severity)).toEqual(['bug', 'bug'])
    expect(r.capped).toBe(0)
  })

  it('does not count another plan doc as a code citation', () => {
    const r = capPlanDocFindings(
      [f(doc, 'bug', 'conflicts with docs/specs/other-spec.md')],
      [doc, 'docs/specs/other-spec.md'],
    )
    expect(r.capped).toBe(1)
  })
})

describe('prompt', () => {
  it('tells the reviewer plans describe intended state', () => {
    const text = JSON.stringify(buildCodeReviewMessages('o/r', '1', 'diff'))
    expect(text).toContain('Plans and specs describe intended state')
  })
})
