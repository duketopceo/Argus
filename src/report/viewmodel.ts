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

/*
 * Ocellus vocabulary (DESIGN.md section 6.7, A4, A5). Text surfaces use these
 * glyphs: each is a single-cell, text-presentation code point, never emoji.
 * A status is always shown as glyph plus its LANE_STATUS_LABEL word.
 * `action/sticky-comment.cjs` keeps its own copy, guarded by parity tests.
 * LANE_STATUS_ICON above stays until its TUI and dashboard consumers move (U13).
 */

/** Status glyph per lane status; no two statuses share one. */
export const STATUS_GLYPH: Record<LaneStatus, string> = {
  passed: '●',
  failed: '⊘',
  skipped: '–',
  blocked: '⊖',
  unavailable: '◌',
  inconclusive: '◐',
}

/** Proof strength, weakest to strongest (A4 ladder). */
export const PROOF_LEVELS = ['suspected', 'corroborated', 'exercised', 'reproduced'] as const
export type ProofLevel = (typeof PROOF_LEVELS)[number]

const PROOF_NOTCH_FILLED = '▰'
const PROOF_NOTCH_EMPTY = '▱'

/**
 * Four-notch meter: one filled notch per ladder step reached. Any other
 * value (an evidence status outside the ladder, a missing level) is the
 * empty meter, so a renderer never throws on unexpected input.
 */
export function proofMeter(level: string | undefined): string {
  const filled = (PROOF_LEVELS as readonly string[]).indexOf(level ?? '') + 1
  return PROOF_NOTCH_FILLED.repeat(filled) + PROOF_NOTCH_EMPTY.repeat(PROOF_LEVELS.length - filled)
}

/** Finding severities as the review pipeline emits them (`q` is a question). */
export const SEVERITIES = ['bug', 'risk', 'nit', 'q'] as const
export type Severity = (typeof SEVERITIES)[number]

/** Geometric, shape-only severity glyphs (A5). */
export const SEVERITY_GLYPH: Record<Severity, string> = {
  bug: '◆',
  risk: '◈',
  nit: '○',
  q: '□',
}

export const SEVERITY_LABEL: Record<Severity, string> = {
  bug: 'bug',
  risk: 'risk',
  nit: 'nit',
  q: 'question',
}

/** Review verdicts as the synthesis step emits them. */
export const VERDICTS = ['approve', 'needs_changes', 'pass'] as const
export type Verdict = (typeof VERDICTS)[number]

/** Verdicts reuse status glyphs, so there is no third vocabulary. */
export const VERDICT_STATUS: Record<Verdict, LaneStatus> = {
  approve: 'passed',
  needs_changes: 'failed',
  pass: 'passed',
}

export const VERDICT_LABEL: Record<Verdict, string> = {
  approve: 'approve',
  needs_changes: 'needs changes',
  pass: 'clean',
}

export function verdictGlyph(verdict: Verdict): string {
  return STATUS_GLYPH[VERDICT_STATUS[verdict]]
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
    model: lane.model ?? lane.usage?.model,
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
  if (
    m.identity === undefined ||
    typeof m.identity !== 'object' ||
    m.identity === null ||
    Array.isArray(m.identity)
  ) {
    return false
  }
  for (const v of [
    m.identity.repo,
    m.identity.pr,
    m.identity.intendedHeadSha,
    m.identity.checkoutSha,
    m.identity.baseSha,
    m.identity.runNonce,
  ]) {
    if (v !== undefined && typeof v !== 'string') return false
  }
  const aggregate = m.aggregate
  if (aggregate === undefined || aggregate === null || typeof aggregate !== 'object') {
    return false
  }
  // aggregate.status feeds LANE_STATUS_LABEL lookups and ok the verdict —
  // a type-confused aggregate must degrade to last-valid, not reach a
  // renderer that throws mid-post.
  if (typeof aggregate.status !== 'string') return false
  if (!(LANE_STATUSES as readonly string[]).includes(aggregate.status)) return false
  if (typeof aggregate.ok !== 'boolean') return false
  for (const n of [aggregate.calls, aggregate.tokens, aggregate.costUsd]) {
    if (typeof n !== 'number' || !Number.isFinite(n)) return false
  }
  if (m.lanes === undefined || m.lanes === null || typeof m.lanes !== 'object') return false
  return LANE_IDS.every((id) => isLaneManifest((m.lanes as Record<string, unknown>)[id], id))
}

/**
 * One lane record the view-model can render. Exported so a surface that
 * degrades per lane (the HTML report) applies the same check as the whole-
 * manifest guard.
 */
export function isLaneManifest(value: unknown, id: LaneId): value is LaneManifest {
  if (value === undefined || value === null || typeof value !== 'object') return false
  const lane = value as Partial<LaneManifest>
  if (lane.lane !== id || typeof lane.status !== 'string') return false
  if (!(LANE_STATUSES as readonly string[]).includes(lane.status)) return false
  if (typeof lane.selected !== 'boolean') return false
  // usage/budget are dereferenced by laneView — a guard that certifies a
  // shape it doesn't check is a lying guard. `typeof null === 'object'`,
  // so a null here must be rejected before the field reads, not crash
  // inside the guard.
  if (lane.usage === null || lane.usage === undefined || typeof lane.usage !== 'object') {
    return false
  }
  for (const n of [lane.usage.calls, lane.usage.tokens, lane.usage.costUsd]) {
    if (typeof n !== 'number' || !Number.isFinite(n)) return false
  }
  if (lane.budget === null || lane.budget === undefined || typeof lane.budget !== 'object') {
    return false
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
  /Bearer\s+[A-Za-z0-9._~+/=-]{10,}/gi,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,
  /:\/\/[^/\s:@]{1,64}:[^/\s:@]{6,}@/g,
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
