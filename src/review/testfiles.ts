/**
 * Test files describe expected behavior: a finding that restates an
 * assertion is almost never a defect. Findings anchored in a test file
 * are capped at `nit` unless they cite a non-test file from the diff
 * (the real bug is elsewhere) or carry reproduced evidence.
 */

const TEST_PATH =
  /(^|\/)(tests?|__tests__|__mocks__|spec|e2e)\/|\.(test|spec)\.[^/]+$|_test\.(go|py|rb)$|(^|\/)test_[^/]+\.py$/

export function isTestPath(path: string): boolean {
  return TEST_PATH.test(path.replace(/^\.\//, ''))
}

/** Dirs whose files share the parent dir's namespace for sibling pairing. */
const SIBLING_DIRS = new Set(['__tests__', '__snapshots__', '__mocks__'])

/**
 * testSiblingKey (U5): the stem-group key the test-sibling rule pairs
 * on — `src/foo.test.ts`, `src/__tests__/foo.ts`, `pkg/foo_test.go`, and
 * `src/foo.stories.ts` all share their source's key. The directory is
 * preserved: `tests/test_foo.py` never pairs with `pkg/foo.go`, so
 * mirror-tree layouts stay out of reach by design.
 */
export function testSiblingKey(path: string): string {
  const p = path.replace(/^\.\//, '')
  const slash = p.lastIndexOf('/')
  const dir = slash < 0 ? '' : p.slice(0, slash)
  const base = slash < 0 ? p : p.slice(slash + 1)
  const segs = dir === '' ? [] : dir.split('/').filter((s) => !SIBLING_DIRS.has(s))
  let stem = base.replace(/\.snap$/, '')
  // Chained affixes share the separator dot (`foo.spec.test.ts`) — one
  // /g pass can't see the second affix, so strip to a fixpoint.
  let prev = ''
  while (prev !== stem) {
    prev = stem
    stem = stem.replace(/\.(test|spec|test-d|stories|e2e|gen|generated)\./g, '.')
  }
  stem = stem.replace(/_test(?=\.[^.]+$)/, '').replace(/^test_/, '')
  return segs.length === 0 ? stem : `${segs.join('/')}/${stem}`
}

const CAPPED = new Set(['bug', 'risk'])

export function capTestFindings<
  T extends { file: string; severity: string; message: string; evidence?: { status?: string } },
>(findings: T[], diffFiles: string[]): { findings: T[]; capped: number } {
  const sourceFiles = diffFiles.filter((p) => !isTestPath(p))
  let capped = 0
  const out = findings.map((f) => {
    if (!isTestPath(f.file) || !CAPPED.has(f.severity)) return f
    if (f.evidence?.status === 'reproduced') return f
    if (sourceFiles.some((p) => f.message.includes(p))) return f
    capped++
    return { ...f, severity: 'nit' }
  })
  return { findings: out, capped }
}
