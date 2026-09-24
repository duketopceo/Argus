import { defaultExec, type ExecFn } from '../detect.js'
import type { CallCost } from '../vision/cost.js'

/** Whether a report's source can be tied to the intended PR head. */
export type HeadBindingStatus = 'match' | 'mismatch' | 'unknown' | 'not_applicable'
export type HeadSource = 'github' | 'fixture' | 'local'

export const LANE_IDS = ['review', 'flow', 'app', 'a0'] as const
export type LaneId = (typeof LANE_IDS)[number]

export const LANE_STATUSES = [
  'passed',
  'failed',
  'skipped',
  'blocked',
  'unavailable',
  'inconclusive',
] as const
export type LaneStatus = (typeof LANE_STATUSES)[number]

export const MANIFEST_SCHEMA_VERSION = 1 as const

export interface HeadBinding {
  intendedSha: string | undefined
  checkoutSha: string | undefined
  status: HeadBindingStatus
  source: HeadSource
  detail: string
}

export interface UsageSummary {
  provider: 'openrouter' | 'a0' | 'unknown'
  model: string | undefined
  calls: number
  tokens: number
  costUsd: number
  metered: boolean
}

export interface BudgetSummary {
  limitUsd: number | undefined
  spentUsd: number
  exceeded: boolean
  maxDurationMs: number | undefined
  elapsedMs: number
  maxTasks: number | undefined
  tasks: number
}

export interface LaneManifest {
  lane: LaneId
  selected: boolean
  status: LaneStatus
  startedAt: string | undefined
  finishedAt: string | undefined
  reportPath: string | undefined
  model: string | undefined
  summary: string | undefined
  reason: string | undefined
  usage: UsageSummary
  budget: BudgetSummary
  headBinding: HeadBinding | undefined
}

export interface RunIdentity {
  repo: string | undefined
  pr: string | undefined
  intendedHeadSha: string | undefined
  checkoutSha: string | undefined
  baseSha: string | undefined
}

export interface RunManifest {
  schemaVersion: typeof MANIFEST_SCHEMA_VERSION
  runId: string
  startedAt: string
  finishedAt: string
  identity: RunIdentity
  lanes: Record<LaneId, LaneManifest>
  aggregate: {
    status: LaneStatus
    ok: boolean
    costUsd: number
    calls: number
    tokens: number
  }
}

/** Read the checked-out commit without making git identity a hard dependency. */
export async function readCheckoutSha(
  cwd: string,
  exec: ExecFn = defaultExec,
): Promise<string | undefined> {
  const result = await exec('git', ['-C', cwd, 'rev-parse', 'HEAD'], 10_000)
  if (result.code !== 0) return undefined
  const sha = result.stdout.trim()
  return sha === '' ? undefined : sha
}

/** Classify the relationship between API/fixture head identity and the checkout. */
export function classifyHeadBinding(
  intendedSha: string | undefined,
  checkoutSha: string | undefined,
  source: HeadSource,
): HeadBinding {
  if (source === 'fixture') {
    return {
      intendedSha,
      checkoutSha,
      status: 'not_applicable',
      source,
      detail: 'fixture diff is bound to its local fixture head',
    }
  }
  if (intendedSha === undefined || intendedSha === '') {
    return {
      intendedSha,
      checkoutSha,
      status: 'unknown',
      source,
      detail: 'PR head identity was unavailable',
    }
  }
  if (checkoutSha === undefined || checkoutSha === '') {
    return {
      intendedSha,
      checkoutSha,
      status: 'unknown',
      source,
      detail: 'checkout identity was unavailable',
    }
  }
  if (intendedSha === checkoutSha) {
    return {
      intendedSha,
      checkoutSha,
      status: 'match',
      source,
      detail: 'checkout matches the intended PR head',
    }
  }
  return {
    intendedSha,
    checkoutSha,
    status: 'mismatch',
    source,
    detail: `checkout ${checkoutSha} does not match intended PR head ${intendedSha}`,
  }
}

export function emptyUsage(provider: UsageSummary['provider'] = 'unknown'): UsageSummary {
  return {
    provider,
    model: undefined,
    calls: 0,
    tokens: 0,
    costUsd: 0,
    metered: provider !== 'a0',
  }
}

export function emptyBudget(): BudgetSummary {
  return {
    limitUsd: undefined,
    spentUsd: 0,
    exceeded: false,
    maxDurationMs: undefined,
    elapsedMs: 0,
    maxTasks: undefined,
    tasks: 0,
  }
}

export function emptyLane(lane: LaneId, selected: boolean): LaneManifest {
  return {
    lane,
    selected,
    status: selected ? 'blocked' : 'skipped',
    startedAt: undefined,
    finishedAt: undefined,
    reportPath: undefined,
    model: undefined,
    summary: undefined,
    reason: undefined,
    usage: emptyUsage(),
    budget: emptyBudget(),
    headBinding: undefined,
  }
}

export function aggregateLanes(lanes: Record<LaneId, LaneManifest>): {
  status: LaneStatus
  ok: boolean
  costUsd: number
  calls: number
  tokens: number
} {
  const selected = LANE_IDS.map((lane) => lanes[lane]).filter((lane) => lane.selected)
  const hasFailure = selected.some((lane) => ['failed', 'blocked'].includes(lane.status))
  const hasInconclusive = selected.some((lane) => lane.status === 'inconclusive')
  const hasUnavailable = selected.some((lane) => lane.status === 'unavailable')
  const status: LaneStatus = hasFailure
    ? 'failed'
    : hasInconclusive || hasUnavailable
      ? 'inconclusive'
      : selected.length === 0
        ? 'skipped'
        : selected.every((lane) => lane.status === 'passed' || lane.status === 'skipped')
          ? 'passed'
          : 'inconclusive'
  return {
    status,
    ok: status === 'passed',
    costUsd: selected.reduce((sum, lane) => sum + lane.usage.costUsd, 0),
    calls: selected.reduce((sum, lane) => sum + lane.usage.calls, 0),
    tokens: selected.reduce((sum, lane) => sum + lane.usage.tokens, 0),
  }
}

export function addProviderUsage(usage: UsageSummary, calls: CallCost[] | undefined): UsageSummary {
  if (calls === undefined || calls.length === 0) return usage
  const costUsd = calls.reduce((sum, call) => sum + call.costUsd, 0)
  const tokens = calls.reduce((sum, call) => sum + call.tokens, 0)
  const model = calls.at(-1)?.model
  return {
    provider: 'openrouter',
    model: usage.model ?? model,
    calls: usage.calls + calls.length,
    tokens: usage.tokens + tokens,
    costUsd: usage.costUsd + costUsd,
    metered: true,
  }
}
