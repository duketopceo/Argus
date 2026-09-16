import { afterEach, describe, expect, it, vi } from 'vitest'

import { resolveConfig, type Sandbox } from '../../src/config.js'
import { fetchPrMeta, type CheckRun, type PrMeta } from '../../src/evidence/ci.js'
import { mayProbePr } from '../../src/evidence/gate.js'
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

function prMeta(over: Partial<PrMeta> = {}): PrMeta {
  return {
    headSha: 'abc123',
    baseSha: 'def456',
    isFork: false,
    authorAssociation: 'MEMBER',
    labels: [],
    pushedAt: '2026-09-15T10:00:00Z',
    labelApprovedAt: undefined,
    ...over,
  }
}

/** Sandbox config with the lane enabled; `over` can force it back off. */
function sandboxOn(over: Partial<Sandbox> = {}): Sandbox {
  return resolveConfig({ sandbox: { enabled: true, ...over } }).sandbox
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

  it('never produces reproduced — only the probe stage may (KTD4)', () => {
    const linked = [
      linkFindings([{ file: 'src/a.ts' }], index, [run('test', 'success')]),
      linkFindings([{ file: 'src/a.ts' }], index, [run('test', 'failure')]),
      linkFindings([{ file: 'src/b.ts' }], index, [run('test', 'success')]),
      linkFindings([{ file: 'src/a.ts' }], index, undefined),
      linkFindings([{ file: 'src/a.ts' }], undefined, [run('test', 'success')]),
      linkFindings([{ file: 'src/a.ts' }], index, [run('lint', 'success')]),
      linkFindings([{ file: 'src/a.ts' }], index, []),
      linkFindings([{}], index, [run('test', 'success')]),
    ].flat()
    // Guard is only meaningful if it covered every linkFindings branch.
    expect(new Set(linked.map((f) => f.evidence.status))).toEqual(
      new Set(['exercised', 'corroborated', 'not_exercised', 'inconclusive']),
    )
    for (const f of linked) expect(f.evidence.status).not.toBe('reproduced')
  })
})

describe('mayProbePr', () => {
  it('allows same-repo PRs once the lane is enabled', () => {
    expect(mayProbePr(prMeta({ isFork: false, authorAssociation: 'NONE' }), sandboxOn())).toBe(true)
    expect(mayProbePr(prMeta({ isFork: false, authorAssociation: undefined }), sandboxOn())).toBe(
      true,
    )
  })

  it('denies fork PRs with no label and an untrusted association', () => {
    const untrusted = ['CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER', 'NONE', undefined]
    for (const assoc of untrusted) {
      const meta = prMeta({ isFork: true, authorAssociation: assoc })
      expect(mayProbePr(meta, sandboxOn()), String(assoc)).toBe(false)
    }
  })

  it('allows fork PRs carrying a per-head argus-probe label', () => {
    const meta = prMeta({
      isFork: true,
      authorAssociation: 'NONE',
      labels: ['bug', 'argus-probe'],
      labelApprovedAt: '2026-09-15T11:00:00Z', // after pushedAt
    })
    expect(mayProbePr(meta, sandboxOn())).toBe(true)
  })

  it('denies fork PRs whose label predates the head push (stale approval)', () => {
    const meta = prMeta({
      isFork: true,
      authorAssociation: 'NONE',
      labels: ['argus-probe'],
      labelApprovedAt: '2026-09-15T09:00:00Z', // before pushedAt — synchronize landed after
    })
    expect(mayProbePr(meta, sandboxOn())).toBe(false)
  })

  it('denies fork PRs whose label cannot be bound to the head', () => {
    // Timeline fetch failed or pushed_at missing — approval unverifiable.
    for (const over of [
      { labelApprovedAt: undefined },
      { labelApprovedAt: '2026-09-15T11:00:00Z', pushedAt: undefined },
    ]) {
      const meta = prMeta({ isFork: true, authorAssociation: 'NONE', labels: ['argus-probe'], ...over })
      expect(mayProbePr(meta, sandboxOn()), JSON.stringify(over)).toBe(false)
    }
  })

  it('denies deleted-fork PRs (isFork forced true upstream) without approval', () => {
    const meta = prMeta({ isFork: true, authorAssociation: 'NONE', labels: [] })
    expect(mayProbePr(meta, sandboxOn())).toBe(false)
  })

  it('allows fork PRs from trusted author associations', () => {
    for (const assoc of ['MEMBER', 'OWNER', 'COLLABORATOR']) {
      const meta = prMeta({ isFork: true, authorAssociation: assoc })
      expect(mayProbePr(meta, sandboxOn()), assoc).toBe(true)
    }
  })

  it('allows fork PRs unconditionally when allowForks is set', () => {
    const meta = prMeta({ isFork: true, authorAssociation: 'NONE' })
    expect(mayProbePr(meta, sandboxOn({ allowForks: true }))).toBe(true)
  })

  it('denies everything while the lane is disabled', () => {
    expect(mayProbePr(prMeta({ isFork: false }), sandboxOn({ enabled: false }))).toBe(false)
    expect(
      mayProbePr(prMeta({ isFork: true, labels: ['argus-probe'] }), sandboxOn({ enabled: false })),
    ).toBe(false)
    expect(
      mayProbePr(prMeta({ isFork: true }), sandboxOn({ enabled: false, allowForks: true })),
    ).toBe(false)
  })

  it('fails closed when PR metadata could not be fetched', () => {
    expect(mayProbePr(undefined, sandboxOn())).toBe(false)
    expect(mayProbePr(undefined, sandboxOn({ allowForks: true }))).toBe(false)
  })
})

