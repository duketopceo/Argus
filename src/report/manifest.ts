import { readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'

import { defaultExec, type ExecFn } from '../detect.js'
import type { CallCost } from '../vision/cost.js'
import { writeAtomicJson } from '../fsutil.js'

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

export interface CacheSummary {
  hits: number
  misses: number
  heals: number
  staleEntries: number
  assertionHits: number
  assertionMisses: number
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
  /** Flow-lane replay economics — defined only when the lane produced a run.json. */
  cache: CacheSummary | undefined
}

export interface RunIdentity {
  repo: string | undefined
  pr: string | undefined
  intendedHeadSha: string | undefined
  checkoutSha: string | undefined
  baseSha: string | undefined
  /**
   * Run-scoped nonce (GITHUB_RUN_ID) — not knowable when a commit or a
   * planted file is authored, so residue and plants fail the post step's
   * freshness gate even when their head sha happens to match. A freshness
   * marker, not a secret: it is public once the run exists. RUN_ATTEMPT is
   * deliberately excluded — a re-run of failed jobs would otherwise
   * invalidate evidence the same run produced. Undefined for local runs.
   */
  runNonce: string | undefined
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

/** True when runtime evidence is bound to the intended head (or a fixture). */
export function isHeadBindingConclusive(binding: HeadBinding | undefined): boolean {
  return binding?.status === 'match' || binding?.status === 'not_applicable'
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
    cache: undefined,
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
      : selected.length === 0 || selected.every((lane) => lane.status === 'skipped')
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

/** Run manifests are archived under `<reportDir>/manifests/<runId>.json`. */
export const MANIFEST_HISTORY_DIR = 'manifests'

/**
 * Archive a completed verify manifest into local history and prune to the
 * retention bound — the dashboard/TUI run list reads this directory.
 * runIds are timestamp-prefixed, so name sort is chronological; pruning
 * drops the oldest names beyond `keep`. `keep <= 0` writes nothing and
 * clears nothing existing (retention governs new archives, not deletes).
 */
export async function archiveManifest(
  reportDir: string,
  manifest: RunManifest,
  keep: number,
): Promise<void> {
  if (keep <= 0) return
  const dir = join(reportDir, MANIFEST_HISTORY_DIR)
  // runId becomes a filename — never trust it as a path component.
  const safeName = manifest.runId.replace(/[^\w.-]/g, '-')
  await writeAtomicJson(join(dir, `${safeName}.json`), manifest)
  let names: string[]
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.json')).sort()
  } catch {
    return
  }
  const excess = names.length - keep
  for (const name of names.slice(0, Math.max(0, excess))) {
    try {
      await unlink(join(dir, name))
    } catch {
      // already gone — pruning is best-effort
    }
  }
}
