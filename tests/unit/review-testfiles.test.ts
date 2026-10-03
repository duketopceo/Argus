import { describe, expect, it } from 'vitest'

import { buildCodeReviewMessages } from '../../src/cli.js'
import { capTestFindings, isTestPath } from '../../src/review/testfiles.js'

describe('isTestPath', () => {
  it('recognizes common test locations and names', () => {
    for (const p of [
      'tests/unit/a.ts',
      'src/__tests__/a.ts',
      'src/a.test.ts',
      'src/a.spec.js',
      'pkg/a_test.go',
      'tests/test_a.py',
      'e2e/flow.ts',
    ]) {
      expect(isTestPath(p), p).toBe(true)
    }
    for (const p of ['src/cli.ts', 'src/contest.ts', 'docs/testing.md']) {
      expect(isTestPath(p), p).toBe(false)
    }
  })
})

describe('capTestFindings', () => {
  const diffFiles = ['src/cli.ts', 'tests/unit/a.test.ts']
  const f = (file: string, severity: string, message: string, extra = {}) => ({
    file,
    line: 1,
    severity,
    message,
    ...extra,
  })

  it('caps bug and risk on test files at nit', () => {
    const r = capTestFindings(
      [f('tests/unit/a.test.ts', 'bug', 'assertion is wrong'), f('tests/unit/a.test.ts', 'risk', 'x')],
      diffFiles,
    )
    expect(r.findings.map((x) => x.severity)).toEqual(['nit', 'nit'])
    expect(r.capped).toBe(2)
  })

  it('leaves nit, q, and non-test findings alone', () => {
    const r = capTestFindings(
      [f('tests/unit/a.test.ts', 'q', 'why'), f('src/cli.ts', 'bug', 'real')],
      diffFiles,
    )
    expect(r.findings.map((x) => x.severity)).toEqual(['q', 'bug'])
    expect(r.capped).toBe(0)
  })

  it('keeps severity when the finding cites a non-test file or is reproduced', () => {
    const r = capTestFindings(
      [
        f('tests/unit/a.test.ts', 'bug', 'src/cli.ts drops the flag; test hides it'),
        f('tests/unit/a.test.ts', 'bug', 'fails', { evidence: { status: 'reproduced' } }),
      ],
      diffFiles,
    )
    expect(r.findings.map((x) => x.severity)).toEqual(['bug', 'bug'])
  })
})

describe('review prompt', () => {
  it('tells the model test assertions are expected behavior and to cite only shown files', () => {
    const text = buildCodeReviewMessages('o/r', '1', 'diff')
      .flatMap((m) => m.content.map((p) => (p.type === 'text' ? p.text : '')))
      .join('\n')
    expect(text).toContain('assertions describe expected behavior')
    expect(text).toContain('Cite only files and line numbers shown in the diff')
  })
})
