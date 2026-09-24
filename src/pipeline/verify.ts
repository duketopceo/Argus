import { readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

import {
  aggregateLanes,
  addProviderUsage,
  emptyLane,
  emptyUsage,
  MANIFEST_SCHEMA_VERSION,
  type BudgetSummary,
  type HeadBinding,
  type LaneId,
  type LaneManifest,
  type RunIdentity,
  type RunManifest,
} from '../report/manifest.js'
import { addProviderCalls, createBudget, type BudgetOptions } from './budget.js'
import { selectedLanes, type LaneSelection } from './contracts.js'
import type { CallCost } from '../vision/cost.js'

export interface VerifyRunners {
  review: () => Promise<number>
  flow?: (url: string) => Promise<number>
  app?: () => Promise<number>
  a0?: () => Promise<number>
}

export interface VerifyInput {
  cwd: string
  runId: string
  reportDir: string
  identity: RunIdentity
  selection: LaneSelection
  runners: VerifyRunners
  budgets?: Partial<Record<LaneId, BudgetOptions>>
  flowUrl?: string
  flowUnavailableReason?: string
}

export interface VerifyResult {
  manifest: RunManifest
  exitCode: number
}

interface ReviewReport {
  ok?: boolean
  skipped?: boolean
  summary?: string
  model?: string
  calls?: CallCost[]
  tokens?: number
  visionCostUsd?: number
  headBinding?: HeadBinding
}

interface FlowReport {
  ok?: boolean
  totals?: {
    visionCalls?: number
    visionCostUsd?: number
    callsByModel?: Record<string, number>
    costByModel?: Record<string, number>
  }
  tests?: { calls?: CallCost[] }[]
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return undefined
  }
}

function relativeReport(cwd: string, reportDir: string, name: string): string {
  return relative(cwd, join(reportDir, name)) || name
}

function laneStart(lane: LaneManifest, at = new Date()): LaneManifest {
  return { ...lane, startedAt: at.toISOString() }
}

function laneEnd(lane: LaneManifest, at = new Date()): LaneManifest {
  return { ...lane, finishedAt: at.toISOString() }
}

function reportStatus(
  code: number,
  report: { ok?: boolean; skipped?: boolean } | undefined,
  mismatch: boolean,
): 'passed' | 'failed' | 'skipped' | 'inconclusive' {
  if (report?.skipped === true) return 'skipped'
  if (mismatch) return 'inconclusive'
  if (report?.ok === true && code === 0) return 'passed'
  return 'failed'
}

function providerUsageFromCalls(calls: CallCost[] | undefined) {
  const usage = emptyUsage('openrouter')
  return calls === undefined ? usage : addProviderUsage(usage, calls)
}

function flowCalls(report: FlowReport | undefined) {
  return report?.tests?.flatMap((test) => test.calls ?? []) ?? []
}

function flowUsage(report: FlowReport | undefined) {
  const calls = flowCalls(report)
  const usage = providerUsageFromCalls(calls)
  if (report?.totals !== undefined && calls.length === 0) {
    return {
      ...usage,
      calls: report.totals.visionCalls ?? 0,
      tokens: 0,
      costUsd: report.totals.visionCostUsd ?? 0,
    }
  }
  return usage
}

function budgetFor(
  lane: LaneId,
  input: VerifyInput,
  report?: ReviewReport | FlowReport,
): BudgetSummary {
  const options = input.budgets?.[lane] ?? {}
  let budget = createBudget(lane, options)
  if (lane === 'review') {
    budget = addProviderCalls(budget, (report as ReviewReport | undefined)?.calls)
  } else if (lane === 'flow') {
    budget = addProviderCalls(budget, flowCalls(report as FlowReport | undefined))
  }
  return budget
}

function baseLane(lane: LaneId, selected: boolean): LaneManifest {
  return emptyLane(lane, selected)
}

