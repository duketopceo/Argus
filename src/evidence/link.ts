import type { RepoIndex } from '../index/scan.js'
import type { CheckRun } from './ci.js'

/**
 * `reproduced` is emitted only by the B.2 probe stage — a sandboxed test probe
 * demonstrated the defect (KTD4). `linkFindings` never produces it; the probe
 * stage is the only writer and can only move `not_exercised` → `reproduced`.
 */
export type EvidenceStatus =
  | 'exercised'
  | 'corroborated'
  | 'not_exercised'
  | 'inconclusive'
  | 'reproduced'

export interface Evidence {
  status: EvidenceStatus
  detail: string
}

/** Repo-relative paths that look like test files. */
const TEST_FILE_RE = /(?:^|\/)(?:tests?|e2e|__tests__|__spec__)\/|\.(?:test|spec|e2e-spec)\.[jt]sx?$/i

/** Check-run names that look like test jobs (lint/build/status lanes don't count). */
const TEST_RUN_RE = /\b(test|tests|spec|specs|e2e|smoke|jest|vitest|pytest|rspec|mocha|ava|unittest)\b/i

/** Argus's own check-runs are the reporter, not consumer CI evidence. */
const ARGUS_RUN_RE = /argus/i

/** Check-run conclusions that mean "didn't actually run" — never evidence. */
const DID_NOT_RUN = new Set(['neutral', 'skipped', 'cancelled', 'action_required', 'stale', 'startup_failure'])

/** Strip comment-hostile characters — check-run names are repo-controlled and reach the PR comment. */
export function sanitizeForComment(s: string, max = 80): string {
  return s.replace(/[|\r\n<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
}

export function isTestFile(path: string): boolean {
  return TEST_FILE_RE.test(path)
}

/**
 * Every file transitively imported by a test file — a finding on a file in
 * this set was plausibly exercised by the suite. Files outside it can carry
 * no CI evidence regardless of check-run outcomes.
 */
export function testReachableFiles(index: RepoIndex): Set<string> {
  const byPath = new Map(index.entries.map((e) => [e.path, e]))
  const roots = index.entries.filter((e) => isTestFile(e.path)).map((e) => e.path)
  const seen = new Set<string>(roots)
  const queue = [...roots]
  while (queue.length > 0) {
    const cur = queue.shift() as string
    for (const dep of byPath.get(cur)?.imports ?? []) {
      if (!seen.has(dep)) {
        seen.add(dep)
        queue.push(dep)
      }
    }
  }
  return seen
}

export interface TestRunSummary {
  /** Test-ish check-runs that completed to a real conclusion. */
  ran: CheckRun[]
  passed: CheckRun[]
  failed: CheckRun[]
}

/** Filter check-runs to test-ish lanes that actually ran, excluding Argus itself. */
export function summarizeTestRuns(checkRuns: CheckRun[]): TestRunSummary {
  const ran = checkRuns.filter(
    (r) =>
      !ARGUS_RUN_RE.test(r.name) &&
      TEST_RUN_RE.test(r.name) &&
      r.completed &&
      r.conclusion !== undefined &&
      !DID_NOT_RUN.has(r.conclusion),
  )
  return {
    ran,
    passed: ran.filter((r) => r.conclusion === 'success'),
    failed: ran.filter((r) => r.conclusion === 'failure' || r.conclusion === 'timed_out'),
  }
}

/**
 * Conservative linkage: a finding is `exercised` only when its file is
 * reachable from a test file AND every test check-run that ran passed. A
 * failing test run on a reachable path corroborates the finding. Anything
 * ambiguous is `not_exercised` — never a downgrade.
 */
export function linkFindings<T extends { file?: string }>(
  findings: T[],
  index: RepoIndex | undefined,
  checkRuns: CheckRun[] | undefined,
): (T & { evidence: Evidence })[] {
  const runs = checkRuns === undefined ? undefined : summarizeTestRuns(checkRuns)
  const reachable = index === undefined ? undefined : testReachableFiles(index)

  return findings.map((f) => {
    let evidence: Evidence
    if (runs === undefined) {
      evidence = { status: 'inconclusive', detail: 'could not fetch CI check-runs' }
    } else if (reachable === undefined) {
      evidence = { status: 'inconclusive', detail: 'no repo index — run `argus-reviewer index` first' }
    } else if (typeof f.file !== 'string' || !reachable.has(f.file)) {
      evidence = {
        status: 'not_exercised',
        detail: 'no test file reaches this path — CI outcome carries no evidence here',
      }
    } else if (runs.ran.length === 0) {
      evidence = { status: 'inconclusive', detail: 'no test check-runs completed on this head' }
    } else if (runs.failed.length > 0) {
      evidence = {
        status: 'corroborated',
        detail: `test check ${runs.failed.map((r) => `\`${sanitizeForComment(r.name)}\``).join(', ')} failed on this head`,
      }
    } else {
      evidence = {
        status: 'exercised',
        detail: `path is test-reachable; ${runs.passed.length} test check(s) passed`,
      }
    }
    return { ...f, evidence }
  })
}
