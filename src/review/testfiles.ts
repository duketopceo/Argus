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
