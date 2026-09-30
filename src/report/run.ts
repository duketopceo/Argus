import { writeAtomicJson } from '../fsutil.js'

import type { HealEvent, TdAssertRecord, TdStepRecord } from '../api.js'
import type { PageCapture } from '../driver/browser.js'
import type { ExploreStopReason } from '../engine/explore.js'
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
   * Exploratory-lane summary (U4). Present only when `explore.enabled` —
   * the comment renders an Exploratory section for it. `skipped` carries an
   * explicit reason when the lane was on but could not observe anything
   * (e.g. the target URL was unreachable), so a silent no-op is impossible.
   * `steps`/`visited`/`stopReason`/`visionCalls`/`visionCostUsd`/`captures`
   * describe the bounded free-explore act pass (U4b) when it ran; they are
   * `observed` evidence, never verdict-changing.
   */
  explore?: {
    enabled: boolean
    skipped?: string
    steps?: number
    visited?: number
    stopReason?: ExploreStopReason
    visionCalls?: number
    visionCostUsd?: number
    captures?: PageCapture[]
    /** Video of the explore session itself (also in `artifacts.videos`). */
    videoPath?: string
  }
}

export function buildRunReport(
  tests: TestReport[],
  startedAt: Date,
  durationMs: number,
  /**
   * Model calls outside the per-test sessions (the explore act pass bills
   * its own ledger). Folded into the run totals so `run.json` spend is
   * complete even though no TestReport owns these calls.
   */
  extraCalls: CallCost[] = [],
  /**
   * An enabled explore lane makes a zero-test run a legitimate shape — the
   * act pass is the evidence source for repos with no recorded flows, and
   * its outcome (or explicit skip reason) lands in `report.explore`, so the
   * empty suite is never a silent pass.
   */
  exploreEnabled = false,
): RunReport {
  const failed = tests.filter((t) => !t.ok).length
  const callsByModel: Record<string, number> = {}
  const costByModel: Record<string, number> = {}
  for (const c of [...tests.flatMap((t) => t.calls), ...extraCalls]) {
    callsByModel[c.model] = (callsByModel[c.model] ?? 0) + 1
    costByModel[c.model] = (costByModel[c.model] ?? 0) + c.costUsd
  }
  const extraVisionCost = extraCalls.reduce((s, c) => s + c.costUsd, 0)
  return {
    tool: 'argus-reviewer',
    startedAt: startedAt.toISOString(),
    durationMs,
    // Zero executed tests is not a pass — an empty suite produces no evidence,
    // so the report fails closed rather than letting a misconfigured testsDir
    // or a non-matching pattern read as green. An enabled explore lane is the
    // exception: its pass (or explicit skip) is the evidence.
    ok: (tests.length > 0 || exploreEnabled) && failed === 0,
    totals: {
      tests: tests.length,
      passed: tests.length - failed,
      failed,
      visionCalls: tests.reduce((sum, t) => sum + t.visionCalls, 0) + extraCalls.length,
      visionCostUsd: tests.reduce((sum, t) => sum + t.visionCostUsd, 0) + extraVisionCost,
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
