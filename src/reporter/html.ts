import {
  EMPTY_STATES,
  FONT_FACES_CSS,
  MARK_SVG,
  SPRITE_SYMBOLS,
  TOKENS_CSS,
} from './brand-assets.generated.js'
import {
  findingsOf,
  laneProof,
  manifestDuration,
  manifestRow,
  plural,
  verdictLead,
  verdictOf,
  type CodeReviewInput,
  type LaneRow,
  type LeadFormat,
  type Proof,
} from './comment.js'
import { emptyLane, LANE_IDS, type LaneId, type LaneManifest, type LaneStatus, type RunManifest } from './manifest.js'
import {
  formatUsd,
  isLaneManifest,
  isRunManifest,
  laneView,
  maskSecrets,
  PROOF_LEVELS,
  SEVERITIES,
  SEVERITY_LABEL,
  shortSha,
  STATUS_GLYPH,
  type LaneView,
  type Severity,
} from './viewmodel.js'

/**
 * Offline HTML evidence report (plan U14, R22; DESIGN.md 7.6, A17).
 *
 * One self-contained `report.html` beside `run-manifest.json`: verdict,
 * lanes, findings, flow timeline, heals and spend ledger. Every asset is
 * inline (tokens, WOFF2 subsets as data URIs, the glyph sprite), so the file
 * opens from an artifact zip with no network. Assets come from the generated
 * module, never from assets/ on disk, so a packed install renders it too.
 *
 * Pure: the caller reads the files, this shapes them. Every interpolated
 * string goes through `esc`, which masks secret-shaped tokens and escapes
 * HTML. Inputs are untrusted JSON; a corrupt manifest renders the unreadable
 * state and a missing lane renders unavailable, never a throw.
 */

export const REPORT_HTML = 'report.html'

export interface ReportHtmlInput {
  /** run-manifest.json file text; undefined when the file is absent. */
  manifestText: string | undefined
  /** Parsed code-review.json of this run, when the review lane wrote one. */
  codeReview?: unknown
  /** Parsed run.json of this run, when the flow lane wrote one. */
  run?: unknown
  /** Argus version shown in the footer. */
  version: string
  /** Workflow run page (evidence and artifacts). */
  runUrl?: string
}

const REPO_URL = 'https://github.com/duketopceo/Argus'

// ---- Untrusted input shapes -------------------------------------------------

interface StepIn {
  instruction?: unknown
  action?: unknown
  ok?: unknown
  healed?: unknown
  model?: unknown
  reason?: unknown
}
interface AssertIn {
  question?: unknown
  verdict?: unknown
  reasoning?: unknown
  cached?: unknown
}
interface TestIn {
  name?: unknown
  file?: unknown
  ok?: unknown
  durationMs?: unknown
  failureMessage?: unknown
  steps?: unknown
  asserts?: unknown
  healEvents?: unknown
  videoPath?: unknown
}
interface RunIn {
  ok?: unknown
  durationMs?: unknown
  totals?: {
    tests?: unknown
    passed?: unknown
    visionCalls?: unknown
    visionCostUsd?: unknown
    callsByModel?: unknown
    costByModel?: unknown
  }
  tests?: unknown
}
interface FindingIn {
  file?: unknown
  line?: unknown
  startLine?: unknown
  severity?: unknown
  category?: unknown
  message?: unknown
  p?: unknown
  suggestion?: unknown
  evidence?: { status?: unknown; detail?: unknown }
}
interface CallIn {
  model?: unknown
  costUsd?: unknown
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v.filter(isObj) as T[]) : [])
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v !== '' ? v : undefined

// ---- Escaping and formatting ------------------------------------------------

