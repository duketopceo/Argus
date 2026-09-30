import { writeAtomicJson } from '../fsutil.js'

import type { HealEvent, TdAssertRecord, TdStepRecord } from '../api.js'
import type { PageCapture } from '../driver/browser.js'
import type { CacheStats } from '../engine/loop.js'
import type { CallCost } from '../vision/cost.js'

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
  /** Per-call cost rows for model-level attribution. */
  calls: CallCost[]
  videoPath: string | undefined
  /** Fingerprint replay/grounding counters for this test. */
  cache?: CacheStats
  /** Agent Zero's autonomous second opinion on a failure (heal: 'a0'). */
  a0Diagnosis?: string
  /**
   * Exploratory captures from this file's browser session (U4a):
   * console errors, page errors, and failed same-origin requests observed
   * while the tests ran. `observed` findings — never verdict-changing.
   * Present only when explore.enabled and anomalies occurred.
   */
  captures?: PageCapture[]
}

export interface RunTotals {
  tests: number
  passed: number
  failed: number
  visionCalls: number
  visionCostUsd: number
  sandboxSeconds: number
  budgetExceeded: boolean
  /** OpenRouter spend grouped by model id. */
  costByModel: Record<string, number>
  /** OpenRouter call count grouped by model id. */
  callsByModel: Record<string, number>
  cacheHits: number
  cacheMisses: number
  cacheHeals: number
  staleEntries: number
  assertionHits: number
  assertionMisses: number
}

export interface RunReport {
  tool: 'argus-reviewer'
  startedAt: string
  durationMs: number
  ok: boolean
  totals: RunTotals
  tests: TestReport[]
  artifacts: { videos: string[] }
  /**
   * Exploratory-lane summary (U4a). Present only when `explore.enabled` —
   * the comment renders an Exploratory section for it. `skipped` carries an
   * explicit reason when the lane was on but could not observe anything
   * (e.g. the target URL was unreachable), so a silent no-op is impossible.
   */
  explore?: { enabled: boolean; skipped?: string }
}

export function buildRunReport(
  tests: TestReport[],
  startedAt: Date,
  durationMs: number,
): RunReport {
  const failed = tests.filter((t) => !t.ok).length
  const callsByModel: Record<string, number> = {}
  const costByModel: Record<string, number> = {}
  for (const t of tests) {
    for (const c of t.calls) {
      callsByModel[c.model] = (callsByModel[c.model] ?? 0) + 1
      costByModel[c.model] = (costByModel[c.model] ?? 0) + c.costUsd
    }
  }
  return {
    tool: 'argus-reviewer',
    startedAt: startedAt.toISOString(),
    durationMs,
    // Zero executed tests is not a pass — an empty suite produces no evidence,
    // so the report fails closed rather than letting a misconfigured testsDir
    // or a non-matching pattern read as green.
    ok: tests.length > 0 && failed === 0,
    totals: {
      tests: tests.length,
      passed: tests.length - failed,
      failed,
      visionCalls: tests.reduce((sum, t) => sum + t.visionCalls, 0),
      visionCostUsd: tests.reduce((sum, t) => sum + t.visionCostUsd, 0),
      sandboxSeconds: tests.reduce((sum, t) => sum + t.sandboxSeconds, 0),
      budgetExceeded: tests.some((t) => t.budgetExceeded),
      callsByModel,
      costByModel,
      cacheHits: tests.reduce((sum, t) => sum + (t.cache?.hits ?? 0), 0),
      cacheMisses: tests.reduce((sum, t) => sum + (t.cache?.misses ?? 0), 0),
      cacheHeals: tests.reduce((sum, t) => sum + (t.cache?.heals ?? 0), 0),
      staleEntries: tests.reduce((sum, t) => sum + (t.cache?.staleEntries ?? 0), 0),
      assertionHits: tests.reduce((sum, t) => sum + (t.cache?.assertionHits ?? 0), 0),
      assertionMisses: tests.reduce((sum, t) => sum + (t.cache?.assertionMisses ?? 0), 0),
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
