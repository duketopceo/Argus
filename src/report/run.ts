import { writeAtomicJson } from '../fsutil.js'

import type { HealEvent, TdAssertRecord, TdStepRecord } from '../api.js'

/**
 * JSON run report consumed by the GitHub Action (R10): per-test verdicts,
 * heal events, vision-call counts, ledger totals, and artifact paths.
 */

export interface TestReport {
  name: string
  file: string
  ok: boolean
  durationMs: number
  failureMessage: string | undefined
  steps: TdStepRecord[]
  asserts: TdAssertRecord[]
  healEvents: HealEvent[]
  visionCalls: number
  visionCostUsd: number
  sandboxSeconds: number
  budgetExceeded: boolean
  videoPath: string | undefined
}

export interface RunTotals {
  tests: number
  passed: number
  failed: number
  visionCalls: number
  visionCostUsd: number
  sandboxSeconds: number
  budgetExceeded: boolean
}

export interface RunReport {
  tool: 'vision-e2e'
  startedAt: string
  durationMs: number
  ok: boolean
  totals: RunTotals
  tests: TestReport[]
  artifacts: { videos: string[] }
}

export function buildRunReport(
  tests: TestReport[],
  startedAt: Date,
  durationMs: number,
): RunReport {
  const failed = tests.filter((t) => !t.ok).length
  return {
    tool: 'vision-e2e',
    startedAt: startedAt.toISOString(),
    durationMs,
    ok: failed === 0,
    totals: {
      tests: tests.length,
      passed: tests.length - failed,
      failed,
      visionCalls: tests.reduce((sum, t) => sum + t.visionCalls, 0),
      visionCostUsd: tests.reduce((sum, t) => sum + t.visionCostUsd, 0),
      sandboxSeconds: tests.reduce((sum, t) => sum + t.sandboxSeconds, 0),
      budgetExceeded: tests.some((t) => t.budgetExceeded),
    },
    tests,
    artifacts: {
      videos: tests.map((t) => t.videoPath).filter((p): p is string => p !== undefined),
    },
  }
}

export async function writeRunReport(path: string, report: RunReport): Promise<void> {
  await writeAtomicJson(path, report)
}
