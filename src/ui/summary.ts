import { LANE_IDS, type LaneId, type LaneStatus, type RunManifest } from '../report/manifest.js'
import { formatDuration, formatUsd, LANE_STATUS_LABEL, maskSecrets, shortSha } from '../report/viewmodel.js'
import type { Styler } from './style.js'

/**
 * End-of-run summary block for `run` and `verify` (R13, DESIGN.md 7.7), in
 * the same grammar as the PR comment: verdict line, one row per lane, then
 * total spend against budget and the report path.
 *
 *   ⊘ failed   head abc1234   38.1s
 *     ⊘ review   3 findings, 2 reproduced      $0.003100
 *     ● flow     4/4 journeys, 1 healed        $0.000000
 *     total $0.004210 of $1.00 budget · report argus-reviewer-report/run-manifest.json
 */

interface SummaryLane {
  lane: string
  status: LaneStatus
  detail: string
  costUsd: number
  /** false for lanes whose spend Argus cannot see (a0): shows "unmetered". */
  metered: boolean
  limitUsd?: number | undefined
  spentUsd?: number | undefined
  exceeded?: boolean | undefined
}

export interface SummaryInput {
  status: LaneStatus
  headSha?: string | undefined
  durationMs?: number | undefined
  lanes: SummaryLane[]
  totalUsd: number
  /** Sum of the lane caps; omitted when no lane has a dollar cap. */
  budgetUsd?: number | undefined
  reportPath?: string | undefined
}

/** The config key that raises each lane's dollar cap (ARGUS_BUDGET_USD overrides all). */
const BUDGET_KEY: Record<string, string> = {
  review: 'codeReviewBudgetUsd',
  flow: 'budgetUsd',
  app: 'app.budgetUsd',
}

const LANE_COL = 7
const COST_COL = 9
/**
 * A lane row is 2 indent + glyph + space + lane + 2, the detail, then 2 +
 * cost: 24 columns plus the detail. Six more columns of slack keep it clear
 * of the right edge.
 */
const FIXED_COLS = 2 + 1 + 1 + LANE_COL + 2 + 2 + COST_COL + 6
const DETAIL_MAX = 50
const DETAIL_MIN = 16

function fit(text: string, width: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= width ? flat.padEnd(width) : `${flat.slice(0, width - 1)}…`
}

const dollars = (n: number): string => `$${n.toFixed(2)}`

export function renderSummary(input: SummaryInput, style: Styler, width = 80): string[] {
  const head = [
    `${style.glyph(input.status)} ${style.bold(LANE_STATUS_LABEL[input.status])}`,
    ...(input.headSha !== undefined ? [`head ${input.headSha}`] : []),
    ...(input.durationMs !== undefined ? [formatDuration(input.durationMs)] : []),
  ].join('   ')
  const lines = [head]

  const detailWidth = Math.max(DETAIL_MIN, Math.min(DETAIL_MAX, width - FIXED_COLS))
  for (const lane of input.lanes) {
    const cost = lane.metered ? formatUsd(lane.costUsd) : 'unmetered'
    lines.push(
      `  ${style.glyph(lane.status)} ${lane.lane.padEnd(LANE_COL)}  ` +
        `${fit(maskSecrets(lane.detail), detailWidth)}  ${style.dim(cost.padStart(COST_COL))}`,
    )
  }
  for (const lane of input.lanes) {
    if (lane.exceeded !== true || lane.limitUsd === undefined) continue
    lines.push(
      `  ${style.glyph('failed')} budget exceeded: spent ${dollars(lane.spentUsd ?? lane.costUsd)} ` +
        `of ${dollars(lane.limitUsd)} (${lane.lane})`,
    )
    const key = BUDGET_KEY[lane.lane]
    if (key !== undefined) {
      lines.push(`    raise ${key} in the config, or set ARGUS_BUDGET_USD`)
    }
  }

  const total =
    `total ${formatUsd(input.totalUsd)}` +
    (input.budgetUsd !== undefined ? ` of ${dollars(input.budgetUsd)} budget` : '')
  if (input.reportPath === undefined) {
    lines.push(`  ${total}`)
  } else {
    const oneLine = `  ${total} · report ${input.reportPath}`
    // Too wide for one line: the report path gets its own, easy to copy.
    if (oneLine.length <= width) lines.push(oneLine)
    else lines.push(`  ${total}`, `  report ${input.reportPath}`)
  }
  return lines
}

function laneDetail(status: LaneStatus, summary: string | undefined, reason: string | undefined): string {
  // A lane that did not pass leads with why; a passing lane with what it found.
  const text = status === 'passed' ? (summary ?? reason) : (reason ?? summary)
  return text ?? LANE_STATUS_LABEL[status]
}

function durationOf(startedAt: string, finishedAt: string): number | undefined {
  const ms = Date.parse(finishedAt) - Date.parse(startedAt)
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined
}

/** Project a verify manifest onto the summary block. */
export function verifySummary(manifest: RunManifest, reportPath: string): SummaryInput {
  const lanes: SummaryLane[] = []
  let budget: number | undefined
  for (const id of LANE_IDS as readonly LaneId[]) {
    const lane = manifest.lanes[id]
    if (!lane.selected) continue
    lanes.push({
      lane: id,
      status: lane.status,
      detail: laneDetail(lane.status, lane.summary, lane.reason),
      costUsd: lane.usage.costUsd,
      metered: lane.usage.metered,
      limitUsd: lane.budget.limitUsd,
      spentUsd: lane.budget.spentUsd,
      exceeded: lane.budget.exceeded,
    })
    if (lane.budget.limitUsd !== undefined) budget = (budget ?? 0) + lane.budget.limitUsd
  }
  return {
    status: manifest.aggregate.status,
    headSha: shortSha(manifest.identity.intendedHeadSha ?? manifest.identity.checkoutSha),
    durationMs: durationOf(manifest.startedAt, manifest.finishedAt),
    lanes,
    totalUsd: manifest.aggregate.costUsd,
    budgetUsd: budget,
    reportPath,
  }
}
