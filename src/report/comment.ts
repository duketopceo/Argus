import type { LaneId, LaneStatus, RunManifest } from './manifest.js'
import { RunReport } from './run.js'
import {
  formatUsd,
  manifestToRunView,
  maskSecrets,
  PROOF_LEVELS,
  proofMeter,
  SEVERITY_GLYPH,
  shortSha,
  STATUS_GLYPH,
  VERDICT_LABEL,
  VERDICT_STATUS,
  type LaneView,
  type ProofLevel,
  type Verdict,
} from './viewmodel.js'

export const SENTINEL = '<!-- argus-reviewer -->'

/**
 * U4 incremental baseline — the machine-readable marker the sticky comment
 * carries so the next run can offer a new-commits-only diff. Emitted from a
 * completed review's `reviewedHeadSha` (never from skipped or
 * budget-exceeded runs); read back by `code-review`, which verifies the
 * stored SHA via the compare API + the commit status before honoring it —
 * the comment body is attacker-editable.
 */
export const LAST_REVIEWED_RE = /<!--\s*argus:last-reviewed-sha:([0-9a-f]{40})\s*-->/i

/**
 * Reference renderer for the sticky PR comment (plan U4, R6). NOT wired into
 * the action: `action/sticky-comment.cjs` is self-contained CJS and ships the
 * live renderer. This file renders the same grammar from the shared
 * view-model so the golden suite (tests/unit/comment-golden.test.ts) can pin
 * the two against each other: header, verdict line, lane table and findings
 * summary for every body, and the whole manifest-only and missing-key bodies.
 * Keep it honest or the parity suite guards nothing.
 */

export interface CommentMeta {
  /** Argus version shown in the footer. */
  version: string
  /** Link to the workflow run page (evidence and artifacts). */
  runUrl?: string
  /**
   * Workspace-relative path of this run's `report.html` (U14). Set only when
   * the manifest is fresh, so the footer never points at a planted file.
   */
  reportHtml?: string
}

/** The subset of code-review.json the comment head reads. */
export interface CodeReviewInput {
  ok?: boolean
  skipped?: boolean
  verdict?: string
  summary?: string
  visionCostUsd?: number
  provenBlockers?: number
  highConfidenceBlockers?: number
  findings?: {
    file?: string
    severity?: string
    p?: number
    suggestion?: string
    evidence?: { status?: string }
  }[]
  reviewComments?: { body?: string }[]
  headBinding?: { intendedSha?: string; status?: string; detail?: string }
  /** U4 — head SHA a completed review covered; the sticky baseline marker source. */
  reviewedHeadSha?: string
  /** U4 — incremental-review audit: verified baseline + covered commits. */
  incremental?: { since?: string; commits?: number; rejected?: string }
  /** U2 — generated-spec lane surface: per-spec status + the write PR URL. */
  generated?: {
    records?: { status?: string; validation?: string }[]
    prUrl?: string
  }
}

/** The subset of run.json the comment head reads. */
export type ReportInput = Pick<RunReport, 'ok' | 'durationMs'> & {
  totals: Pick<RunReport['totals'], 'tests' | 'passed' | 'visionCostUsd'>
  tests: { healEvents?: unknown[] }[]
}

/** One sticky-comment input, mirroring the action's five body renderers. */
export interface CommentInput {
  body: 'missing-key' | 'no-report' | 'manifest' | 'full' | 'review-only'
  ok?: boolean
  manifest?: RunManifest
  codeReview?: CodeReviewInput
  report?: ReportInput
  reportDir?: string
}

export type Proof = ProofLevel | 'none' | null

export interface LaneRow {
  lane: LaneId
  status: LaneStatus
  result: string
  proof: Proof
  spend: string
}

/** Cell semantics mirror the action: flatten newlines, escape pipes, mask secrets, cap length. */
export function cell(s: unknown, max = 200): string {
  return maskSecrets(
    String(s ?? '')
      .replace(/\|/g, '\\|')
      .replace(/[\r\n]+/g, ' '),
  ).slice(0, max)
}