describe('sanitizeForComment', () => {
  it('strips table-breaking and markup chars', () => {
    expect(sanitizeForComment('a|b\n<c>d')).toBe('a b c d')
  })
})

describe('fetchPrMeta', () => {
  const ctx = { err: () => undefined }
  afterEach(() => vi.unstubAllGlobals())

  /** Route-based fetch stub: url substring → response body (or non-ok). */
  function stubFetch(routes: [string, unknown][]) {
    const seen: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      seen.push(url)
      for (const [match, body] of routes) {
        if (url.includes(match)) {
          return { ok: true, json: async () => body } as Response
        }
      }
      return { ok: false, status: 404, statusText: 'Not Found' } as Response
    })
    return seen
  }

  it('uses merge_base_sha (not base-branch tip) as the probe base', async () => {
    stubFetch([
      [
        '/pulls/1',
        {
          head: { sha: 'h1', repo: { fork: false, pushed_at: '2026-09-15T10:00:00Z' } },
          base: { sha: 'basetip' },
          merge_base_sha: 'diverge',
          author_association: 'MEMBER',
          labels: [],
        },
      ],
    ])
    const meta = await fetchPrMeta('o/r', '1', 'tok', ctx)
    expect(meta?.baseSha).toBe('diverge')
    expect(meta?.headSha).toBe('h1')
    expect(meta?.isFork).toBe(false)
  })

  it('fails closed when head.repo is null (deleted fork)', async () => {
    stubFetch([
      ['/pulls/1', { head: { sha: 'h1', repo: null }, base: { sha: 'b' }, author_association: 'NONE', labels: [] }],
    ])
    const meta = await fetchPrMeta('o/r', '1', 'tok', ctx)
    expect(meta?.isFork).toBe(true)
  })

  it('fetches the label timestamp only for untrusted forks carrying argus-probe', async () => {
    const pr = (labels: string[], fork: boolean, assoc: string) => ({
      head: { sha: 'h1', repo: { fork, pushed_at: '2026-09-15T10:00:00Z' } },
      base: { sha: 'b' },
      merge_base_sha: 'mb',
      author_association: assoc,
      labels: labels.map((name) => ({ name })),
    })
    // Untrusted fork WITH the label → the events call happens.
    const seen = stubFetch([
      ['/pulls/1', pr(['argus-probe'], true, 'NONE')],
      [
        '/issues/1/events',
        [
          { event: 'labeled', created_at: '2026-09-15T09:00:00Z', label: { name: 'other' } },
          { event: 'labeled', created_at: '2026-09-15T11:00:00Z', label: { name: 'argus-probe' } },
        ],
      ],
    ])
    const meta = await fetchPrMeta('o/r', '1', 'tok', ctx)
    expect(meta?.labelApprovedAt).toBe('2026-09-15T11:00:00Z')
    expect(seen.some((u) => u.includes('/issues/1/events'))).toBe(true)

    // Same-repo PR with the label → no extra call.
    const seen2 = stubFetch([['/pulls/1', pr(['argus-probe'], false, 'NONE')]])
    const meta2 = await fetchPrMeta('o/r', '1', 'tok', ctx)
    expect(meta2?.labelApprovedAt).toBeUndefined()
    expect(seen2.some((u) => u.includes('/issues/'))).toBe(false)

    // Trusted fork → label irrelevant → no extra call.
    const seen3 = stubFetch([['/pulls/1', pr(['argus-probe'], true, 'MEMBER')]])
    await fetchPrMeta('o/r', '1', 'tok', ctx)
    expect(seen3.some((u) => u.includes('/issues/'))).toBe(false)
  })

  it('returns undefined (fail closed) when the PR fetch fails', async () => {
    stubFetch([])
    expect(await fetchPrMeta('o/r', '1', 'tok', ctx)).toBeUndefined()
  })
})
