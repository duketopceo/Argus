import {
  LANE_IDS,
  LANE_STATUSES,
  type BudgetSummary,
  type CacheSummary,
  type HeadBinding,
  type LaneId,
  type LaneManifest,
  type LaneStatus,
  type RunManifest,
  type UsageSummary,
} from './manifest.js'

/**
 * Manifest → view model. One contract for the three evidence surfaces —
 * sticky PR comment, TUI, and Electron dashboard — so lane names, status
 * labels, model/cost fields, and head identity agree by construction, not
 * by convention (R15, AE-C).
 *
 * Everything here is a pure function over an already-parsed RunManifest:
 * no fs, no fetch — the collector owns reading, this owns shaping.
 */

/** One display label per status — surfaces may color it, never rename it. */
export const LANE_STATUS_LABEL: Record<LaneStatus, string> = {
  passed: 'passed',
  failed: 'failed',
  skipped: 'skipped',
  blocked: 'blocked',
  unavailable: 'unavailable',
  inconclusive: 'inconclusive',
}

/** One glyph per status — terminal/comment-safe, color-independent. */
export const LANE_STATUS_ICON: Record<LaneStatus, string> = {
  passed: '✓',
  failed: '✗',
  skipped: '—',
  blocked: '⛔',
  unavailable: '⚠',
  inconclusive: '~',
}

/** Comment-flavored emoji per status — same ordering contract as the glyph. */
export const LANE_STATUS_EMOJI: Record<LaneStatus, string> = {
  passed: '✅',
  failed: '❌',
  skipped: '⚪',
  blocked: '⛔',
  unavailable: '⚠️',
  inconclusive: '🟡',
}

export interface LaneView {
  lane: LaneId
  selected: boolean
  status: LaneStatus
  statusLabel: string
  statusIcon: string
  summary: string | undefined
  reason: string | undefined
  reportPath: string | undefined
  model: string | undefined
  usage: UsageSummary
  budget: BudgetSummary
  cache: CacheSummary | undefined
  headBinding: HeadBinding | undefined
  startedAt: string | undefined
  finishedAt: string | undefined
  durationMs: number | undefined
}

export interface RunView {
  runId: string
  schemaVersion: number
  startedAt: string
  finishedAt: string
  status: LaneStatus
  statusLabel: string
  statusIcon: string
  ok: boolean
  costUsd: number
  calls: number
  tokens: number
  repo: string | undefined
  pr: string | undefined
  intendedHeadSha: string | undefined
  checkoutSha: string | undefined
  /** Review lane's head binding — the run-level binding contract. */
  headBinding: HeadBinding | undefined
  /** All lanes in LANE_IDS order — selection state included. */
  lanes: LaneView[]
  /** Only the lanes that ran or were asked to — the matrix surfaces show. */
  selectedLanes: LaneView[]
}

function laneDurationMs(lane: LaneManifest): number | undefined {
  if (lane.startedAt === undefined || lane.finishedAt === undefined) return undefined
  const ms = Date.parse(lane.finishedAt) - Date.parse(lane.startedAt)
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined
}

export function laneView(lane: LaneManifest): LaneView {
  return {
    lane: lane.lane,
    selected: lane.selected,
    status: lane.status,
    statusLabel: LANE_STATUS_LABEL[lane.status],
    statusIcon: LANE_STATUS_ICON[lane.status],
    summary: lane.summary,
    reason: lane.reason,
    reportPath: lane.reportPath,
    model: lane.model ?? lane.usage.model,
    usage: lane.usage,
    budget: lane.budget,
    cache: lane.cache,
    headBinding: lane.headBinding,
    startedAt: lane.startedAt,
    finishedAt: lane.finishedAt,
    durationMs: laneDurationMs(lane),
  }
}

export function manifestToRunView(manifest: RunManifest): RunView {
  const lanes = LANE_IDS.map((id) => laneView(manifest.lanes[id]))
  return {
    runId: manifest.runId,
    schemaVersion: manifest.schemaVersion,
    startedAt: manifest.startedAt,
    finishedAt: manifest.finishedAt,
    status: manifest.aggregate.status,
    statusLabel: LANE_STATUS_LABEL[manifest.aggregate.status],
    statusIcon: LANE_STATUS_ICON[manifest.aggregate.status],
    ok: manifest.aggregate.ok,
    costUsd: manifest.aggregate.costUsd,
    calls: manifest.aggregate.calls,
    tokens: manifest.aggregate.tokens,
    repo: manifest.identity.repo,
    pr: manifest.identity.pr,
    intendedHeadSha: manifest.identity.intendedHeadSha,
    checkoutSha: manifest.identity.checkoutSha,
    headBinding: manifest.lanes.review.headBinding,
    lanes,
    selectedLanes: lanes.filter((lane) => lane.selected),
  }
}

/** Structural validation — a manifest the view-model can trust enough to render. */
export function isRunManifest(value: unknown): value is RunManifest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const m = value as Partial<RunManifest>
  if (m.schemaVersion !== 1) return false
  if (typeof m.runId !== 'string' || typeof m.startedAt !== 'string') return false
  if (m.aggregate === undefined || typeof m.aggregate !== 'object') return false
  if (typeof m.aggregate.status !== 'string') return false
  if (m.lanes === undefined || typeof m.lanes !== 'object') return false
  for (const id of LANE_IDS) {
    const lane = m.lanes[id]
    if (lane === undefined || typeof lane !== 'object') return false
    if (typeof lane.lane !== 'string' || typeof lane.status !== 'string') return false
    if (!(LANE_STATUSES as readonly string[]).includes(lane.status)) return false
    if (typeof lane.selected !== 'boolean') return false
  }
  return true
}

/**
 * Evidence strings pass through a secret-shaped-token mask before render —
 * a lane summary that captured a credential must not re-emit it onto a PR
 * comment or dashboard (R16's sanitized-evidence surface).
 */
const SECRET_PATTERNS: RegExp[] = [
  /sk-or-[A-Za-z0-9_-]{4,}/g,
  /sk-[A-Za-z0-9_-]{8,}/g,
  /gh[pousr]_[A-Za-z0-9_]{8,}/g,
  /github_pat_[A-Za-z0-9_]{8,}/g,
  /xox[baprs]-[A-Za-z0-9-]{8,}/g,
  /AKIA[A-Z0-9]{16}/g,
  /npm_[A-Za-z0-9]{8,}/g,
]

export function maskSecrets(s: string): string {
  let out = s
  for (const re of SECRET_PATTERNS) out = out.replace(re, '•••')
  return out
}

export function formatUsd(n: number | undefined): string {
  return `$${(n ?? 0).toFixed(6)}`
}

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

export function shortSha(sha: string | undefined): string | undefined {
  return sha === undefined || sha === '' ? undefined : sha.slice(0, 7)
}
