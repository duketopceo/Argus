import { describe, expect, it } from 'vitest'

import type { CheckRun } from '../../src/evidence/ci.js'
import {
  isTestFile,
  linkFindings,
  sanitizeForComment,
  summarizeTestRuns,
  testReachableFiles,
} from '../../src/evidence/link.js'
import type { RepoIndex } from '../../src/index/scan.js'

function idx(entries: [string, string[]][]): RepoIndex {
  return {
    schemaVersion: 1,
    generatedAt: '2026-01-01T00:00:00Z',
    root: '/repo',
    entries: entries.map(([path, imports]) => ({
      path,
      imports,
      importedBy: [],
      contentHash: 'x',
    })),
  }
}

function run(name: string, conclusion: string | undefined, completed = true): CheckRun {
  return { name, conclusion, completed, url: undefined }
}

describe('isTestFile', () => {
  it('matches test patterns', () => {
    for (const p of [
      'tests/unit/cli.test.ts',
      'src/foo.spec.ts',
      'e2e/flow.ts',
      'pkg/__tests__/x.js',
      'a/b.test.tsx',
    ]) {
      expect(isTestFile(p), p).toBe(true)
    }
  })
  it('rejects non-test paths', () => {
    for (const p of ['src/cli.ts', 'src/testable.ts', 'contest/x.ts', 'docs/test.md']) {
      expect(isTestFile(p), p).toBe(false)
    }
  })
})

describe('testReachableFiles', () => {
  it('reaches transitively through imports', () => {
    const index = idx([
      ['tests/x.test.ts', ['src/a.ts']],
      ['src/a.ts', ['src/b.ts']],
      ['src/b.ts', []],
      ['src/unrelated.ts', []],
    ])
    const r = testReachableFiles(index)
    expect(r.has('src/a.ts')).toBe(true)
    expect(r.has('src/b.ts')).toBe(true)
    expect(r.has('src/unrelated.ts')).toBe(false)
  })
})

describe('summarizeTestRuns', () => {
  it('excludes argus lanes and non-test check-runs', () => {
    const s = summarizeTestRuns([
      run('argus-reviewer CI / review', 'success'),
      run('test', 'success'),
      run('Socket Security', 'success'),
      run('smoke', 'failure'),
    ])
    expect(s.ran.map((r) => r.name)).toEqual(['test', 'smoke'])
    expect(s.passed.map((r) => r.name)).toEqual(['test'])
    expect(s.failed.map((r) => r.name)).toEqual(['smoke'])
  })

  it('treats cancelled/skipped/pending as not-ran', () => {
    const s = summarizeTestRuns([
      run('test', 'cancelled'),
      run('test', 'skipped'),
      run('test', undefined, false),
    ])
    expect(s.ran).toHaveLength(0)
  })
})

describe('linkFindings', () => {
  const index = idx([
    ['tests/x.test.ts', ['src/a.ts']],
    ['src/a.ts', []],
    ['src/b.ts', []],
  ])

  it('exercised: test-reachable + all test runs passed', () => {
    const out = linkFindings([{ file: 'src/a.ts' }], index, [run('test', 'success')])
    expect(out[0].evidence.status).toBe('exercised')
  })

  it('corroborated: test-reachable + a test run failed', () => {
    const out = linkFindings([{ file: 'src/a.ts' }], index, [
      run('test', 'success'),
      run('smoke', 'failure'),
    ])
    expect(out[0].evidence.status).toBe('corroborated')
    expect(out[0].evidence.detail).toContain('smoke')
  })

  it('not_exercised: file not reachable from tests even when CI passed', () => {
    const out = linkFindings([{ file: 'src/b.ts' }], index, [run('test', 'success')])
    expect(out[0].evidence.status).toBe('not_exercised')
  })

  it('not_exercised: never downgraded by a passing suite', () => {
    const out = linkFindings([{ file: 'src/b.ts' }], index, [run('test', 'success'), run('e2e', 'success')])
    expect(out[0].evidence.status).toBe('not_exercised')
  })

  it('inconclusive: no check-runs fetched', () => {
    const out = linkFindings([{ file: 'src/a.ts' }], index, undefined)
    expect(out[0].evidence.status).toBe('inconclusive')
    expect(out[0].evidence.detail).toContain('fetch')
  })

  it('inconclusive: no index', () => {
    const out = linkFindings([{ file: 'src/a.ts' }], undefined, [run('test', 'success')])
    expect(out[0].evidence.status).toBe('inconclusive')
  })

  it('inconclusive: check-runs exist but no test lane ran', () => {
    const out = linkFindings([{ file: 'src/a.ts' }], index, [
      run('Socket Security', 'success'),
      run('test', 'cancelled'),
    ])
    expect(out[0].evidence.status).toBe('inconclusive')
  })

  it('sanitizes check-run names that reach the comment', () => {
    const hostile = run('test | <script>\nalert(1)', 'failure')
    const out = linkFindings([{ file: 'src/a.ts' }], index, [hostile])
    expect(out[0].evidence.status).toBe('corroborated')
    expect(out[0].evidence.detail).not.toMatch(/[|\n<>]/)
  })
})

describe('sanitizeForComment', () => {
  it('strips table-breaking and markup chars', () => {
    expect(sanitizeForComment('a|b\n<c>d')).toBe('a b c d')
  })
})