/** Mask secret-shaped tokens, then escape for HTML text and attributes. */
function esc(v: unknown): string {
  return maskSecrets(String(v ?? ''))
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Totals: 4 decimals above a cent, else 6 so small spend stays visible. */
const usdTotal = (n: number | undefined) => ((n ?? 0) >= 0.01 ? `$${(n ?? 0).toFixed(4)}` : formatUsd(n))
/** Budget caps read as set: `$1.00`. */
const usdCap = (n: number) => `$${n.toFixed(2)}`

/** `450ms`, `12.3s`, `4m 05s`, `2h 14m` (DESIGN.md 6.2). */
function formatDuration(ms: number | undefined): string | undefined {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return undefined
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const s = Math.floor(ms / 1000)
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`
}

const SHA = /^[0-9a-f]{7,40}$/i
const REPO = /^[\w.-]+\/[\w.-]+$/
const SAFE_URL = /^https:\/\/[^\s"'<>`]+$/

// ---- Markup atoms -----------------------------------------------------------

function glyph(id: string, cls = ''): string {
  return `<svg class="g${cls ? ` ${cls}` : ''}" aria-hidden="true" focusable="false"><use href="#${id}"/></svg>`
}

const TONE: Record<LaneStatus, string> = {
  passed: 'passed',
  failed: 'failed',
  inconclusive: 'caution',
  blocked: 'ink',
  unavailable: 'muted',
  skipped: 'muted',
}

/**
 * The SVG glyph draws the status; the §6.7 text glyph rides along clipped
 * (and hidden from assistive tech), so copied or text-only output keeps the
 * same `◌ unavailable` vocabulary as the comment and terminal.
 */
function status(s: LaneStatus, word: string = s): string {
  return `<span class="st t-${TONE[s]}">${glyph(`status-${s}`)}<span class="tg" aria-hidden="true">${STATUS_GLYPH[s]} </span><span>${esc(word)}</span></span>`
}

function proof(level: Proof): string {
  if (level === null) return ''
  const n = level === 'none' ? 0 : PROOF_LEVELS.indexOf(level) + 1
  return `<span class="proof p${n}">${glyph(`proof-${n}`, 'meter')}<span>${level}</span></span>`
}

const SEVERITY_TONE: Record<Severity, string> = { bug: 'failed', risk: 'caution', nit: 'muted', q: 'muted' }
const SEVERITY_GLYPH_ID: Record<Severity, string> = {
  bug: 'severity-bug',
  risk: 'severity-risk',
  nit: 'severity-nit',
  q: 'severity-q',
}
const isSeverity = (v: unknown): v is Severity =>
  typeof v === 'string' && (SEVERITIES as readonly string[]).includes(v)

function severity(s: Severity): string {
  return `<span class="st t-${SEVERITY_TONE[s]}">${glyph(SEVERITY_GLYPH_ID[s])}<span>${SEVERITY_LABEL[s]}</span></span>`
}

function copyButton(value: string, label: string): string {
  return (
    `<button type="button" class="control copy" data-copy="${esc(value)}" aria-label="${esc(label)}">` +
    `${glyph('copy', 'i-copy')}${glyph('check', 'i-check')}</button>`
  )
}

function emptyState(name: string, sentence: string, command?: string): string {
  const art = EMPTY_STATES[name]
  const pic = art === undefined ? '' : `<div class="art art-light">${art.light}</div><div class="art art-dark">${art.dark}</div>`
  const cmd =
    command === undefined
      ? ''
      : `<p class="cmd"><code>${esc(command)}</code>${copyButton(command, `Copy command: ${command}`)}</p>`
  return `<div class="empty" aria-hidden="false">${pic}<p>${sentence}</p>${cmd}</div>`
}

function dl(rows: [string, string | undefined][]): string {
  const items = rows
    .filter((r): r is [string, string] => r[1] !== undefined && r[1] !== '')
    .map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`)
  return items.length === 0 ? '' : `<dl class="kv">${items.join('')}</dl>`
}

const HTML_LEAD: LeadFormat = {
  strong: (s) => `<strong>${s}</strong>`,
  code: (s) => `<code>${esc(s)}</code>`,
  text: esc,
}

// ---- Manifest ---------------------------------------------------------------

type ManifestState =
  | { state: 'ok'; manifest: RunManifest; missing: LaneId[] }
  | { state: 'missing' }
  | { state: 'unreadable'; detail: string }

/**
 * Parse the manifest text, degrading per lane: the run-level fields must
 * pass the shared guard, and each lane that fails `isLaneManifest` is
 * reported missing rather than sinking the whole report.
 */
function readManifest(text: string | undefined): ManifestState {
  if (text === undefined) return { state: 'missing' }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { state: 'unreadable', detail: 'did not parse' }
  }
  if (!isObj(value)) return { state: 'unreadable', detail: 'failed validation' }
  const lanesIn = isObj(value.lanes) ? value.lanes : {}
  const missing = LANE_IDS.filter((id) => !isLaneManifest(lanesIn[id], id))
  const lanes = Object.fromEntries(
    LANE_IDS.map((id) => [id, missing.includes(id) ? emptyLane(id, false) : lanesIn[id]]),
  )
  // Run-level fields go through the whole-manifest guard with the lanes it
  // already vetted, so the two checks cannot drift apart.
  const candidate = { ...value, lanes }
  if (!isRunManifest(candidate)) {
    return { state: 'unreadable', detail: 'failed validation' }
  }
  return { state: 'ok', manifest: candidate, missing }
}

// ---- Sections ---------------------------------------------------------------

interface Ctx {
  ms: ManifestState
  manifest: RunManifest | undefined
  missing: LaneId[]
  views: Partial<Record<LaneId, LaneView>>
  rows: LaneRow[]
  cr: CodeReviewInput | undefined
  crRaw: Record<string, unknown> | undefined
  run: RunIn | undefined
  repo: string | undefined
  head: string | undefined
}

const MISSING_ROW = (lane: LaneId): LaneRow => ({
  lane,
  status: 'unavailable',
  result: 'evidence missing',
  proof: 'none',
  spend: '',
})

function laneRowOf(c: Ctx, id: LaneId): LaneRow | undefined {
  return c.rows.find((r) => r.lane === id)
}

function verdictSection(c: Ctx): string {
  const m = c.manifest
  let v: { status: LaneStatus; label: string }
  if (m !== undefined) {
    v = verdictOf(m.aggregate.ok, m.aggregate.status, c.cr)
    // A lane record the file lost is missing evidence: never a clean pass.
    if (c.missing.length > 0 && v.status === 'passed') v = { status: 'inconclusive', label: 'inconclusive' }
  } else {
    v = { status: 'unavailable', label: c.ms.state === 'missing' ? 'no manifest' : 'manifest unreadable' }
  }
  const lead = m !== undefined || c.cr !== undefined ? verdictLead(c.rows, c.cr, HTML_LEAD) : ''

  const levels: Proof[] = c.rows.map((r) => r.proof)
  const best = levels.reduce<Proof>((acc, p) => {
    const rank = (x: Proof) => (x === null ? -1 : x === 'none' ? 0 : PROOF_LEVELS.indexOf(x) + 1)
    return rank(p) > rank(acc) ? p : acc
  }, null)

  const binding = m?.lanes.review.headBinding ?? (isObj(c.crRaw?.headBinding) ? (c.crRaw.headBinding as { status?: unknown; detail?: unknown }) : undefined)
  const bindingWord =
    binding?.status === 'not_applicable' ? 'fixture' : typeof binding?.status === 'string' ? binding.status : undefined
  const headCell =
    c.head === undefined
      ? undefined
      : `<code>${esc(shortSha(c.head))}</code>${SHA.test(c.head) ? copyButton(c.head, 'Copy head commit') : ''}` +
        (bindingWord !== undefined
          ? ` <span class="bind b-${bindingWord === 'mismatch' ? 'caution' : 'plain'}">${esc(bindingWord)}</span>`
          : '')

  let spend: string | undefined
  if (m !== undefined) {
    const selected = LANE_IDS.map((id) => m.lanes[id]).filter((l) => l.selected && l.usage.metered)
    const caps = selected.map((l) => num(l.budget.limitUsd))
    const known = caps.filter((x): x is number => x !== undefined)
    // A cap is shown only when every metered lane has one; a partial sum would understate it.
    const cap = known.length > 0 && known.length === caps.length ? known.reduce((a, b) => a + b, 0) : undefined
    spend = `<span class="fig">${usdTotal(m.aggregate.costUsd)}</span>${cap !== undefined ? ` <span class="of">of ${usdCap(cap)}</span>` : ''}`
  } else if (c.cr !== undefined && num(c.crRaw?.visionCostUsd) !== undefined) {
    spend = `<span class="fig">${usdTotal(num(c.crRaw?.visionCostUsd))}</span>`
  }
  const duration = m !== undefined ? formatDuration(manifestDuration(m)) : undefined
  const where =
    c.repo !== undefined
      ? `${esc(c.repo)}${m?.identity.pr !== undefined ? ` <span class="dim">#${esc(m.identity.pr)}</span>` : ''}`
      : undefined

  return `<section id="verdict" class="verdict" aria-labelledby="verdict-h">
<h1 id="verdict-h" class="headline t-${TONE[v.status]}">${glyph(`status-${v.status}`, 'big')}<span>${esc(v.label)}</span></h1>
${lead !== '' ? `<p class="lead">${lead}</p>` : ''}
${dl([
  ['Proof', best === null ? undefined : proof(best)],
  ['Head', headCell],
  ['Spend', spend],
  ['Duration', duration === undefined ? undefined : `<span class="data">${duration}</span>`],
  ['Repository', where],
])}
${binding?.status === 'mismatch' ? `<p class="banner t-caution">${glyph('status-inconclusive')}<span>Head binding mismatch: ${esc(binding.detail)}</span></p>` : ''}
</section>`
}

/** One wrapping line of lane facts under the lane row. */
function laneDetails(view: LaneView): string {
  const u = view.usage
  const duration = formatDuration(view.durationMs)
  const bits = [
    str(view.model) !== undefined ? `<code>${esc(view.model)}</code>` : undefined,
    duration !== undefined ? `<span class="data">${duration}</span>` : undefined,
    view.status !== 'skipped' ? `<span class="data">${plural(u.calls, 'call')}, ${u.tokens.toLocaleString('en-US')} tokens</span>` : undefined,
    str(view.reportPath) !== undefined ? `<code>${esc(view.reportPath)}</code>` : undefined,
  ].filter((b) => b !== undefined)
  const notes = [
    view.summary !== undefined && view.reason !== undefined && view.summary !== view.reason ? esc(view.summary) : undefined,
    // A matching binding is already in the header; only a problem earns a line here.
    view.headBinding !== undefined && view.headBinding.status !== 'match' && view.headBinding.status !== 'not_applicable'
      ? `Head ${esc(view.headBinding.status)}: ${esc(view.headBinding.detail)}`
      : undefined,
  ].filter((b) => b !== undefined)
  return (
    (bits.length > 0 ? `<p class="lane-facts">${bits.map((b) => `<span>${b}</span>`).join('')}</p>` : '') +
    notes.map((n) => `<p class="lane-note">${n}</p>`).join('')
  )
}

/** Escaped text with `backtick` spans set as code, as the model writes them. */
function prose(v: unknown): string {
  return esc(v).replace(/`([^`\n]+)`/g, '<code>$1</code>')
}

function lanesSection(c: Ctx): string {
  if (c.manifest === undefined) {
    const sentence =
      c.ms.state === 'unreadable'
      ? `<strong>Manifest unreadable:</strong> <code>run-manifest.json</code> ${esc(c.ms.detail)}, so lane results are unknown. Re-run verify to write a fresh one.`
      : '<strong>No manifest:</strong> this run wrote no <code>run-manifest.json</code>, so lane results are unknown. Run verify to produce one.'
    return `<section id="lanes" aria-labelledby="lanes-h"><h2 id="lanes-h">Lanes</h2>${emptyState('manifest-unreadable', sentence, 'argus-reviewer verify')}</section>`
  }
  const items = LANE_IDS.map((id) => {
    const row = laneRowOf(c, id) ?? MISSING_ROW(id)
    const view = c.views[id]
    const resultText =
      row.status === 'unavailable' && row.result === 'evidence missing'
        ? `<span class="t-muted">evidence missing</span>`
        : esc(row.result)
    return `<li class="lane${view?.selected === false ? ' off' : ''}" id="lane-${id}">
<div class="lane-head">${status(row.status)}<span class="lane-name">${glyph(`lane-${id}`, 'lg')}${id}</span><span class="lane-result">${resultText}</span><span class="lane-proof">${proof(row.proof)}</span><span class="lane-spend data">${esc(row.spend)}</span></div>
${view !== undefined && view.selected ? laneDetails(view) : ''}
</li>`
  })
  return `<section id="lanes" aria-labelledby="lanes-h"><h2 id="lanes-h">Lanes</h2><ul class="lanes">${items.join('\n')}</ul></section>`
}

function fileLink(c: Ctx, file: string, line: number | undefined): string {
  const label = `${file}${line !== undefined ? `:${line}` : ''}`
  if (c.repo !== undefined && REPO.test(c.repo) && c.head !== undefined && SHA.test(c.head) && !/[\s"'<>`]/.test(file) && !file.includes('..')) {
    const href = `https://github.com/${c.repo}/blob/${c.head}/${file.split('/').map(encodeURIComponent).join('/')}${line !== undefined ? `#L${line}` : ''}`
    return `<a class="path" href="${esc(href)}"><code>${esc(label)}</code></a>`
  }
  return `<code class="path">${esc(label)}</code>`
}

function findingsSection(c: Ctx): string {
  const head = (n?: number) =>
    `<h2 id="findings-h">Findings${n !== undefined ? ` <span class="count">${n}</span>` : ''}</h2>`
  if (c.cr === undefined) {
    const review = c.manifest?.lanes.review
    const sentence =
      c.manifest === undefined || review?.selected === true
        ? 'No code review report is attached to this run.'
        : 'Code review did not run in this verify, so there are no findings to show.'
    return `<section id="findings" aria-labelledby="findings-h">${head()}<p class="note">${sentence}</p></section>`
  }
  if (c.cr.skipped === true) {
    return `<section id="findings" aria-labelledby="findings-h">${head()}<p class="note">Code review skipped: ${esc(c.cr.summary ?? 'no reason given')}</p></section>`
  }
  const findings = arr<FindingIn>(findingsOf(c.cr))
  const rank = (f: FindingIn) => (isSeverity(f.severity) ? SEVERITIES.indexOf(f.severity) : SEVERITIES.length)
  const proofRank = (f: FindingIn) => PROOF_LEVELS.indexOf(f.evidence?.status as never)
  const sorted = [...findings].sort((a, b) => rank(a) - rank(b) || proofRank(b) - proofRank(a))
  const counts = SEVERITIES.map((s) => [s, findings.filter((f) => f.severity === s).length] as const)
  const summary = counts
    .filter(([s, n]) => n > 0 || s !== 'q')
    .map(([s, n]) => `<span class="st t-${SEVERITY_TONE[s]}">${glyph(SEVERITY_GLYPH_ID[s])}<span>${plural(n, SEVERITY_LABEL[s], s === 'q' ? 'questions' : undefined)}</span></span>`)
    .join('')
  if (findings.length === 0) {
    return `<section id="findings" aria-labelledby="findings-h">${head(0)}<p class="note">No findings: the review read the diff and raised nothing.</p></section>`
  }
  const items = sorted.map((f, i) => {
    const sev = isSeverity(f.severity) ? severity(f.severity) : `<span class="st t-muted">${esc(f.severity ?? 'finding')}</span>`
    const file = str(f.file)
    const line = num(f.line)
    const ev = f.evidence
    const level = typeof ev?.status === 'string' && (PROOF_LEVELS as readonly string[]).includes(ev.status) ? (ev.status as Proof) : 'suspected'
    const evidenceNote =
      ev !== undefined && (str(ev.detail) !== undefined || (typeof ev.status === 'string' && level !== ev.status))
        ? `<p class="evidence">Evidence${typeof ev.status === 'string' && ev.status !== level ? ` (${esc(ev.status)})` : ''}: ${esc(ev.detail ?? '')}</p>`
        : ''
    const p = num(f.p)
    const suggestion = str(f.suggestion)
    const meta = [
      str(f.category) !== undefined ? esc(f.category) : undefined,
      p !== undefined ? `confidence <span class="data">${p.toFixed(2)}</span>` : undefined,
    ].filter(Boolean)
    return `<li class="finding" id="finding-${i + 1}">
<div class="finding-head">${sev}${file !== undefined ? `<span class="loc">${fileLink(c, file, line)}${copyButton(`${file}${line !== undefined ? `:${line}` : ''}`, `Copy path ${file}`)}</span>` : ''}<span class="finding-proof">${proof(level)}</span></div>
<p class="msg">${prose(f.message ?? '')}</p>
${meta.length > 0 ? `<p class="meta">${meta.join(' · ')}</p>` : ''}
${evidenceNote}
${suggestion !== undefined ? `<details class="suggest"><summary class="control-ish">Suggested change</summary><pre class="diff">${suggestion.split('\n').map((l) => `<span class="add">+ ${esc(l)}</span>`).join('\n')}</pre></details>` : ''}
</li>`
  })
  return `<section id="findings" aria-labelledby="findings-h">${head(findings.length)}<p class="sev">${summary}</p><ol class="findings">${items.join('\n')}</ol></section>`
}

function stepsList(steps: StepIn[]): string {
  if (steps.length === 0) return ''
  const items = steps.map((s) => {
    const ok = s.ok === true
    const chips = [
      s.healed === true ? '<span class="chip t-caution">healed</span>' : '',
      str(s.model) !== undefined ? `<code class="dim">${esc(s.model)}</code>` : '',
    ].join('')
    return `<li class="step">${glyph(ok ? 'status-passed' : 'status-failed', ok ? 'node t-passed' : 'node t-failed')}<div><p>${esc(s.instruction ?? '')}${chips !== '' ? ` ${chips}` : ''}</p>${str(s.action) !== undefined ? `<p class="act"><code>${esc(s.action)}</code></p>` : ''}${str(s.reason) !== undefined ? `<p class="why">${esc(s.reason)}</p>` : ''}</div></li>`
  })
  return `<ol class="timeline" aria-label="Steps">${items.join('')}</ol>`
}

function assertsList(asserts: AssertIn[]): string {
  if (asserts.length === 0) return ''
  const items = asserts.map((a) => {
    const pass = a.verdict === 'pass'
    return `<li class="step">${glyph(pass ? 'status-passed' : 'status-failed', pass ? 'node t-passed' : 'node t-failed')}<div><p>Check: ${esc(a.question ?? '')}${a.cached === true ? ' <span class="chip">cached</span>' : ''}</p>${str(a.reasoning) !== undefined ? `<p class="why">${esc(a.reasoning)}</p>` : ''}</div></li>`
  })
  return `<ol class="timeline" aria-label="Checks">${items.join('')}</ol>`
}

function flowSection(c: Ctx): string {
  const h = '<h2 id="flow-h">Flow</h2>'
  const wrap = (body: string) => `<section id="flow" aria-labelledby="flow-h">${h}${body}</section>`
  if (c.missing.includes('flow')) {
    return wrap(`<p class="lane-line">${status('unavailable', 'unavailable: evidence missing')}</p><p class="note">The manifest has no readable flow lane record, so this run's flow result is unknown.</p>`)
  }
  const lane = c.manifest?.lanes.flow
  if (lane !== undefined && !lane.selected) {
    return wrap(`<p class="note">${status('skipped')} Not selected. Run <code>argus-reviewer verify --flow</code> to replay recorded flows.</p>`)
  }
  const head = lane !== undefined ? `<p class="lane-line">${status(lane.status)}<span>${esc(lane.reason ?? lane.summary ?? '')}</span></p>` : ''
  if (c.run === undefined) {
    return wrap(`${head}<p class="note">Step timeline unavailable: no <code>run.json</code> from the flow lane is attached to this run.</p>`)
  }
  const t = c.run.totals ?? {}
  const tests = arr<TestIn>(c.run.tests)
  const cache = lane?.cache
  const nTests = num(t.tests)
  const nCalls = num(t.visionCalls)
  const facts = [
    nTests !== undefined ? `${num(t.passed) ?? 0} of ${plural(nTests, 'test')} passed` : undefined,
    nCalls !== undefined ? plural(nCalls, 'vision call') : undefined,
    cache !== undefined ? `cache ${cache.hits} hit${cache.hits === 1 ? '' : 's'}, ${cache.misses} miss${cache.misses === 1 ? '' : 'es'}, ${plural(cache.heals, 'heal')}` : undefined,
    formatDuration(num(c.run.durationMs)),
  ].filter(Boolean)
  const items = tests.map((test, i) => {
    const ok = test.ok === true
    const steps = arr<StepIn>(test.steps)
    const asserts = arr<AssertIn>(test.asserts)
    const video = str(test.videoPath)
    const dur = formatDuration(num(test.durationMs))
    const body = stepsList(steps) + assertsList(asserts)
    return `<li class="test" id="test-${i + 1}">
<div class="test-head">${status(ok ? 'passed' : 'failed')}<span class="test-name">${esc(test.name ?? `test ${i + 1}`)}</span><code class="dim">${esc(test.file ?? '')}</code>${dur !== undefined ? `<span class="data dim">${dur}</span>` : ''}</div>
${str(test.failureMessage) !== undefined ? `<p class="why t-failed">${esc(test.failureMessage)}</p>` : ''}
${body !== '' ? body : '<p class="note">No step records: every step replayed from the cache or the test had none.</p>'}
${video !== undefined ? `<p class="meta">Video in the artifact: <code>${esc(video)}</code></p>` : ''}
</li>`
  })
  return wrap(`${head}${facts.length > 0 ? `<p class="meta data">${facts.join(' · ')}</p>` : ''}${items.length > 0 ? `<ol class="tests">${items.join('\n')}</ol>` : '<p class="note">The flow lane ran no tests.</p>'}`)
}

function healsSection(c: Ctx): string {
  const h = (n?: number) => `<h2 id="heals-h">Heals${n !== undefined ? ` <span class="count">${n}</span>` : ''}</h2>`
  const wrap = (n: number | undefined, body: string) => `<section id="heals" aria-labelledby="heals-h">${h(n)}${body}</section>`
  if (c.run === undefined) {
    return wrap(undefined, emptyState('nothing-to-heal', 'Heals come from the flow lane, and it left no record in this run.', 'argus-reviewer verify --flow'))
  }
  const heals = arr<TestIn>(c.run.tests).flatMap((t) =>
    arr<{ instruction?: unknown; model?: unknown }>(t.healEvents).map((e) => ({ test: t.name, ...e })),
  )
  if (heals.length === 0) {
    return wrap(0, emptyState('nothing-to-heal', 'Nothing to heal: every cached target matched.', 'argus-reviewer cache list'))
  }
  const items = heals.map(
    (e) =>
      `<li class="heal">${glyph('status-inconclusive', 't-caution')}<div><p><strong>${esc(e.instruction ?? '')}</strong></p><p class="meta">in ${esc(e.test ?? 'a test')}${str(e.model) !== undefined ? ` · re-grounded by <code>${esc(e.model)}</code>` : ''}</p></div></li>`,
  )
  return wrap(
    heals.length,
    `<p class="note">A heal means a cached target stopped matching and the model found it again. Review each before merging: the cache now points at the new target.</p><ul class="heals">${items.join('')}</ul>`,
  )
}

/** 20 ticks, no filled track; the text always says the numbers (DESIGN.md 6.8). */
function tally(spent: number, limit: number | undefined, exceeded: boolean): string {
  if (limit === undefined || limit <= 0) return `<span class="data">${formatUsd(spent)}</span> <span class="dim">no cap</span>`
  const ratio = spent / limit
  const tone = exceeded || ratio > 1 ? 'failed' : ratio >= 0.8 ? 'caution' : 'plain'
  const filled = Math.min(20, Math.round(ratio * 20))
  const ticks = Array.from({ length: 20 }, (_, i) => `<i${i < filled ? ' class="on"' : ''}></i>`).join('')
  return `<span class="tally t-${tone}"><span class="ticks" aria-hidden="true">${ticks}</span><span class="data">spent ${formatUsd(spent)} of ${usdCap(limit)}</span>${exceeded ? ' <strong class="t-failed">exceeded</strong>' : ''}</span>`
}

function ledgerRows(
  c: Ctx,
): { lane: string; model: string; calls: number; tokens: number; spend: string; budget: string; exceeded: boolean }[] {
  const m = c.manifest
  if (m === undefined) return []
  return LANE_IDS.filter((id) => !c.missing.includes(id) && m.lanes[id].selected).map((id) => {
    const l: LaneManifest = m.lanes[id]
    const metered = l.usage.metered
    return {
      lane: id,
      model: l.model ?? l.usage.model ?? '',
      calls: l.usage.calls,
      tokens: l.usage.tokens,
      spend: metered ? formatUsd(l.usage.costUsd) : 'unmetered',
      budget: metered ? tally(l.usage.costUsd, l.budget.limitUsd ?? undefined, l.budget.exceeded) : '<span class="dim">unmetered</span>',
      exceeded: l.budget.exceeded === true,
    }
  })
}

function byModel(c: Ctx): [string, number, number][] {
  const rows = new Map<string, [number, number]>()
  const add = (model: string, calls: number, cost: number) => {
    const r = rows.get(model) ?? [0, 0]
    rows.set(model, [r[0] + calls, r[1] + cost])
  }
  for (const call of arr<CallIn>(c.crRaw?.calls)) add(String(call.model ?? 'unknown'), 1, num(call.costUsd) ?? 0)
  const t = c.run?.totals
  if (isObj(t?.callsByModel)) {
    for (const [model, calls] of Object.entries(t.callsByModel)) {
      add(model, num(calls) ?? 0, isObj(t.costByModel) ? (num(t.costByModel[model]) ?? 0) : 0)
    }
  }
  return [...rows.entries()].map(([k, [n, cost]]) => [k, n, cost] as [string, number, number]).sort((a, b) => b[2] - a[2] || a[0].localeCompare(b[0]))
}

function ledgerSection(c: Ctx): string {
  const h = '<h2 id="ledger-h">Spend ledger</h2>'
  const m = c.manifest
  if (m === undefined) {
    return `<section id="ledger" aria-labelledby="ledger-h">${h}<p class="note">Spend is recorded in the manifest, which this run does not have in readable form.</p></section>`
  }
  const rows = ledgerRows(c)
  const body = rows
    .map(
      (r) =>
        `<tr><th scope="row">${glyph(`lane-${r.lane}`, 'lg')}${r.lane}</th><td><code>${esc(r.model)}</code></td><td class="num">${r.calls}</td><td class="num">${r.tokens.toLocaleString('en-US')}</td><td class="num">${r.spend}</td><td>${r.budget}</td></tr>`,
    )
    .join('')
  const models = byModel(c)
  const over = rows.filter((r) => r.exceeded)
  return `<section id="ledger" aria-labelledby="ledger-h">${h}
<div class="scroll"><table class="ledger"><thead><tr><th scope="col">Lane</th><th scope="col">Model</th><th scope="col" class="num">Calls</th><th scope="col" class="num">Tokens</th><th scope="col" class="num">Spend</th><th scope="col">Budget</th></tr></thead>
<tbody>${body}</tbody>
<tfoot><tr><th scope="row">Total</th><td></td><td class="num">${m.aggregate.calls}</td><td class="num">${m.aggregate.tokens.toLocaleString('en-US')}</td><td class="num">${usdTotal(m.aggregate.costUsd)}</td><td></td></tr></tfoot></table></div>
${over.length > 0 ? `<p class="banner t-failed">${glyph('status-failed')}<span>Budget exceeded: ${over.map((r) => r.lane).join(', ')}</span></p>` : ''}
${
  models.length > 0
    ? `<h3>By model</h3><div class="scroll"><table class="ledger"><thead><tr><th scope="col">Model</th><th scope="col" class="num">Calls</th><th scope="col" class="num">Spend</th></tr></thead><tbody>${models
        .map(([k, n, cost]) => `<tr><td><code>${esc(k)}</code></td><td class="num">${n}</td><td class="num">${formatUsd(cost)}</td></tr>`)
        .join('')}</tbody></table></div>`
    : ''
}
</section>`
}

function rail(c: Ctx): string {
  const links: [string, string][] = [
    ['verdict', 'Verdict'],
    ['lanes', 'Lanes'],
    ['findings', 'Findings'],
    ['flow', 'Flow'],
    ['heals', 'Heals'],
    ['ledger', 'Spend ledger'],
  ]
  const m = c.manifest
  const spend =
    m !== undefined
      ? `<div class="rail-spend"><p class="cap">Total spend</p><p class="fig">${usdTotal(m.aggregate.costUsd)}</p><p class="dim data">${plural(m.aggregate.calls, 'call')}</p></div>`
      : ''
  return `<aside class="rail control" aria-label="Report navigation"><nav class="control" aria-label="Sections"><ul>${links
    .map(([id, label]) => `<li><a href="#${id}">${label}</a></li>`)
    .join('')}</ul></nav>${spend}</aside>`
}

// ---- Styles -----------------------------------------------------------------

/** Light color tokens, re-applied for print so paper is always light. */
const LIGHT_COLORS = (/:root\s*\{([^}]*)\}/.exec(TOKENS_CSS)?.[1] ?? '')
  .split('\n')
  .filter((l) => l.includes('--argus-color-'))
  .map((l) => l.replace(/\/\*.*\*\//, '').trim())
  .join('\n    ')

const CSS = `
:root {
  --canvas: var(--argus-color-canvas);
  --surface: var(--argus-color-surface);
  --sunk: var(--argus-color-surface-sunk);
  --hairline: var(--argus-color-hairline);
  --control: var(--argus-color-control-border);
  --ink: var(--argus-color-ink);
  --ink-2: var(--argus-color-ink-2);
  --ink-3: var(--argus-color-ink-3);
  --accent: var(--argus-color-accent);
  --passed: var(--argus-color-passed);
  --failed: var(--argus-color-failed);
  --caution: var(--argus-color-caution);
  --passed-tint: var(--argus-color-passed-tint);
  --failed-tint: var(--argus-color-failed-tint);
  --caution-tint: var(--argus-color-caution-tint);
  --sans: var(--argus-font-sans);
  --mono: var(--argus-font-mono);
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root { color-scheme: dark; }
  .art-light { display: none; }
}
@media (prefers-color-scheme: light) {
  .art-dark { display: none; }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--canvas);
  color: var(--ink);
  font: 400 14px/21px var(--sans);
  -webkit-font-smoothing: antialiased;
  overflow-x: hidden;
}
h1, h2, h3, p, dl, dd, ol, ul, figure { margin: 0; }
ol, ul { padding: 0; list-style: none; }
code, .data, .num, .fig, pre {
  font-family: var(--mono);
  font-stretch: 87.5%;
  font-weight: 450;
  font-feature-settings: 'tnum', 'zero';
  /* Code is quoted, never typeset: <= must not become a ligature. */
  font-variant-ligatures: none;
}
code, .data { font-size: 13px; line-height: 19px; }
code { overflow-wrap: anywhere; }
a { color: var(--accent); text-underline-offset: 2px; }
a:focus-visible, button:focus-visible, summary:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  border-radius: var(--argus-radius-xs);
}
.dim { color: var(--ink-3); }
.t-passed { color: var(--passed); }
.t-failed { color: var(--failed); }
.t-caution { color: var(--caution); }
.t-ink { color: var(--ink); }
.t-muted { color: var(--ink-3); }
.t-plain { color: var(--ink-2); }
.tg { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: pre; }
.g { width: 1em; height: 1em; flex: none; vertical-align: -0.125em; }
.g.lg { width: 16px; height: 16px; color: var(--ink-3); margin-right: 6px; }
.skip {
  position: absolute; left: 16px; top: -48px; padding: 4px 8px; background: var(--surface);
  border: 1px solid var(--control); border-radius: var(--argus-radius-sm); z-index: 2;
}
.skip:focus { top: 8px; }

.page {
  display: grid;
  grid-template-columns: minmax(0, 880px);
  justify-content: center;
  column-gap: 48px;
  padding: 0 16px;
}
.masthead, .foot { grid-column: 1 / -1; }
.masthead {
  display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px;
  justify-content: space-between;
  padding: 24px 0 16px;
  border-bottom: 1px solid var(--hairline);
}
.brand { display: flex; align-items: center; gap: 8px; font: 600 15px/22px var(--sans); }
.brand svg { width: 24px; height: 24px; color: var(--accent); }
.brand .dim { font-weight: 400; }
.runid { display: flex; align-items: center; gap: 4px; color: var(--ink-3); min-width: 0; }
.runid code { font-size: 12px; line-height: 16px; }
main { min-width: 0; }
section { padding: 32px 0; border-bottom: 1px solid var(--hairline); }
section:last-child { border-bottom: 0; }
h2 { font: 600 15px/22px var(--sans); margin-bottom: 16px; display: flex; align-items: baseline; gap: 8px; }
h3 { font: 600 13px/19px var(--sans); color: var(--ink-2); margin: 24px 0 8px; }
.count { font: 450 13px/19px var(--mono); font-stretch: 87.5%; color: var(--ink-3); }
.note { color: var(--ink-2); }
.note .st { margin-right: 8px; }
.meta { color: var(--ink-3); font-size: 13px; line-height: 19px; }

.verdict { padding-top: 32px; }
.headline { display: flex; align-items: center; gap: 12px; font: 650 36px/40px var(--sans); letter-spacing: -0.015em; }
.headline span { color: var(--ink); }
.headline .big { width: 32px; height: 32px; }
.lead { margin-top: 12px; font: 400 17px/26px var(--sans); color: var(--ink-2); text-wrap: pretty; }
.lead strong { color: var(--ink); font-weight: 600; }
.verdict .kv { margin-top: 24px; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
.kv { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px 24px; }
.kv > div { min-width: 0; }
.kv dt { font: 500 12px/16px var(--sans); color: var(--ink-3); margin-bottom: 2px; }
.kv dd { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; min-width: 0; color: var(--ink-2); }
.verdict .kv dd { color: var(--ink); }
.fig { font-size: 20px; line-height: 28px; font-weight: 500; font-stretch: 100%; }
.of { color: var(--ink-3); font: 450 13px/19px var(--mono); font-stretch: 87.5%; }
.bind { font: 500 12px/16px var(--sans); padding: 0 6px; border-radius: var(--argus-radius-xs); border: 1px solid var(--hairline); color: var(--ink-2); }
.bind.b-caution { color: var(--caution); border-color: currentColor; }
.banner {
  display: flex; gap: 8px; align-items: baseline; margin-top: 16px; padding: 8px 12px;
  border: 1px solid currentColor; border-radius: var(--argus-radius-sm);
}
.banner span { color: var(--ink); }

.st { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
.st > span { color: var(--ink); }
.t-muted.st > span { color: var(--ink-3); }
.proof { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; color: var(--ink-2); font-size: 13px; }
.proof .meter { width: 24px; height: 24px; margin: -4px 0; color: var(--ink-2); }
.proof.p4 .meter { color: var(--ink); }
.proof.p0 .meter { color: var(--ink-3); }

.lanes > li { padding: 12px 0; border-top: 1px solid var(--hairline); }
.lanes > li:first-child { border-top: 0; padding-top: 0; }
.lane-head {
  display: grid; align-items: center; column-gap: 16px; row-gap: 4px;
  grid-template-columns: 128px 72px minmax(0, 1fr) auto 96px;
}
.lane-name { display: inline-flex; align-items: center; font-weight: 600; }
.lane-result { color: var(--ink-2); min-width: 0; overflow-wrap: anywhere; }
.lane-spend { text-align: right; color: var(--ink-2); }
.lane.off .lane-name, .lane.off .lane-result { color: var(--ink-3); }
.lane-facts, .lane-note { margin: 4px 0 0 144px; color: var(--ink-3); font-size: 13px; line-height: 19px; }
.lane-facts { display: flex; flex-wrap: wrap; gap: 0 16px; }
.lane-facts code, .lane-facts .data { color: var(--ink-2); font-size: 12px; line-height: 19px; }
.lane-note { color: var(--ink-2); }

.sev { display: flex; flex-wrap: wrap; gap: 4px 16px; margin-bottom: 16px; }
.findings > li { padding: 16px 0; border-top: 1px solid var(--hairline); }
.finding-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; }
.finding-head .st { min-width: 72px; }
.loc { display: inline-flex; align-items: center; gap: 2px; min-width: 0; }
.finding-proof { margin-left: auto; }
.msg code { background: var(--sunk); padding: 0 4px; border-radius: var(--argus-radius-xs); }
.msg { margin-top: 8px; color: var(--ink); max-width: 72ch; text-wrap: pretty; }
.finding .meta, .evidence { margin-top: 4px; }
.evidence { color: var(--ink-2); font-size: 13px; line-height: 19px; }
.suggest { margin-top: 12px; }
.suggest summary {
  cursor: pointer; display: inline-flex; align-items: center; min-height: 24px;
  color: var(--accent); font-weight: 500;
}
.diff {
  margin: 8px 0 0; padding: 12px; overflow-x: auto; background: var(--sunk);
  border-radius: var(--argus-radius-md); font-size: 12px; line-height: 18px;
}
.diff .add { color: var(--passed); display: block; white-space: pre; }

.lane-line { display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; margin-bottom: 4px; }
.lane-line > span:last-child { color: var(--ink-2); }
.tests { margin-top: 16px; }
.tests > li { padding: 16px 0; border-top: 1px solid var(--hairline); }
.test-head { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; }
.test-name { font-weight: 600; }
.timeline { margin: 12px 0 0 7px; border-left: 1px solid var(--hairline); }
.timeline .step { position: relative; display: flex; gap: 12px; padding: 0 0 12px 0; margin-left: -8px; }
.timeline .step:last-child { padding-bottom: 0; }
.timeline .node { width: 16px; height: 16px; margin-top: 2px; background: var(--canvas); border-radius: 50%; }
.timeline .act code { color: var(--ink-2); font-size: 12px; line-height: 16px; }
.why { color: var(--ink-2); font-size: 13px; line-height: 19px; }
.step p .chip + code, .step p code.dim { margin-left: 6px; }
.chip {
  display: inline-block; font: 500 12px/16px var(--sans); padding: 0 6px; border: 1px solid currentColor;
  border-radius: var(--argus-radius-xs); margin-left: 4px; color: var(--ink-3);
}
.chip.t-caution { color: var(--caution); }

.heals > li { display: flex; gap: 12px; padding: 12px 0; border-top: 1px solid var(--hairline); }
.heals .g { margin-top: 3px; }
.heals > li:first-child { margin-top: 12px; }

.empty { display: grid; justify-items: start; gap: 12px; padding: 8px 0; color: var(--ink-2); }
.empty .art svg { width: 160px; height: 120px; display: block; }
.cmd { display: inline-flex; align-items: center; gap: 4px; padding: 2px 4px 2px 10px; background: var(--sunk); border-radius: var(--argus-radius-sm); }

.scroll { overflow-x: auto; }
.ledger { width: 100%; border-collapse: collapse; font-size: 13px; line-height: 19px; }
.ledger th, .ledger td { text-align: left; padding: 6px 12px 6px 0; border-bottom: 1px solid var(--hairline); white-space: nowrap; vertical-align: middle; }
.ledger thead th { font: 500 12px/16px var(--sans); color: var(--ink-3); }
.ledger tbody th { font-weight: 600; }
.ledger tfoot th, .ledger tfoot td { border-bottom: 0; font-weight: 600; }
.ledger .num { text-align: right; }
.ledger code { font-size: 12px; line-height: 16px; }
.tally { display: inline-flex; align-items: center; gap: 8px; }
.ticks { display: inline-flex; gap: 2px; }
.ticks i { width: 3px; height: 10px; border-radius: 1px; box-shadow: inset 0 0 0 1px var(--hairline); }
.ticks i.on { background: currentColor; box-shadow: none; }
.tally .data { color: var(--ink-2); font-size: 12px; line-height: 16px; }

button.copy {
  display: none; align-items: center; justify-content: center; width: 24px; height: 24px; padding: 0;
  border: 0; background: none; color: var(--ink-3); border-radius: var(--argus-radius-sm); cursor: pointer;
}
.js button.copy { display: inline-flex; }
button.copy:hover { color: var(--ink); background: var(--sunk); }
button.copy .g { width: 16px; height: 16px; }
button.copy .i-check, button.copy[data-done] .i-copy { display: none; }
button.copy[data-done] .i-check { display: block; color: var(--passed); }

.rail { display: none; }
.foot {
  display: flex; flex-wrap: wrap; gap: 4px 12px; padding: 24px 0 48px; border-top: 1px solid var(--hairline);
  color: var(--ink-3); font-size: 12px; line-height: 16px;
}
.foot a { color: var(--ink-2); }

@media (min-width: 1280px) {
  .page { grid-template-columns: minmax(0, 880px) 200px; }
  .rail { display: block; }
  .rail > * { position: sticky; top: 24px; }
  .rail { padding-top: 32px; }
  .rail nav ul { display: grid; gap: 4px; }
  .rail nav a { color: var(--ink-2); text-decoration: none; display: block; padding: 2px 0; }
  .rail nav a:hover { color: var(--accent); }
  .rail-spend { margin-top: 24px; padding-top: 16px; border-top: 1px solid var(--hairline); top: 200px; }
  .cap { font: 500 12px/16px var(--sans); color: var(--ink-3); }
}
@media (max-width: 640px) {
  .headline { font-size: 28px; line-height: 32px; }
  .headline .big { width: 26px; height: 26px; }
  .lead { font-size: 15px; line-height: 22px; }
  .lane-head { grid-template-columns: auto minmax(0, 1fr) auto; }
  .lane-head .st { grid-column: 1; }
  .lane-name { grid-column: 2; }
  .lane-spend { grid-column: 3; }
  .lane-result { grid-column: 1 / -1; }
  .lane-proof { grid-column: 1 / -1; }
  .lane-facts, .lane-note { margin-left: 0; }
  .lane-spend { grid-row: 1; }
  .lane-head .st, .lane-name { grid-row: 1; }
  .finding-proof { margin-left: 0; }
}
@media print {
  :root {
    ${LIGHT_COLORS}
    color-scheme: light;
  }
  .control, .skip, button.copy {
    display: none !important;
  }
  .art-dark {
    display: none !important;
  }
  .art-light {
    display: block !important;
  }
  body {
    background: #fff;
    font-size: 11pt;
  }
  .page {
    display: block;
    padding: 0;
  }
  section {
    padding: 16px 0;
  }
  li, .kv, .banner, table {
    break-inside: avoid;
  }
  h2, h3 {
    break-after: avoid;
  }
  .scroll {
    overflow: visible;
  }
  .ledger td {
    white-space: normal;
  }
  .ticks {
    display: none;
  }
  details::details-content {
    content-visibility: visible;
    display: block;
  }
  .suggest summary {
    color: var(--ink-2);
  }
  a {
    color: inherit;
  }
}
`

/** Copy buttons only: the report reads fully without script. */
const SCRIPT = `document.documentElement.classList.add('js');
document.addEventListener('click', function (e) {
  var b = e.target.closest && e.target.closest('button[data-copy]');
  if (!b || !navigator.clipboard) return;
  navigator.clipboard.writeText(b.getAttribute('data-copy')).then(function () {
    b.setAttribute('data-done', '');
    setTimeout(function () { b.removeAttribute('data-done'); }, 1200);
  });
});`

// ---- Document ---------------------------------------------------------------

export function renderReportHtml(input: ReportHtmlInput): string {
  const ms = readManifest(input.manifestText)
  const manifest = ms.state === 'ok' ? ms.manifest : undefined
  const missing = ms.state === 'ok' ? ms.missing : []
  const crRaw = isObj(input.codeReview) ? input.codeReview : undefined
  const cr = crRaw as CodeReviewInput | undefined
  const run = isObj(input.run) ? (input.run as RunIn) : undefined
  const views: Partial<Record<LaneId, LaneView>> = {}
  const rows: LaneRow[] = []
  if (manifest !== undefined) {
    for (const id of LANE_IDS) {
      if (missing.includes(id)) {
        rows.push(MISSING_ROW(id))
        continue
      }
      const view = laneView(manifest.lanes[id])
      views[id] = view
      rows.push(manifestRow(view, cr))
    }
  } else if (cr !== undefined && cr.skipped !== true) {
    rows.push({ lane: 'review', status: cr.ok === true ? 'passed' : 'failed', result: '', proof: laneProof('review', cr.ok === true ? 'passed' : 'failed', cr), spend: '' })
  }
  const crHead = isObj(crRaw?.headBinding) ? str(crRaw.headBinding.intendedSha) : undefined
  const c: Ctx = {
    ms,
    manifest,
    missing,
    views,
    rows,
    cr,
    crRaw,
    run,
    repo: manifest?.identity.repo,
    head: manifest?.identity.intendedHeadSha ?? manifest?.identity.checkoutSha ?? crHead,
  }

  const runId = manifest?.runId
  const titleBits = ['Argus evidence report']
  if (runId !== undefined) titleBits.push(runId)
  const runLink =
    input.runUrl !== undefined && SAFE_URL.test(input.runUrl)
      ? `<a href="${esc(input.runUrl)}">workflow run and artifacts</a>`
      : undefined
  const started = manifest !== undefined ? Date.parse(manifest.startedAt) : NaN

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<title>${esc(titleBits.join(': '))}</title>
<style>
${TOKENS_CSS}
${FONT_FACES_CSS}
${CSS}
</style>
</head>
<body>
<svg xmlns="http://www.w3.org/2000/svg" style="display:none" aria-hidden="true">${SPRITE_SYMBOLS}</svg>
<a class="skip control" href="#main">Skip to report</a>
<div class="page">
<header class="masthead">
<p class="brand">${MARK_SVG.replace('<svg', '<svg aria-hidden="true" focusable="false"')}<span>Argus</span><span class="dim">evidence report</span></p>
${runId !== undefined ? `<p class="runid"><span>run</span> <code>${esc(runId)}</code>${copyButton(runId, 'Copy run id')}${Number.isFinite(started) ? ` <span>· ${esc(new Date(started).toISOString().slice(0, 16).replace('T', ' '))} UTC</span>` : ''}</p>` : ''}
</header>
<main id="main">
${verdictSection(c)}
${lanesSection(c)}
${findingsSection(c)}
${flowSection(c)}
${healsSection(c)}
${ledgerSection(c)}
</main>
${rail(c)}
<footer class="foot">
<span>Argus ${esc(input.version)}</span>
${runLink !== undefined ? `<span>${runLink}</span>` : ''}
<span><a href="${REPO_URL}">github.com/duketopceo/Argus</a></span>
<span>Self-contained: this file makes no network requests.</span>
</footer>
</div>
<script>
${SCRIPT}
</script>
</body>
</html>
`
}