/** Run selected lanes and return one stable manifest without owning subprocesses. */
export async function runVerify(input: VerifyInput): Promise<VerifyResult> {
  const startedAt = new Date()
  const lanes = Object.fromEntries(
    (['review', 'flow', 'app', 'a0'] as LaneId[]).map((lane) => [
      lane,
      baseLane(lane, input.selection[lane]),
    ]),
  ) as Record<LaneId, LaneManifest>

  const reviewSelected = input.selection.review
  if (reviewSelected) {
    lanes.review = laneStart(lanes.review, startedAt)
    let code = 1
    let runnerError: string | undefined
    try {
      code = await input.runners.review()
    } catch (error) {
      runnerError = error instanceof Error ? error.message : String(error)
      ctxError(runnerError)
    }
    const report = await readJson<ReviewReport>(join(input.reportDir, 'code-review.json'))
    const mismatch = report?.headBinding?.status === 'mismatch'
    const status = runnerError !== undefined ? 'failed' : reportStatus(code, report, mismatch)
    lanes.review = laneEnd({
      ...lanes.review,
      status,
      reportPath:
        report === undefined
          ? undefined
          : relativeReport(input.cwd, input.reportDir, 'code-review.json'),
      model: report?.model,
      summary: report?.summary,
      reason:
        runnerError ??
        (report === undefined
          ? 'code-review.json was not produced'
          : status === 'passed'
            ? undefined
            : report.summary),
      usage: providerUsageFromCalls(report?.calls),
      budget: budgetFor('review', input, report),
      headBinding: report?.headBinding,
    })
  }

  if (input.selection.flow) {
    lanes.flow = laneStart(lanes.flow, startedAt)
    if (input.runners.flow === undefined) {
      lanes.flow = laneEnd({
        ...lanes.flow,
        status: 'unavailable',
        reason: 'flow runner is not available in this build',
      })
    } else if (input.flowUrl === undefined || input.flowUrl === '') {
      lanes.flow = laneEnd({
        ...lanes.flow,
        status: 'blocked',
        reason: input.flowUnavailableReason ?? 'no application target configured',
      })
    } else {
      let code = 1
      let runnerError: string | undefined
      try {
        code = await input.runners.flow(input.flowUrl)
      } catch (error) {
        runnerError = error instanceof Error ? error.message : String(error)
        ctxError(runnerError)
      }
      const report = await readJson<FlowReport>(join(input.reportDir, 'run.json'))
      lanes.flow = laneEnd({
        ...lanes.flow,
        status: runnerError !== undefined ? 'failed' : reportStatus(code, report, false),
        reportPath:
          report === undefined ? undefined : relativeReport(input.cwd, input.reportDir, 'run.json'),
        summary:
          report === undefined ? undefined : report.ok === true ? 'flow passed' : 'flow failed',
        reason:
          runnerError ??
          (report === undefined
            ? 'run.json was not produced'
            : report.ok === true
              ? undefined
              : 'flow failed'),
        usage: flowUsage(report),
        budget: budgetFor('flow', input, report),
      })
    }
  }

  for (const lane of ['app', 'a0'] as const) {
    if (!input.selection[lane]) continue
    const runner = input.runners[lane]
    lanes[lane] = laneStart(lanes[lane], startedAt)
    if (runner === undefined) {
      lanes[lane] = laneEnd({
        ...lanes[lane],
        status: 'unavailable',
        reason: `${lane} runner is not available in this build`,
      })
      continue
    }
    let code = 1
    let runnerError: string | undefined
    try {
      code = await runner()
    } catch (error) {
      runnerError = error instanceof Error ? error.message : String(error)
      ctxError(runnerError)
    }
    lanes[lane] = laneEnd({
      ...lanes[lane],
      status: code === 0 ? 'passed' : 'failed',
      reason: runnerError ?? (code === 0 ? undefined : `${lane} runner exited ${code}`),
    })
  }

  const aggregate = aggregateLanes(lanes)
  const manifest: RunManifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    runId: input.runId,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    identity: input.identity,
    lanes,
    aggregate,
  }
  return { manifest, exitCode: aggregate.ok ? 0 : 1 }
}

function ctxError(message: string): void {
  console.error(`verify lane error: ${message}`)
}

export function selectedManifestLanes(selection: LaneSelection): LaneId[] {
  return selectedLanes(selection)
}