export function code(s: unknown): string {
  const t = cell(s)
  const longest = Math.max(0, ...(t.match(/`+/g) ?? []).map((r) => r.length))
  const fence = '`'.repeat(longest + 1)
  const pad = t.startsWith('`') || t.endsWith('`') ? ' ' : ''
  return `${fence}${pad}${t}${pad}${fence}`
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

function formatDuration(ms: number | undefined): string | undefined {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return undefined
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
}

function statusText(status: LaneStatus): string {
  return `${STATUS_GLYPH[status]} ${status}`
}

function proofText(level: Proof): string {
  if (level === null) return ''
  if (level === 'none') return `${proofMeter(undefined)} none`
  return `${proofMeter(level)} ${level}`
}

export function findingsOf(cr: CodeReviewInput | undefined): NonNullable<CodeReviewInput['findings']> {
  return cr !== undefined && Array.isArray(cr.findings) ? cr.findings : []
}

export function bestFindingProof(cr: CodeReviewInput | undefined): ProofLevel {
  let best = 0
  for (const f of findingsOf(cr)) {
    best = Math.max(best, (PROOF_LEVELS as readonly string[]).indexOf(f.evidence?.status ?? ''))
  }
  return PROOF_LEVELS[best] ?? 'suspected'
}

export function laneProof(lane: LaneId, status: LaneStatus, cr: CodeReviewInput | undefined): Proof {
  if (status === 'skipped') return null
  if (status === 'blocked' || status === 'unavailable') return 'none'
  if (status === 'inconclusive' || lane === 'a0') return 'suspected'
  if (lane === 'review') return bestFindingProof(cr)
  return 'exercised'
}

export function manifestRow(lane: LaneView, cr: CodeReviewInput | undefined): LaneRow {
  if (!lane.selected) {
    return { lane: lane.lane, status: 'skipped', result: 'not selected', proof: null, spend: '' }
  }
  return {
    lane: lane.lane,
    status: lane.status,
    result: lane.reason ?? lane.summary ?? '',
    proof: laneProof(lane.lane, lane.status, cr),
    spend: lane.usage.metered ? formatUsd(lane.usage.costUsd) : 'unmetered',
  }
}

export function reproducedCount(cr: CodeReviewInput): number {
  return typeof cr.provenBlockers === 'number'
    ? cr.provenBlockers
    : findingsOf(cr).filter((f) => f.evidence?.status === 'reproduced').length
}

function reviewRow(cr: CodeReviewInput | undefined): LaneRow {
  if (cr === undefined) {
    return { lane: 'review', status: 'failed', result: 'no code-review.json', proof: 'none', spend: '' }
  }
  if (cr.skipped === true) {
    return { lane: 'review', status: 'skipped', result: cr.summary ?? 'skipped', proof: null, spend: '' }
  }
  const status: LaneStatus = cr.ok === true ? 'passed' : 'failed'
  return {
    lane: 'review',
    status,
    result: `${plural(findingsOf(cr).length, 'finding')}, ${reproducedCount(cr)} reproduced`,
    proof: laneProof('review', status, cr),
    spend: formatUsd(cr.visionCostUsd),
  }
}

function flowRow(report: ReportInput | undefined): LaneRow {
  if (report === undefined) {
    return { lane: 'flow', status: 'skipped', result: 'run lane disabled', proof: null, spend: '' }
  }
  const heals = report.tests.flatMap((t) => t.healEvents ?? []).length
  const status: LaneStatus = report.ok ? 'passed' : 'failed'
  return {
    lane: 'flow',
    status,
    result: `${report.totals.passed} of ${report.totals.tests} tests passed${heals > 0 ? `, ${heals} healed` : ''}`,
    proof: laneProof('flow', status, undefined),
    spend: formatUsd(report.totals.visionCostUsd),
  }
}

function laneTable(rows: LaneRow[]): string[] {
  const lines = ['| Status | Lane | Result | Proof | Spend |', '|---|---|---|---|--:|']
  for (const r of rows) {
    lines.push(
      `| ${statusText(r.status)} | ${cell(r.lane)} | ${cell(r.result)} | ${proofText(r.proof)} | ${r.spend} |`,
    )
  }
  return lines
}

function isVerdict(v: unknown): v is Verdict {
  return typeof v === 'string' && Object.hasOwn(VERDICT_LABEL, v)
}

/** Headline status and word, shared by the comment and the HTML report. */
export function verdictOf(
  ok: boolean | undefined,
  aggregate: LaneStatus | undefined,
  cr: CodeReviewInput | undefined,
): { status: LaneStatus; label: string } {
  const verdict = cr !== undefined && cr.skipped !== true && isVerdict(cr.verdict) ? cr.verdict : undefined
  if (ok !== true) {
    if (verdict === 'needs_changes') return { status: 'failed', label: VERDICT_LABEL.needs_changes }
    const s = aggregate !== undefined && aggregate !== 'passed' && aggregate !== 'skipped' ? aggregate : 'failed'
    return { status: s, label: s }
  }
  if (verdict !== undefined) return { status: VERDICT_STATUS[verdict], label: VERDICT_LABEL[verdict] }
  const s = aggregate ?? 'passed'
  return { status: s, label: s }
}

function headline(ok: boolean | undefined, aggregate: LaneStatus | undefined, cr: CodeReviewInput | undefined): string {
  const { status, label } = verdictOf(ok, aggregate, cr)
  return `${STATUS_GLYPH[status]} ${label}`
}

const settled = (s: LaneStatus) => s === 'passed' || s === 'skipped'

/** How a lead sentence marks up emphasis, code and plain text. */
export interface LeadFormat {
  strong: (s: string) => string
  code: (s: unknown) => string
  text: (s: unknown) => string
}

const MARKDOWN_LEAD: LeadFormat = { strong: (s) => `**${s}**`, code, text: cell }

/** The verdict line's lead: what the run proved, in one phrase. */
export function verdictLead(rows: LaneRow[], cr: CodeReviewInput | undefined, f: LeadFormat = MARKDOWN_LEAD): string {
  const findings = findingsOf(cr)
  const reviewed = cr !== undefined && cr.skipped !== true
  if (reviewed) {
    const reproduced = reproducedCount(cr)
    if (reproduced > 0) {
      const files = new Set(findings.filter((x) => x.evidence?.status === 'reproduced').map((x) => x.file))
      const where = files.size === 1 ? ` in ${f.code([...files][0])}` : ''
      return `${f.strong(`${plural(reproduced, 'finding')} reproduced`)}${where}`
    }
  }
  const failing = rows.filter((r) => r.lane !== 'review' && !settled(r.status))
  if (failing.length > 0) return f.strong(failing.map((r) => `${f.text(r.lane)} ${r.status}`).join(', '))
  if (reviewed && findings.length > 0) return f.strong(`${plural(findings.length, 'finding')}, none reproduced`)
  const review = rows.find((r) => r.lane === 'review')
  if (review !== undefined && !settled(review.status)) return f.strong(`review ${review.status}`)
  if (reviewed) return f.strong('No findings')
  return f.strong(rows.some((r) => r.status !== 'skipped') ? 'All selected lanes passed' : 'No lane ran')
}

function verdictLine(p: {
  rows: LaneRow[]
  cr: CodeReviewInput | undefined
  headSha: string | undefined
  binding: { status?: string } | undefined
  costUsd: number | undefined
  durationMs: number | undefined
}): string {
  const bits = [verdictLead(p.rows, p.cr)]
  const sha = shortSha(p.headSha)
  if (sha !== undefined) bits.push(`head ${code(sha)}`)
  if (p.binding?.status === 'mismatch') bits.push('head binding mismatch')
  const inc = p.cr?.incremental
  if (inc?.since !== undefined) {
    bits.push(
      `${typeof inc.commits === 'number' ? plural(inc.commits, 'commit') : 'incremental diff'} since ${code(shortSha(inc.since) ?? '?')}`,
    )
  }
  bits.push(formatUsd(p.costUsd))
  const duration = formatDuration(p.durationMs)
  if (duration !== undefined) bits.push(duration)
  return bits.join(' · ')
}

/** Must match P_FALLBACK_GATE in the action and P_TRUE_POSITIVE_THRESHOLD in src/cli.ts. */
const P_FALLBACK_GATE = 0.7

/** Same fence rule as the action's extractSuggestion: a committable block is non-empty. */
function hasSuggestion(body: string): boolean {
  const m = /\r?\n(`{4,})suggestion\r?\n([\s\S]*?)\r?\n\1/.exec(body)
  return m !== null && m[2] !== ''
}

const NO_REVIEW_REPORT = 'No code review report was found; check the action logs before merging.'
const NO_REVIEW_ATTACHED = 'No code review report is attached to this run.'

function findingsLine(cr: CodeReviewInput | undefined, missing = NO_REVIEW_REPORT): string {
  if (cr === undefined) return missing
  if (cr.skipped === true) return `Code review skipped: ${cell(cr.summary, 300)}`
  const findings = findingsOf(cr)
  const sev = { bug: 0, risk: 0, nit: 0, q: 0 }
  for (const f of findings) {
    if (f.severity !== undefined && Object.hasOwn(sev, f.severity)) sev[f.severity as keyof typeof sev] += 1
  }
  const parts = [
    `${SEVERITY_GLYPH.bug} ${plural(sev.bug, 'bug')}`,
    `${SEVERITY_GLYPH.risk} ${plural(sev.risk, 'risk')}`,
    `${SEVERITY_GLYPH.nit} ${plural(sev.nit, 'nit')}`,
  ]
  if (sev.q > 0) parts.push(`${SEVERITY_GLYPH.q} ${plural(sev.q, 'question')}`)
  const confident =
    typeof cr.highConfidenceBlockers === 'number'
      ? cr.highConfidenceBlockers
      : findings.filter((f) => typeof f.p === 'number' && f.p >= P_FALLBACK_GATE).length
  if (confident > 0) parts.push(`${confident} high-confidence`)
  const suggestions = Array.isArray(cr.reviewComments)
    ? cr.reviewComments.filter((c) => hasSuggestion(c.body ?? '')).length
    : findings.filter((f) => typeof f.suggestion === 'string' && f.suggestion !== '').length
  if (suggestions > 0) parts.push(`${plural(suggestions, 'suggestion')} ready to commit`)
  const gen = cr.generated
  if (Array.isArray(gen?.records) && gen.records.length > 0) {
    const committed = gen.records.filter((r) => r.status === 'committed').length
    const drafts = gen.records.length - committed
    parts.push(
      gen.prUrl !== undefined
        ? `${plural(committed, 'generated spec')} -> [review PR](${cell(gen.prUrl, 400)})` +
            (drafts > 0 ? `, ${drafts} draft${drafts === 1 ? '' : 's'}` : '')
        : `${plural(gen.records.length, 'generated spec')} (no PR opened)`,
    )
  }
  return parts.join(' · ')
}

function footer(meta: CommentMeta): string {
  const bits = [`Argus ${meta.version}`]
  if (meta.runUrl !== undefined) bits.push(`[workflow run and evidence](${meta.runUrl})`)
  if (meta.reportHtml !== undefined) bits.push(`report ${code(meta.reportHtml)} in the run artifacts`)
  bits.push('self-hosted, BYOK')
  return `<sub>${bits.join(' · ')}</sub>`
}

function head(status: string, verdict: string, rows: LaneRow[], summary: string): string[] {
  return [SENTINEL, `### Argus: ${status}`, '', verdict, '', ...laneTable(rows), '', summary, '']
}

function fold(lines: string[], title: string, body: string[]): void {
  if (body.length === 0) return
  lines.push('<details>', `<summary>${title}</summary>`, '', ...body)
  if (body[body.length - 1] !== '') lines.push('')
  lines.push('</details>', '')
}

const ALL_LANES: LaneId[] = ['review', 'flow', 'app', 'a0']

export function manifestDuration(m: RunManifest): number | undefined {
  const ms = Date.parse(m.finishedAt) - Date.parse(m.startedAt)
  return Number.isFinite(ms) ? ms : undefined
}

function headLines(input: CommentInput): string[] {
  const { manifest, codeReview: cr, report } = input
  const reviewed = cr !== undefined && cr.skipped !== true
  switch (input.body) {
    case 'missing-key':
      return head(
        statusText('skipped'),
        '**Not run:** `OPENROUTER_API_KEY` is not configured, so no lane ran. This status is neutral, not a failure.',
        ALL_LANES.map((lane) => ({ lane, status: 'skipped', result: 'no API key', proof: null, spend: '' })),
        'Fix: add the key as a repository secret, then re-run the workflow: `gh secret set OPENROUTER_API_KEY`',
      )
    case 'no-report':
      return head(
        statusText('failed'),
        `**No report:** the run step produced no \`run.json\` under ${code(input.reportDir)}. ` +
          'The commit status fails closed.',
        [{ lane: 'flow', status: 'failed', result: 'no run.json', proof: 'none', spend: '' }],
        'Check the action logs before merging.',
      )
    case 'manifest': {
      if (manifest === undefined) throw new Error('a manifest body needs a manifest')
      const m = manifest
      const rows = manifestToRunView(m).lanes.map((l) => manifestRow(l, cr))
      return head(
        headline(m.aggregate.ok, m.aggregate.status, cr),
        verdictLine({
          rows,
          cr,
          headSha: m.identity.intendedHeadSha,
          binding: m.lanes.review.headBinding,
          costUsd: m.aggregate.costUsd,
          durationMs: manifestDuration(m),
        }),
        rows,
        findingsLine(cr, NO_REVIEW_ATTACHED),
      )
    }
    case 'full':
    case 'review-only': {
      const flowReport = input.body === 'full' ? report : undefined
      const rows =
        manifest !== undefined
          ? manifestToRunView(manifest).lanes.map((l) => manifestRow(l, cr))
          : [reviewRow(cr), flowRow(flowReport)]
      const reviewSpend = reviewed ? (cr.visionCostUsd ?? 0) : 0
      const costUsd =
        manifest !== undefined
          ? manifest.aggregate.costUsd
          : input.body === 'full'
            ? (report?.totals.visionCostUsd ?? 0) + reviewSpend
            : reviewSpend
      const durationMs =
        manifest !== undefined ? manifestDuration(manifest) : input.body === 'full' ? report?.durationMs : undefined
      return head(
        headline(input.ok, manifest?.aggregate.status, cr),
        verdictLine({
          rows,
          cr,
          headSha: manifest?.identity.intendedHeadSha ?? (reviewed ? cr.headBinding?.intendedSha : undefined),
          binding: manifest?.lanes.review.headBinding ?? (reviewed ? cr.headBinding : undefined),
          costUsd,
          durationMs,
        }),
        rows,
        findingsLine(cr),
      )
    }
  }
}

/** First screen of any sticky body: sentinel through the findings summary. */
export function renderCommentHead(input: CommentInput): string {
  return headLines(input).join('\n')
}

export function renderMissingKeyComment(meta: CommentMeta): string {
  return [...headLines({ body: 'missing-key' }), footer(meta), ''].join('\n')
}

/**
 * Whole manifest-only body (no code-review folds): lane names, status labels,
 * model/cost and head identity come from the shared view-model so the
 * comment agrees with the TUI and dashboard under the contract test.
 */
export function renderManifestComment(manifest: RunManifest, meta: CommentMeta): string {
  const view = manifestToRunView(manifest)
  const lines = headLines({ body: 'manifest', manifest })

  const spend = ['| Lane | Model | Calls | Tokens | Spend |', '|---|---|--:|--:|--:|']
  for (const lane of view.selectedLanes) {
    const cost = lane.usage.metered ? formatUsd(lane.usage.costUsd) : 'unmetered'
    spend.push(
      `| ${cell(lane.lane)} | ${cell(lane.model ?? '')} | ${lane.usage.calls} | ${lane.usage.tokens} | ${cost} |`,
    )
  }
  spend.push(`| Total |  | ${view.calls} | ${view.tokens} | ${formatUsd(view.costUsd)} |`, '')
  const over = view.selectedLanes.filter((l) => l.budget.exceeded)
  if (over.length > 0) spend.push(`**Budget exceeded:** ${over.map((l) => cell(l.lane)).join(', ')}`, '')
  const cache = view.lanes.find((l) => l.lane === 'flow')?.cache
  if (cache !== undefined) {
    spend.push(`**Fingerprint cache:** ${cache.hits} hit(s) · ${cache.misses} miss(es) · ${cache.heals} heal(s)`, '')
  }
  fold(lines, 'Spend ledger', spend)

  const diagnostics: string[] = []
  if (view.headBinding !== undefined) {
    diagnostics.push(`- Head binding: ${cell(view.headBinding.status)}, ${cell(view.headBinding.detail)}`)
  }
  fold(lines, 'Diagnostics', diagnostics)

  lines.push(footer(meta), '')
  return lines.join('\n')
}

export type CheckConclusion = 'success' | 'failure' | 'neutral'

/** Map a run report (and optional missing-key flag) to a check-run conclusion. */
export function conclusionFromReport(
  report: RunReport | undefined,
  missingKey = false,
): CheckConclusion {
  if (missingKey) return 'neutral'
  if (!report) return 'failure'
  return report.ok ? 'success' : 'failure'
}
