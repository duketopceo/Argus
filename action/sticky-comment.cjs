/* eslint-disable @typescript-eslint/no-require-imports */

const fs = require('fs')
const path = require('path')

// The composite action injects these objects at runtime. Keeping them in a
// module-level runtime binding lets the GitHub script load this file with a
// normal require() instead of evaluating its source dynamically.
let github
let context
let core

// Shared render/parse helpers bundled from src/ by `npm run build:parity`
// (action/parity-entry.mjs -> action/parity.cjs). Never edit the copies —
// change src/ and rebuild; check:parity fails on a stale bundle.
const {
  SENTINEL,
  formatUsd,
  maskSecrets,
  cell,
  code,
  plural,
  STATUS_GLYPH,
  PROOF_LEVELS,
  SEVERITY_GLYPH,
  SEVERITY_LABEL,
  VERDICT_STATUS,
  VERDICT_LABEL,
  proofMeter,
  findingsOf,
  laneProof,
  reproducedCount,
  verdictLead,
  manifestDuration,
  LANE_IDS: MANIFEST_LANE_ORDER,
  INLINE_SENTINEL,
  normalizeFindingMessage,
  parseInlineBody,
  isArgusInlineBody,
  shortHash,
  extractSuggestion,
  inlineDedupKey,
  sanitizeCommentText,
} = require('./parity.cjs')

function formatDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return undefined
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
}

/** Status is always glyph plus lowercase word (R2). */
function statusText(status) {
  return `${STATUS_GLYPH[status]} ${status}`
}

/** Proof cell: blank for a lane that did not run, the empty meter plus
 *  "none" for one that ran and proved nothing, otherwise meter plus word. */
function proofText(level) {
  if (level === null) return ''
  if (level === 'none') return `${proofMeter(undefined)} none`
  return `${proofMeter(level)} ${level}`
}

function ladderLevel(status) {
  return PROOF_LEVELS.includes(status) ? status : 'suspected'
}

/** Strongest proof any finding reached; a review with no evidence is a suspicion. */

/** How far a lane's result is proven (A4). a0 is self-reported, the browser
 *  lanes exercise the app, the review is as strong as its best evidence. */

// The commit-status surface validates at least as strictly as the display
// surfaces (viewmodel.isRunManifest / collect.validManifest) — this file is
// what can publish a green check, so it never trusts a shallow sniff.
function validManifest(m) {
  const num = (n) => typeof n === 'number' && Number.isFinite(n)
  if (m === null || typeof m !== 'object' || Array.isArray(m)) return false
  if (m.schemaVersion !== 1 || typeof m.runId !== 'string') return false
  if (typeof m.startedAt !== 'string') return false
  if (m.identity === null || typeof m.identity !== 'object' || Array.isArray(m.identity)) {
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
  if (m.aggregate === null || typeof m.aggregate !== 'object') return false
  // aggregate.status must be a real lane status and ok a real boolean —
  // a type-confused aggregate must fail the gate, not reach the renderer.
  if (!Object.hasOwn(STATUS_GLYPH, m.aggregate.status)) return false
  if (m.aggregate.ok !== true && m.aggregate.ok !== false) return false
  if (!num(m.aggregate.calls) || !num(m.aggregate.tokens) || !num(m.aggregate.costUsd)) {
    return false
  }
  if (m.lanes === null || typeof m.lanes !== 'object') return false
  return MANIFEST_LANE_ORDER.every((id) => {
    const lane = m.lanes[id]
    return (
      lane !== null &&
      typeof lane === 'object' &&
      lane.lane === id &&
      typeof lane.selected === 'boolean' &&
      Object.hasOwn(STATUS_GLYPH, lane.status) &&
      lane.usage !== null &&
      typeof lane.usage === 'object' &&
      num(lane.usage.calls) &&
      num(lane.usage.tokens) &&
      num(lane.usage.costUsd) &&
      lane.budget !== null &&
      typeof lane.budget === 'object'
    )
  })
}

function manifestLanes(manifest) {
  const lanes = manifest && manifest.lanes ? manifest.lanes : {}
  return MANIFEST_LANE_ORDER.map((id) => lanes[id]).filter(
    (l) => l !== null && typeof l === 'object' && Object.hasOwn(STATUS_GLYPH, l.status),
  )
}

/** One lane-table row per manifest lane, canonical order. */
function manifestLaneRows(manifest, codeReview) {
  return manifestLanes(manifest).map((lane) => {
    if (lane.selected !== true) {
      return { lane: lane.lane, status: 'skipped', result: 'not selected', proof: null, spend: '' }
    }
    const usage = lane.usage || {}
    return {
      lane: lane.lane,
      status: lane.status,
      result: lane.reason ?? lane.summary ?? '',
      proof: laneProof(lane.lane, lane.status, codeReview),
      spend: usage.metered === true ? formatUsd(usage.costUsd) : 'unmetered',
    }
  })
}

/** Review-lane row synthesized from code-review.json when no manifest exists.
 *  A missing report means the review step crashed: failed, never skipped. */
function reviewLaneRow(codeReview) {
  if (!codeReview) {
    return { lane: 'review', status: 'failed', result: 'no code-review.json', proof: 'none', spend: '' }
  }
  if (codeReview.skipped) {
    return { lane: 'review', status: 'skipped', result: codeReview.summary ?? 'skipped', proof: null, spend: '' }
  }
  const status = codeReview.ok === true ? 'passed' : 'failed'
  return {
    lane: 'review',
    status,
    result: `${plural(findingsOf(codeReview).length, 'finding')}, ${reproducedCount(codeReview)} reproduced`,
    proof: laneProof('review', status, codeReview),
    spend: formatUsd(codeReview.visionCostUsd),
  }
}

function healsOf(report) {
  return (report.tests ?? []).flatMap((t) => t.healEvents ?? [])
}

/** Flow-lane row synthesized from run.json when no manifest exists. */
function flowLaneRow(report) {
  if (!report) {
    return { lane: 'flow', status: 'skipped', result: 'run lane disabled', proof: null, spend: '' }
  }
  const totals = report.totals ?? {}
  const heals = healsOf(report).length
  const status = report.ok === true ? 'passed' : 'failed'
  return {
    lane: 'flow',
    status,
    result: `${totals.passed ?? 0} of ${totals.tests ?? 0} tests passed${heals > 0 ? `, ${heals} healed` : ''}`,
    proof: laneProof('flow', status, undefined),
    spend: formatUsd(totals.visionCostUsd),
  }
}

// --- the one layout (R6) ---------------------------------------------------------
// header, verdict line, lane table, findings summary, folds, footer. Every
// body below is this layout with different parts; the first screen stays
// within 12 lines before the first fold.

function laneTable(rows) {
  const lines = ['| Status | Lane | Result | Proof | Spend |', '|---|---|---|---|--:|']
  for (const r of rows) {
    lines.push(`| ${statusText(r.status)} | ${cell(r.lane)} | ${cell(r.result)} | ${proofText(r.proof)} | ${r.spend} |`)
  }
  return lines
}

/** Header word: a failed run is never shown with a positive verdict. */
function headline(ok, aggregateStatus, codeReview) {
  const verdict =
    codeReview && !codeReview.skipped && Object.hasOwn(VERDICT_LABEL, codeReview.verdict)
      ? codeReview.verdict
      : undefined
  if (ok !== true) {
    if (verdict === 'needs_changes') return `${STATUS_GLYPH.failed} ${VERDICT_LABEL.needs_changes}`
    const s = aggregateStatus !== undefined && !['passed', 'skipped'].includes(aggregateStatus)
      ? aggregateStatus
      : 'failed'
    return statusText(s)
  }
  if (verdict !== undefined) return `${STATUS_GLYPH[VERDICT_STATUS[verdict]]} ${VERDICT_LABEL[verdict]}`
  return statusText(aggregateStatus ?? 'passed')
}

/** Bold lead of the verdict line: the one fact a reader needs first. */

function verdictLine({ rows, codeReview, headSha, binding, costUsd, durationMs }) {
  const bits = [verdictLead(rows, codeReview)]
  if (typeof headSha === 'string' && headSha !== '') bits.push(`head ${code(headSha.slice(0, 7))}`)
  if (binding && binding.status === 'mismatch') bits.push('head binding mismatch')
  // U4 — a verified incremental run names its range: "2 commits since abc1234".
  const inc = codeReview && codeReview.incremental
  if (inc && typeof inc.since === 'string' && inc.since !== '') {
    bits.push(
      `${typeof inc.commits === 'number' ? plural(inc.commits, 'commit') : 'incremental diff'} since ${code(inc.since.slice(0, 7))}`,
    )
  }
  bits.push(formatUsd(costUsd))
  const duration = formatDuration(durationMs)
  if (duration !== undefined) bits.push(duration)
  return bits.join(' · ')
}

const NO_REVIEW_REPORT = 'No code review report was found; check the action logs before merging.'
const NO_REVIEW_ATTACHED = 'No code review report is attached to this run.'

function findingsLine(codeReview, missing = NO_REVIEW_REPORT) {
  if (!codeReview) return missing
  if (codeReview.skipped) return `Code review skipped: ${cell(codeReview.summary, 300)}`
  const findings = findingsOf(codeReview)
  const sev = { bug: 0, risk: 0, nit: 0, q: 0 }
  for (const f of findings) if (Object.hasOwn(sev, f.severity)) sev[f.severity] += 1
  const parts = [
    `${SEVERITY_GLYPH.bug} ${plural(sev.bug, 'bug')}`,
    `${SEVERITY_GLYPH.risk} ${plural(sev.risk, 'risk')}`,
    `${SEVERITY_GLYPH.nit} ${plural(sev.nit, 'nit')}`,
  ]
  if (sev.q > 0) parts.push(`${SEVERITY_GLYPH.q} ${plural(sev.q, 'question')}`)
  // p alone is never proof: high-confidence is counted apart from reproduced
  // (KTD2). Serialized counts win; the recount serves older reports and
  // P_FALLBACK_GATE must match P_TRUE_POSITIVE_THRESHOLD in src/cli.ts.
  const confident =
    typeof codeReview.highConfidenceBlockers === 'number'
      ? codeReview.highConfidenceBlockers
      : findings.filter((f) => typeof f.p === 'number' && f.p >= P_FALLBACK_GATE).length
  if (confident > 0) parts.push(`${confident} high-confidence`)
  // Counts serialized comments carrying a committable block (what lands on
  // the PR), not every finding the model offered a patch for.
  const suggestions = Array.isArray(codeReview.reviewComments)
    ? codeReview.reviewComments.filter((c) => extractSuggestion(c.body ?? '') !== '').length
    : findings.filter((f) => typeof f.suggestion === 'string' && f.suggestion !== '').length
  if (suggestions > 0) parts.push(`${plural(suggestions, 'suggestion')} ready to commit`)
  // Generated-specs summary (mirrors src/report/comment.ts findingsLine) —
  // without this segment an Argus-generated-specs run reports different
  // text on the action surface than the reference renderer.
  const gen = codeReview.generated
  if (gen && Array.isArray(gen.records) && gen.records.length > 0) {
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

const P_FALLBACK_GATE = 0.7

function fold(lines, title, body) {
  if (body.length === 0) return
  lines.push('<details>')
  lines.push(`<summary>${title}</summary>`)
  lines.push('')
  lines.push(...body)
  if (body[body.length - 1] !== '') lines.push('')
  lines.push('</details>')
  lines.push('')
}

function footer(meta, runUrl) {
  const bits = [`Argus ${meta.version ?? packageVersion()}`]
  const url = runUrl ?? meta.runUrl
  if (url) bits.push(`[workflow run and evidence](${url})`)
  // U14 (KTD12, Q13): name where report.html sits in the consumer's upload.
  if (meta.reportHtml) bits.push(`report ${code(meta.reportHtml)} in the run artifacts`)
  bits.push('self-hosted, BYOK')
  return `<sub>${bits.join(' · ')}</sub>`
}

function packageVersion() {
  return require('../package.json').version
}

/** KTD12: the comment budget (DESIGN.md 10), well under GitHub's 65,536-char cap. */
const COMMENT_BUDGET_BYTES = 20 * 1024

/** Fold keys in the order they collapse when a body is over budget (KTD12),
 *  then the remaining folds so the post never fails on length (R10). */
const COLLAPSE_ORDER = ['diagnostics', 'nits', 'spend', 'heals', 'findings', 'explore', 'tests']

/** One-line pointer that replaces a collapsed fold. Lines in `keep` (the
 *  hidden `@argus persist` payload) survive the collapse. */
function collapsedFold(title, keep) {
  return [
    `<details><summary>${title}: omitted to keep this comment under 20 KB</summary>` +
      'The full detail is in the report files and the workflow run linked below.</details>',
    '',
    ...keep.flatMap((k) => [k, '']),
  ]
}

/** The shared layout. `folds` is a list of [title, bodyLines, {key, keep}].
 *  Notices (one quoted line each) sit between the findings summary and the
 *  folds. Length is measured after the full render; while over budget, folds
 *  collapse to a pointer in COLLAPSE_ORDER. */
function layout({ status, verdict, rows, summary, folds, meta, runUrl }) {
  const budget = typeof meta.budgetBytes === 'number' ? meta.budgetBytes : COMMENT_BUDGET_BYTES
  const notices = Array.isArray(meta.notices) ? meta.notices : []
  const collapsed = new Set()
  const render = () => {
    const lines = [SENTINEL, `### Argus: ${status}`, '', verdict, '', ...laneTable(rows), '', summary, '']
    for (const n of notices) lines.push(`> ${n}`, '')
    for (const [title, body, opts = {}] of folds) {
      if (body.length === 0) continue
      if (collapsed.has(opts.key)) lines.push(...collapsedFold(title, opts.keep ?? []))
      else fold(lines, title, body)
    }
    lines.push(footer(meta, runUrl))
    // U4 — the incremental baseline marker rides inside the budget so the
    // collapse loop accounts for it. Emitted only from a completed review's
    // reviewedHeadSha (40-hex gate: a tampered report cannot plant text).
    const marker =
      typeof meta.markerSha === 'string' && /^[0-9a-f]{40}$/i.test(meta.markerSha)
        ? `<!-- argus:last-reviewed-sha:${meta.markerSha} -->`
        : undefined
    if (marker !== undefined) lines.push(marker)
    lines.push('')
    return lines.join('\n')
  }
  let body = render()
  for (const key of COLLAPSE_ORDER) {
    if (Buffer.byteLength(body) <= budget) break
    const present = folds.some(([, b, opts = {}]) => opts.key === key && b.length > 0)
    if (!present) continue
    collapsed.add(key)
    body = render()
  }
  return body
}

// --- folds ---------------------------------------------------------------------

const MAX_FINDING_ROWS = 25

function severityText(s) {
  return Object.hasOwn(SEVERITY_GLYPH, s) ? `${SEVERITY_GLYPH[s]} ${SEVERITY_LABEL[s]}` : cell(s ?? 'unknown')
}

function findingsFold(codeReview, inlinePlan) {
  if (!codeReview || codeReview.skipped) return []
  const body = []
  const findings = findingsOf(codeReview)
  if (codeReview.summary) {
    body.push(cell(codeReview.summary, 1000))
    body.push('')
  }
  if (findings.length > 0) {
    body.push('| Severity | Proof | p | Category | Location | Finding |')
    body.push('|---|---|---|---|---|---|')
    // Findings/evidence strings are model- and probe-emitted: sanitized per
    // cell, and the section is bounded so an oversized report can't push the
    // body past GitHub's 65536-char comment limit.
    for (const f of findings.slice(0, MAX_FINDING_ROWS)) {
      const level = ladderLevel(f.evidence?.status)
      const p = typeof f.p === 'number' ? f.p.toFixed(2) : ''
      const where = typeof f.line === 'number' ? `${f.file}:${f.line}` : f.file
      // An inconclusive link says the same thing on every row; Diagnostics states it once.
      const evidence =
        f.evidence?.detail && f.evidence.status !== 'inconclusive'
          ? `<br>evidence: ${cell(sanitizeCommentText(f.evidence.detail))}`
          : ''
      body.push(
        `| ${severityText(f.severity)} | ${proofText(level)} | ${p} | ${cell(f.category ?? '')} | ` +
          `${code(where)} | ${cell(sanitizeCommentText(f.message))}${evidence} |`,
      )
    }
    if (findings.length > MAX_FINDING_ROWS) {
      body.push(`| | | | | | ${findings.length - MAX_FINDING_ROWS} more findings in \`code-review.json\` |`)
    }
    body.push('')
  }
  // Serialized comments that didn't post: the maxComments cap plus post-time
  // drops (off-diff anchors, retry-ladder discards).
  if (inlinePlan !== undefined && inlinePlan.dropped > 0) {
    const overflow = inlinePlan.overflow ?? 0
    const reasons = []
    if (overflow > 0) reasons.push(`\`review.maxComments\` cap ${inlinePlan.cap}`)
    if (inlinePlan.dropped - overflow > 0) {
      reasons.push(`${inlinePlan.dropped - overflow} outside the PR diff`)
    }
    body.push(`*${plural(inlinePlan.dropped, 'inline comment')} not posted: ${reasons.join(', ')}.*`)
    body.push('')
  }
  // E1.U3: reproduced probes render copy-pasteable source plus the payload
  // `@argus persist` parses back. Bounded (2 probes, 8KB each) and fenced;
  // ``` runs inside the source are flattened so it can't break the fence.
  const persistable = (codeReview.probes ?? []).filter(
    (p) => p.outcome === 'reproduced' && typeof p.path === 'string' && typeof p.content === 'string',
  )
  if (persistable.length > 0) {
    body.push(
      'Reproduced probes: comment `@argus persist` to open a regression-test PR, or copy them into your suite.',
    )
    body.push('')
    for (const p of persistable.slice(0, 2)) {
      const rendered = p.content.replace(/`{3,}/g, '``').slice(0, 8 * 1024)
      body.push('<details>')
      body.push(`<summary>Probe ${code(p.path)}</summary>`)
      body.push('')
      body.push('```ts')
      body.push(rendered)
      body.push('```')
      body.push('</details>')
      body.push('')
    }
    if (persistable.length > 2) {
      body.push(`*${persistable.length - 2} more in \`code-review.json\`.*`)
      body.push('')
    }
  }
  const payload = persistPayloadOf(codeReview)
  if (payload !== undefined) {
    body.push(payload)
    body.push('')
  }
  return body
}

/** The hidden `@argus persist` payload, which must reach the posted body even
 *  when the Findings fold collapses: the persist command parses it back. */
function persistPayloadOf(codeReview) {
  return codeReview && typeof codeReview.persistPayload === 'string' && codeReview.persistPayload.length < 32768
    ? codeReview.persistPayload
    : undefined
}

/** Findings fold entry for layout(): collapsible, keeping the persist payload. */
function findingsEntry(codeReview, inlinePlan) {
  const payload = persistPayloadOf(codeReview)
  return [
    `Findings (${findingsOf(codeReview).length})`,
    findingsFold(codeReview, inlinePlan),
    { key: 'findings', keep: payload !== undefined ? [payload] : [] },
  ]
}

// Consolidated nit listing — rendered only when `review.nitsInline` kept
// nits out of inline comments (default). Capped; overflow stays counted.
// normalizeFindingMessage strips the embedded `L<n>: <sev>:` contract
// prefix so the fold's own `:L<n>` label isn't duplicated.
function nitsFold(codeReview) {
  // !== false: only a serialized nitsInline:false opts into the fold —
  // reports predating the field already posted their nits inline (the
  // documented argus-version pin can pair an older CLI with this poster).
  if (!codeReview || codeReview.nitsInline !== false) return []
  const nits = findingsOf(codeReview).filter((f) => f.severity === 'nit')
  if (nits.length === 0) return []
  const shown = nits.slice(0, 15)
  const body = shown.map(
    (f) =>
      `- ${code(f.file)}${typeof f.line === 'number' ? `:L${f.line}` : ''} - ${cell(sanitizeCommentText(normalizeFindingMessage(f.message ?? '')), 160)}`,
  )
  if (nits.length > shown.length)
    body.push(`- +${nits.length - shown.length} more in code-review.json (argus-reviewer-report artifact)`)
  return body
}

// Nit fold entry for layout() — the title count and the body share the
// same nit set (see findingsEntry for the tuple pattern).
function nitsEntry(codeReview) {
  const nits = findingsOf(codeReview).filter((f) => f.severity === 'nit')
  return [`${SEVERITY_GLYPH.nit} ${plural(nits.length, 'nit')} - consolidated`, nitsFold(codeReview), { key: 'nits' }]
}

function assertionStatus(verdict) {
  return verdict === 'pass' ? 'passed' : verdict === 'fail' ? 'failed' : 'skipped'
}

function testsFold(report) {
  const tests = report.tests ?? []
  if (tests.length === 0) return []
  const body = ['| Test | Result | Calls | Spend | Heals | Asserts |', '|---|---|--:|--:|--:|--:|']
  for (const t of tests) {
    body.push(
      `| ${cell(t.name)} | ${statusText(t.ok ? 'passed' : 'failed')} | ${t.visionCalls ?? 0} | ` +
        `${formatUsd(t.visionCostUsd)} | ${t.healEvents?.length ?? 0} | ${t.asserts?.length ?? 0} |`,
    )
  }
  body.push('')
  for (const t of tests) {
    if (!t.asserts || t.asserts.length === 0) continue
    body.push(`**${cell(t.name)}**`)
    for (const a of t.asserts) {
      body.push(`- ${statusText(assertionStatus(a.verdict))} · *${cell(a.question)}*: ${cell(a.reasoning, 500)}`)
    }
    body.push('')
  }
  const videos = report.artifacts?.videos ?? []
  for (const v of videos) body.push(`- video: ${code(v)}`)
  if (videos.length > 0) body.push('')
  return body
}

function healsFold(heals) {
  return heals.map((h) => `- ${code(h.instruction)} healed with ${cell(h.model || 'unknown model')}`)
}

const CAPTURE_LABEL = {
  'console-error': 'console error',
  pageerror: 'page error',
  'request-failed': 'failed request',
}

// U4a exploratory lane: observed runtime anomalies from the browser session.
// Evidence only; captures never change the verdict.
function exploreFold(report) {
  const explore = report.explore
  if (!explore || explore.enabled !== true) return []
  const body = []
  if (typeof explore.skipped === 'string') {
    body.push(`Explore skipped: ${cell(explore.skipped)}`)
    return body
  }
  if (typeof explore.steps === 'number') {
    const pages = typeof explore.visited === 'number' ? explore.visited : 0
    const spend = typeof explore.visionCostUsd === 'number' ? ` · ${formatUsd(explore.visionCostUsd)}` : ''
    body.push(
      `explored **${explore.steps}** step(s) across **${pages}** page(s), ` +
        `stopped: ${cell(explore.stopReason ?? 'unknown')}${spend}`,
    )
    body.push('')
  }
  // The same signature can appear on several test reports from one file's
  // shared browser session; collapse before rendering.
  const seen = new Map()
  for (const c of [...(explore.captures ?? []), ...(report.tests ?? []).flatMap((t) => t.captures ?? [])]) {
    const key = `${c.kind}|${c.text}|${c.url ?? ''}`
    const existing = seen.get(key)
    if (existing) existing.count += c.count
    else seen.set(key, { ...c })
  }
  const caps = [...seen.values()]
  if (caps.length === 0) {
    body.push('No page errors, console errors, or failed same-origin requests captured.')
    return body
  }
  for (const c of caps.slice(0, 10)) {
    const times = c.count > 1 ? ` ×${c.count}` : ''
    const target = c.url !== undefined ? ` at ${code(c.url)}` : ''
    body.push(`- observed · ${CAPTURE_LABEL[c.kind] ?? cell(c.kind)}${times}: ${code(c.text)}${target}`)
  }
  if (caps.length > 10) body.push(`- ${caps.length - 10} more distinct captures`)
  body.push('')
  body.push('*Observed findings are evidence only; they do not change the verdict.*')
  return body
}

function spendFold(manifest, report, codeReview) {
  const body = []
  if (manifest !== undefined) {
    body.push('| Lane | Model | Calls | Tokens | Spend |', '|---|---|--:|--:|--:|')
    for (const lane of manifestLanes(manifest)) {
      if (lane.selected !== true) continue
      const usage = lane.usage || {}
      const spend = usage.metered === true ? formatUsd(usage.costUsd) : 'unmetered'
      body.push(
        `| ${cell(lane.lane)} | ${cell(lane.model ?? usage.model ?? '')} | ${usage.calls ?? 0} | ` +
          `${usage.tokens ?? 0} | ${spend} |`,
      )
    }
    const agg = manifest.aggregate || {}
    body.push(`| Total |  | ${agg.calls ?? 0} | ${agg.tokens ?? 0} | ${formatUsd(agg.costUsd)} |`)
    body.push('')
    const over = manifestLanes(manifest).filter((l) => l.selected === true && l.budget?.exceeded === true)
    if (over.length > 0) {
      body.push(`**Budget exceeded:** ${over.map((l) => cell(l.lane)).join(', ')}`)
      body.push('')
    }
  }
  if (report !== undefined) {
    const t = report.totals ?? {}
    const budgetCap = report.config?.budgetUsd ?? 0
    body.push('| Line item | Value |', '|---|--:|')
    body.push(`| Vision calls | ${t.visionCalls ?? 0} |`)
    const perCall = t.visionCalls > 0 ? formatUsd(t.visionCostUsd / t.visionCalls) : formatUsd(0)
    body.push(`| Per-call cost (avg) | ${perCall} |`)
    for (const model of Object.keys(t.callsByModel ?? {}).sort()) {
      body.push(`| Calls (${cell(model)}) | ${t.callsByModel[model]} |`)
      body.push(`| Spend (${cell(model)}) | ${formatUsd(t.costByModel?.[model] ?? 0)} |`)
    }
    body.push(`| Total vision spend | ${formatUsd(t.visionCostUsd)} |`)
    body.push(`| Sandbox seconds | ${(t.sandboxSeconds ?? 0).toFixed(1)}s |`)
    if (budgetCap > 0) {
      body.push(`| Budget cap | ${formatUsd(budgetCap)} |`)
      body.push(`| Budget exceeded | ${t.budgetExceeded ? 'yes' : 'no'} |`)
    }
    body.push('')
  }
  // Cache economics: the run report's totals when present, else the manifest's flow lane.
  const cache = report !== undefined
    ? { hits: report.totals?.cacheHits, misses: report.totals?.cacheMisses, heals: report.totals?.cacheHeals }
    : manifest?.lanes?.flow?.cache
  if (cache && typeof cache === 'object') {
    body.push(
      `**Fingerprint cache:** ${cache.hits ?? 0} hit(s) · ${cache.misses ?? 0} miss(es) · ${cache.heals ?? 0} heal(s)`,
    )
    body.push('')
  }
  if (codeReview && !codeReview.skipped) {
    body.push(
      `**Code review:** ${cell(codeReview.model ?? 'unknown model')} · ${codeReview.tokens ?? 0} tokens · ` +
        `${formatUsd(codeReview.visionCostUsd)}`,
    )
    body.push('')
  }
  return body
}

function diagnosticsFold(manifest, report, codeReview) {
  const items = []
  const binding = manifest?.lanes?.review?.headBinding ?? (codeReview && !codeReview.skipped ? codeReview.headBinding : undefined)
  if (binding) items.push(`Head binding: ${cell(binding.status)}, ${cell(binding.detail)}`)
  if (codeReview && !codeReview.skipped) {
    const sc = codeReview.scope
    if (sc && sc.excludedFiles > 0) {
      const sample = Array.isArray(sc.excludedSample) ? sc.excludedSample.slice(0, 5).map((p) => code(p)).join(', ') : ''
      items.push(
        `Review scope: ${sc.reviewedFiles} of ${sc.totalFiles} changed files reviewed; ` +
          `${sc.excludedFiles} excluded by \`review.exclude\`${sample ? ` (${sample})` : ''}`,
      )
    }
    const val = codeReview.validation
    if (val && val.dropped > 0) {
      const LABEL = {
        file_not_in_diff: 'file not in the diff',
        file_excluded: 'file excluded from review',
        file_deleted: 'file deleted at head',
        line_beyond_file: 'line past end of file',
        line_outside_diff: 'line outside changed hunks',
      }
      const parts = Object.entries(val.byReason ?? {}).map(([k, n]) => `${n} ${LABEL[k] ?? cell(k)}`)
      items.push(`Findings dropped by validation: ${val.dropped} (${parts.join(', ')})`)
    }
    if (typeof codeReview.testFileCapped === 'number' && codeReview.testFileCapped > 0) {
      items.push(`Test-file findings capped at nit: ${codeReview.testFileCapped}`)
    }
    const t = codeReview.triage
    if (t) {
      if (t.unadjudicated === true) {
        items.push('Risk triage unavailable: the confidence model did not respond.')
      } else {
        items.push(
          `Risk triage: risk ${cell(t.risk ?? '?')}/5` +
            `${typeof t.needsDeepReview === 'number' ? ` · deep-review ${t.needsDeepReview.toFixed(2)}` : ''}` +
            `${t.topRiskArea !== undefined ? ` · top area ${code(t.topRiskArea)}` : ''}` +
            ` (${cell(t.mode)})`,
        )
      }
    }
    // Evidence links that could not conclude (no repo index, CI unreachable):
    // one line per distinct reason instead of one per finding (U6).
    const inconclusive = new Map()
    for (const f of findingsOf(codeReview)) {
      if (f.evidence?.status !== 'inconclusive' || !f.evidence.detail) continue
      inconclusive.set(f.evidence.detail, (inconclusive.get(f.evidence.detail) ?? 0) + 1)
    }
    for (const [detail, n] of inconclusive) {
      items.push(`CI evidence inconclusive for ${plural(n, 'finding')}: ${cell(detail)}`)
    }
    if (Array.isArray(codeReview.probes) && codeReview.probes.length > 0) {
      const reproduced = codeReview.probes.filter((p) => p.outcome === 'reproduced').length
      items.push(`Probes: ${codeReview.probes.length} run, ${reproduced} reproduced`)
    }
    if (typeof codeReview.probeLaneSkipped === 'string') {
      items.push(`Probe lane skipped: ${cell(codeReview.probeLaneSkipped)}`)
    }
    // Secrets-lane audit: adjudicated/suppressed counts, never literals.
    const scan = codeReview.secretsScan
    if (scan) {
      if (typeof scan.skipped === 'string') {
        items.push(`Secrets scan skipped: ${cell(scan.skipped)}`)
      } else if (Array.isArray(scan.records)) {
        const suppressed = scan.records.filter((r) => r.suppressed).length
        const unadj = scan.records.filter((r) => !r.adjudicated).length
        items.push(
          `Secrets scan: ${scan.records.length} candidate(s)` +
            `${suppressed > 0 ? `, ${suppressed} adjudicated-suppressed` : ''}` +
            `${unadj > 0 ? `, ${unadj} unadjudicated` : ''}` +
            `${scan.overflow > 0 ? `, ${scan.overflow} over cap` : ''}`,
        )
      }
    }
    // U8 ruleset-lane audit: per-rule hit counts; failures degrade open.
    const rs = codeReview.rulesScan
    if (rs) {
      if (typeof rs.skipped === 'string') {
        items.push(`Rules lane skipped: ${cell(rs.skipped)}`)
      } else {
        const recs = Array.isArray(rs.records) ? rs.records : []
        const suppressed = recs.filter((r) => r.suppressed).length
        const failed = Array.isArray(rs.failures) ? rs.failures.length : 0
        const ran = Array.isArray(rs.ran) ? rs.ran.length : 0
        items.push(
          `Rules lane: ${ran} rule(s), ${recs.length} audited hit(s)` +
            `${suppressed > 0 ? `, ${suppressed} suppressed` : ''}` +
            `${failed > 0 ? `, ${failed} failed` : ''}`,
        )
      }
    }
    // U8 adjudication audit: shows what the confidence model removed.
    const fa = codeReview.findingAdjudication
    if (fa && Array.isArray(fa.records)) {
      if (fa.unadjudicated === true) {
        items.push('Finding adjudication unavailable: the confidence model did not respond, nothing suppressed.')
      } else {
        const suppressed = fa.records.filter((r) => r.suppressed).length
        const unadj = fa.records.filter((r) => !r.adjudicated).length
        items.push(
          `Adjudication: ${fa.records.length} finding(s) scored` +
            `${suppressed > 0 ? `, ${suppressed} suppressed (nit/q)` : ''}` +
            `${unadj > 0 ? `, ${unadj} unadjudicated` : ''}` +
            `${fa.overflow > 0 ? `, ${fa.overflow} over cap` : ''}`,
        )
      }
    }
  }
  for (const [k, v] of Object.entries(report?.trace ?? {})) items.push(`${cell(k)}: ${code(v)}`)
  return items.map((i) => `- ${i}`)
}

// --- bodies ----------------------------------------------------------------------

function renderMissingKeyBody(meta = {}) {
  return layout({
    status: statusText('skipped'),
    verdict:
      '**Not run:** `OPENROUTER_API_KEY` is not configured, so no lane ran. This status is neutral, not a failure.',
    rows: MANIFEST_LANE_ORDER.map((lane) => ({ lane, status: 'skipped', result: 'no API key', proof: null, spend: '' })),
    summary:
      'Fix: add the key as a repository secret, then re-run the workflow: `gh secret set OPENROUTER_API_KEY`',
    folds: [],
    meta,
  })
}

function renderNoReportBody(reportDir, runUrl, meta = {}) {
  return layout({
    status: statusText('failed'),
    verdict:
      `**No report:** the run step produced no \`run.json\` under ${code(reportDir)}. ` +
      'The commit status fails closed.',
    rows: [{ lane: 'flow', status: 'failed', result: 'no run.json', proof: 'none', spend: '' }],
    summary: 'Check the action logs before merging.',
    folds: [],
    meta,
    runUrl,
  })
}

/** Lane table rows (string lines) for a parsed run-manifest.json. */
function renderManifestLanes(manifest, codeReview) {
  return laneTable(manifestLaneRows(manifest, codeReview))
}

/**
 * Manifest-only body: a verify run whose lanes produced no run.json
 * (review-only, or a flow lane that never reached the browser). The
 * aggregate status is the verdict; lane detail lives in the manifest.
 */
function renderManifestBody(manifest, codeReview, runUrl, meta = {}) {
  const aggregate = (manifest && manifest.aggregate) || {}
  const rows = manifestLaneRows(manifest, codeReview)
  return layout({
    status: headline(aggregate.ok === true, aggregate.status, codeReview),
    verdict: verdictLine({
      rows,
      codeReview,
      headSha: manifest.identity?.intendedHeadSha,
      binding: manifest.lanes?.review?.headBinding,
      costUsd: aggregate.costUsd,
      durationMs: manifestDuration(manifest),
    }),
    rows,
    summary: findingsLine(codeReview, NO_REVIEW_ATTACHED),
    folds: [
      findingsEntry(codeReview, undefined),
      nitsEntry(codeReview),
      ['Spend ledger', spendFold(manifest, undefined, codeReview), { key: 'spend' }],
      ['Diagnostics', diagnosticsFold(manifest, undefined, codeReview), { key: 'diagnostics' }],
    ],
    meta,
    runUrl,
  })
}

function renderBody(report, codeReview, runUrl, ok, inlinePlan, manifest, meta = {}) {
  if (!report) return renderMissingKeyBody(meta)
  // The verify manifest is the lane contract; without one, the review and
  // flow rows are synthesized from their own reports.
  const rows = manifest !== undefined
    ? manifestLaneRows(manifest, codeReview)
    : [reviewLaneRow(codeReview), flowLaneRow(report)]
  const reviewSpend = codeReview && !codeReview.skipped ? codeReview.visionCostUsd ?? 0 : 0
  const heals = healsOf(report)
  return layout({
    status: headline(ok, manifest?.aggregate?.status, codeReview),
    verdict: verdictLine({
      rows,
      codeReview,
      headSha: manifest?.identity?.intendedHeadSha ?? codeReview?.headBinding?.intendedSha,
      binding: manifest?.lanes?.review?.headBinding ?? codeReview?.headBinding,
      costUsd: manifest !== undefined ? manifest.aggregate.costUsd : (report.totals?.visionCostUsd ?? 0) + reviewSpend,
      durationMs: manifest !== undefined ? manifestDuration(manifest) : report.durationMs,
    }),
    rows,
    summary: findingsLine(codeReview),
    folds: [
      findingsEntry(codeReview, inlinePlan),
      nitsEntry(codeReview),
      [`Tests (${report.tests?.length ?? 0})`, testsFold(report), { key: 'tests' }],
      [`Heals (${heals.length}): review before merging`, healsFold(heals), { key: 'heals' }],
      ['Exploratory', exploreFold(report), { key: 'explore' }],
      ['Spend ledger', spendFold(manifest, report, codeReview), { key: 'spend' }],
      ['Diagnostics', diagnosticsFold(manifest, report, codeReview), { key: 'diagnostics' }],
    ],
    meta,
    runUrl,
  })
}

// Sticky body for `run: 'false'` consumers: no run.json exists by design, so
// the body and conclusion reflect code review alone.
function renderReviewOnlyBody(codeReview, runUrl, ok, inlinePlan, manifest, meta = {}) {
  const rows = manifest !== undefined
    ? manifestLaneRows(manifest, codeReview)
    : [reviewLaneRow(codeReview), flowLaneRow(undefined)]
  const reviewed = codeReview && !codeReview.skipped
  return layout({
    status: headline(ok, manifest?.aggregate?.status, codeReview),
    verdict: verdictLine({
      rows,
      codeReview,
      headSha: manifest?.identity?.intendedHeadSha ?? (reviewed ? codeReview.headBinding?.intendedSha : undefined),
      binding: manifest?.lanes?.review?.headBinding ?? (reviewed ? codeReview.headBinding : undefined),
      costUsd: manifest !== undefined ? manifest.aggregate.costUsd : reviewed ? codeReview.visionCostUsd : 0,
      durationMs: manifest !== undefined ? manifestDuration(manifest) : undefined,
    }),
    rows,
    summary: findingsLine(codeReview),
    folds: [
      findingsEntry(codeReview, inlinePlan),
      nitsEntry(codeReview),
      ['Spend ledger', spendFold(manifest, undefined, codeReview), { key: 'spend' }],
      ['Diagnostics', diagnosticsFold(manifest, undefined, codeReview), { key: 'diagnostics' }],
    ],
    meta,
    runUrl,
  })
}

// --- manifest states (R11) -------------------------------------------------------
// A manifest is ok, missing, unreadable (did not parse or failed validation)
// or stale (bound to another head or another run). Each degraded state is
// named in the comment with a fix; a stale one shows both SHAs.

/** A git SHA shortened for display, or undefined when the field is not 7-40
 *  hex characters: a tampered manifest cannot plant text in the banner. */
function shortSha(sha) {
  return typeof sha === 'string' && /^[0-9a-f]{7,40}$/i.test(sha) ? sha.slice(0, 7) : undefined
}

/**
 * Classify run-manifest.json. `raw` is the file text, or undefined when the
 * file is absent. The manifest decides the status only when it validates like
 * a real manifest AND binds this run's head AND this run's nonce; residue and
 * plants fall through to whatever serialized evidence survived the same gate.
 */
function resolveManifest(raw, { headSha, nonce }) {
  if (raw === undefined) return { state: 'missing' }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { state: 'unreadable', reason: 'parse' }
  }
  if (!validManifest(parsed)) return { state: 'unreadable', reason: 'invalid' }
  const manifestSha = parsed.identity?.intendedHeadSha
  const otherHead = manifestSha !== headSha
  const otherRun = nonce !== undefined && nonce !== '' && parsed.identity?.runNonce !== nonce
  if (otherHead || otherRun) {
    return { state: 'stale', manifestSha: shortSha(manifestSha), headSha: shortSha(headSha), sameHead: !otherHead }
  }
  return { state: 'ok', manifest: parsed }
}

function shaText(short) {
  return short === undefined ? 'unknown' : code(short)
}

const VERIFY_STEP = '"Run selected Argus lanes"'

/** Lead, consequence and fix for a degraded manifest state. */
function manifestStateCopy(ms) {
  switch (ms.state) {
    case 'missing':
      return {
        lead: '**No manifest:** the verify step wrote no `run-manifest.json`',
        fix: `Fix: open the ${VERIFY_STEP} step log to see where it stopped, then re-run the workflow.`,
      }
    case 'unreadable':
      return {
        lead:
          ms.reason === 'parse'
            ? '**Manifest unreadable:** `run-manifest.json` did not parse'
            : '**Manifest unreadable:** `run-manifest.json` failed validation',
        fix: `Fix: re-run the workflow. If it happens again, check the ${VERIFY_STEP} step log.`,
      }
    case 'stale':
      return {
        lead: ms.sameHead
          ? `**Manifest stale:** the manifest for head ${shaText(ms.headSha)} came from another workflow run`
          : `**Manifest stale:** manifest ${shaText(ms.manifestSha)} ≠ head ${shaText(ms.headSha)}`,
        fix: 'Fix: re-run the workflow on the current head.',
      }
    default:
      return undefined
  }
}

/** Whether a missing manifest is worth naming: only runs that had a verify
 *  step write one. `@argus` mention runs (issue_comment) never do. */
function manifestExpected(ms, eventName) {
  return ms.state !== 'missing' || eventName !== 'issue_comment'
}

/** Body for a run whose manifest is degraded and whose run.json is absent:
 *  nothing trustworthy says how the lanes went, so the status fails closed. */
function renderManifestStateBody(ms, codeReview, runUrl, meta = {}) {
  const copy = manifestStateCopy(ms)
  return layout({
    status: statusText('failed'),
    verdict: `${copy.lead}${ms.state === 'missing' ? '' : ', so it was ignored'}. The commit status fails closed.`,
    rows: [reviewLaneRow(codeReview)],
    summary: copy.fix,
    folds: [findingsEntry(codeReview, undefined)],
    meta,
    runUrl,
  })
}

/** Ignored-evidence notice: a report whose head/run binding does not match. */
function staleEvidenceNotice(file) {
  return `A \`${file}\` was found but its head/run binding does not match this run, so it was ignored.`
}

/**
 * Pick and render the sticky body for one run. `ev` carries what main() read:
 * hasKey, runDisabled, eventName, report, codeReview, manifestState, inlinePlan,
 * ok, reportDir, staleEvidence, runUrl, reportHtml.
 */
function renderSticky(ev, baseMeta = {}) {
  const runUrl = ev.runUrl
  if (!ev.hasKey) return renderMissingKeyBody({ ...baseMeta, runUrl })
  const ms = ev.manifestState ?? { state: 'missing' }
  const manifest = ms.state === 'ok' ? ms.manifest : undefined
  // report.html is written beside the manifest by the same verify run. Only
  // a fresh, valid manifest vouches for it; otherwise it may be residue.
  const meta = {
    ...(manifest !== undefined && typeof ev.reportHtml === 'string' && ev.reportHtml !== ''
      ? { ...baseMeta, reportHtml: ev.reportHtml }
      : baseMeta),
    // U4 — completed reviews carry the baseline forward; skipped/capped
    // runs never set reviewedHeadSha, so the marker stays absent and the
    // next run still diffs from the last fully-reviewed head.
    ...(typeof ev.codeReview?.reviewedHeadSha === 'string'
      ? { markerSha: ev.codeReview.reviewedHeadSha }
      : {}),
  }
  const named = ms.state !== 'ok' && manifestExpected(ms, ev.eventName)
  const notices = []
  if (named) {
    const copy = manifestStateCopy(ms)
    notices.push(`${copy.lead}, so lanes come from the individual reports. ${copy.fix}`)
  }
  for (const file of ev.staleEvidence ?? []) notices.push(staleEvidenceNotice(file))
  const withNotices = { ...meta, notices }
  if (ev.runDisabled) {
    return renderReviewOnlyBody(ev.codeReview, runUrl, ev.ok, ev.inlinePlan, manifest, withNotices)
  }
  if (ev.report === undefined) {
    if (manifest !== undefined) return renderManifestBody(manifest, ev.codeReview, runUrl, withNotices)
    const rest = { ...meta, notices: notices.slice(named ? 1 : 0) }
    if (named) return renderManifestStateBody(ms, ev.codeReview, runUrl, rest)
    return renderNoReportBody(ev.reportDir, runUrl, rest)
  }
  return renderBody(ev.report, ev.codeReview, runUrl, ev.ok, ev.inlinePlan, manifest, withNotices)
}

// --- GitHub write failures (R9) ---------------------------------------------------
// A failed write never fails silently: the reason goes to the job summary
// and a warning, and the commit status is still attempted.

function headerOf(e, name) {
  const h = e?.response?.headers
  return h && typeof h === 'object' ? h[name] : undefined
}

/** Plain-words reason and fix for a failed GitHub API call. HTTP codes stay
 *  in the Diagnostics part (R5). */
function describeApiError(e, scope) {
  const status = e?.status
  const remaining = headerOf(e, 'x-ratelimit-remaining')
  const message = String(e?.message ?? 'unknown error')
  if (status === 429 || String(remaining) === '0' || /rate limit/i.test(message)) {
    const reset = Number(headerOf(e, 'x-ratelimit-reset'))
    const at = Number.isFinite(reset) && reset > 0
      ? new Date(reset * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
      : undefined
    return {
      reason: 'GitHub API rate limit reached',
      fix: at !== undefined ? `The limit resets at ${at}; re-run the workflow after that.` : 'Re-run the workflow later.',
    }
  }
  if (status === 401 || status === 403) {
    return {
      reason: 'permission denied',
      fix: `Give the workflow \`${scope}\` permission. Pull requests from forks get a read-only token.`,
    }
  }
  if (status === 404) {
    return { reason: 'not found', fix: 'The token cannot see this pull request or comment; check the workflow token.' }
  }
  if (status === 422) {
    return { reason: 'GitHub rejected the request as invalid', fix: 'Re-run the workflow; if it repeats, open an issue with the job log.' }
  }
  return { reason: 'GitHub API error', fix: 'Re-run the workflow; if it repeats, check the GitHub status page.' }
}

/** Report one failed write to the job summary and as a warning. Never throws. */
async function reportWriteFailure(what, e, scope) {
  const { reason, fix } = describeApiError(e, scope)
  const diagnostic = maskSecrets(`GitHub API ${e?.status ?? 'error'}: ${String(e?.message ?? 'unknown error')}`)
  core.warning(`Argus could not ${what}: ${reason}. ${fix}`)
  try {
    await core.summary
      .addRaw(
        `### Argus could not ${what}\n\n${reason[0].toUpperCase()}${reason.slice(1)}. ${fix}\n\n` +
          `<details><summary>Diagnostics</summary>\n\n${diagnostic}\n\n</details>\n\n`,
      )
      .write()
  } catch (summaryErr) {
    core.warning(`job summary write failed: ${summaryErr?.message ?? 'unknown error'}`)
  }
}

// ---------------------------------------------------------------------------
// U3 — the review poster is deliberately dumb (KTD3): the CLI serializes the
// whole surface into code-review.json (`reviewComments[]` arrives
// eligibility-filtered, sanitized, severity-sorted, capped, keyed). This file
// only: freshness-gates the report (R9), dedups against posted comments (R10),
// validates anchors against the live diff (R8), dismisses stale self-reviews
// (KTD5), and POSTs one batched review with the serialized event plus a
// bounded retry ladder (R4/KTD4).

/** djb2 → 8 hex chars. Must match shortHash() in src/review/inline.ts — the
 *  CLI's dedupKey suffix is this hash over the raw suggestion text. */

/** Pull the fenced ```` ```suggestion ```` block out of a posted comment body.
 *  The CLI's fence is longest-backtick-run+1 (min 4), so a run of exactly the
 *  fence's length can only appear as the closing fence — the backreference is
 *  safe against interior ``` runs. */

/** Strip the model's `L<n>: <emoji> <sev>:` prefix so the sentence leads. */

/** Severity and message of an Argus inline comment in either format. */

/** Argus's own inline comment: the legacy prefix or the sentinel, at the very start. */

/** KTD4 key `path:line:severity:normalizedMessage:hash8(suggestion)`, rebuilt
 *  from a posted body; identical to the key the CLI serialized. */
function postedDedupKey(c) {
  return inlineDedupKey(c.path, c.line, c.body ?? '')
}

/** Fetch every page of a list endpoint (100/page, octokit shape). */
async function listAll(fn, params) {
  const out = []
  let page = 1
  for (;;) {
    const { data } = await fn({ ...params, per_page: 100, page })
    if (!Array.isArray(data) || data.length === 0) break
    out.push(...data)
    if (data.length < 100) break
    page += 1
  }
  return out
}

/** The GITHUB_TOKEN posts as `github-actions[bot]`; a custom token may post
 *  as its own login or `<actor>[bot]`. Match that set so stale *self* reviews
 *  are dismissed without ever touching a human reviewer's verdict. */
function isSelfLogin(login) {
  const actor = context.actor
  return (
    login === 'github-actions[bot]' ||
    login === actor ||
    (typeof actor === 'string' && actor !== '' && login === `${actor}[bot]`)
  )
}

/** RIGHT-side line numbers covered by a unified-diff patch. Every line in a
 *  hunk's `+c,d` range is a valid RIGHT-side anchor (context or added); `-`
 *  lines aren't counted in `d`, so the range is contiguous. */
function rightSideLines(patch) {
  const lines = new Set()
  for (const m of patch.matchAll(/@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/g)) {
    const start = Number.parseInt(m[1], 10)
    const count = m[2] === undefined ? 1 : Number.parseInt(m[2], 10)
    for (let l = start; l < start + count; l++) lines.add(l)
  }
  return lines
}

/** True when a serialized comment anchors inside the live diff — path in the
 *  file list and `line` (plus `start_line` when present) on a RIGHT-side
 *  hunk line. Files without a `patch` (large/binary) accept no comments. */
function isOnDiff(c, diffLines) {
  const valid = diffLines.get(c.path)
  return (
    valid !== undefined &&
    valid.has(c.line) &&
    (c.start_line === undefined || valid.has(c.start_line))
  )
}

async function planInlineComments(pr, codeReview) {
  if (!pr || !codeReview || codeReview.skipped) return undefined
  // Old-format reports carry no serialized surface — degrade to sticky +
  // status only, exactly as before U3. No review post, no API calls.
  if (!Array.isArray(codeReview.reviewComments)) return undefined

  // R9/KTD6 freshness — a planted or stale report must never produce
  // committable suggestions or a blocking review. The sticky still posts;
  // it renders status text, not code. Head sha is forgeable (public), so
  // when a run id exists the report must also carry it.
  const expectedNonce = (process.env.GITHUB_RUN_ID ?? '').trim()
  if (
    codeReview.headBinding?.intendedSha !== pr.head.sha ||
    (expectedNonce !== '' && codeReview.runNonce !== expectedNonce)
  ) {
    core.warning(
      `code-review.json head binding ` +
        `(${codeReview.headBinding?.intendedSha ?? 'missing'}) does not match ` +
        `PR head ${pr.head.sha}; skipping inline review`,
    )
    return undefined
  }

  const cap = typeof codeReview.maxComments === 'number' ? codeReview.maxComments : 20
  const overflow = typeof codeReview.commentsOverflow === 'number' ? codeReview.commentsOverflow : 0
  const prRef = {
    owner: context.repo.owner,
    repo: context.repo.repo,
    pull_number: pr.number,
  }

  // List failures degrade to sticky-only (warn), never crash main() before
  // the sticky posts.
  try {
    // R10 dedup — paginate fully and scope to the current head so comments on
    // older commits can't suppress still-valid findings. Keys are
    // reconstructed from the posted body in either format (KTD4: severity,
    // normalized message, hash of the embedded suggestion), so a re-run with
    // a corrected suggestion posts the fix instead of colliding.
    const posted = new Set()
    // Dedup + live-diff validation read independent API surfaces — one
    // round trip saved by fetching both up front.
    const [existing, files] = await Promise.all([
      listAll((p) => github.rest.pulls.listReviewComments(p), prRef),
      listAll((p) => github.rest.pulls.listFiles(p), prRef),
    ])
    for (const c of existing) {
      if (c.commit_id === pr.head.sha && typeof c.body === 'string' && isArgusInlineBody(c.body)) {
        posted.add(postedDedupKey(c))
      }
    }
    const fresh = codeReview.reviewComments.filter((c) => !posted.has(c.dedupKey))

    // R8 live-diff validation — the diff is authoritative only at post time;
    // drop anchors that aren't RIGHT-side lines in the current PR diff.
    const diffLines = new Map()
    for (const f of files) {
      if (typeof f.patch === 'string') diffLines.set(f.filename, rightSideLines(f.patch))
    }
    const comments = fresh.filter((c) => isOnDiff(c, diffLines))
    const offDiff = fresh.length - comments.length

    return {
      comments,
      diffLines,
      dropped: overflow + offDiff,
      cap,
      overflow,
      offDiff,
      event: codeReview.reviewEvent === 'request_changes' ? 'REQUEST_CHANGES' : 'COMMENT',
      verdict: codeReview.verdict,
      provenBlockers: codeReview.provenBlockers ?? 0,
      highConfidenceBlockers: codeReview.highConfidenceBlockers ?? 0,
    }
  } catch (e) {
    core.warning(`review planning failed: ${e.message}; the sticky comment still posts`)
    return undefined
  }
}

/** Review body: the verdict word with its glyph, then honest blocker counts
 *  (R6: reproduced and p-gated are never lumped). Always present, since
 *  REQUEST_CHANGES requires a body. Carries the sentinel so KTD5 dismissal can
 *  self-identify. */
function reviewBody(plan, note) {
  const verdict = Object.hasOwn(VERDICT_LABEL, plan.verdict ?? '')
    ? `${STATUS_GLYPH[VERDICT_STATUS[plan.verdict]]} ${VERDICT_LABEL[plan.verdict]}`
    : `${STATUS_GLYPH.inconclusive} verdict unknown`
  const parts = [`**Argus: ${verdict}**`]
  if (plan.provenBlockers > 0) parts.push(plural(plan.provenBlockers, 'reproduced blocker'))
  if (plan.highConfidenceBlockers > 0) parts.push(plural(plan.highConfidenceBlockers, 'high-confidence blocker'))
  let body = `${SENTINEL}\n${parts.join(' · ')}`
  if (note !== undefined) {
    body += `\n\n*${note.text}*`
    // Raw API status/message stays available but out of the reading path.
    if (note.diagnostic) {
      body += `\n\n<details><summary>Diagnostics</summary>\n\n${note.diagnostic}\n\n</details>`
    }
  }
  return body
}

async function postInlineComments(pr, plan) {
  if (plan === undefined) return
  const owner = context.repo.owner
  const repo = context.repo.repo

  // KTD5 — dismiss stale self reviews before posting so a fixed PR is never
  // left gated by an obsolete REQUEST_CHANGES. Prior argus reviews carry the
  // sentinel in their body; an empty-bodied PENDING draft is ours by
  // authorship. Dismissal failure warns but never blocks the post.
  try {
    const reviews = await listAll((p) => github.rest.pulls.listReviews(p), {
      owner,
      repo,
      pull_number: pr.number,
    })
    for (const r of reviews) {
      const stale =
        (r.state === 'CHANGES_REQUESTED' || r.state === 'PENDING') &&
        isSelfLogin(r.user?.login) &&
        (typeof r.body !== 'string' || r.body === '' || r.body.includes(SENTINEL))
      if (!stale) continue
      try {
        await github.rest.pulls.dismissReview({
          owner,
          repo,
          pull_number: pr.number,
          review_id: r.id,
          message: 'Superseded by a newer argus-reviewer review.',
        })
      } catch (e) {
        core.warning(`failed to dismiss stale review ${r.id}: ${e.message}`)
      }
    }
  } catch (e) {
    core.warning(`failed to list prior reviews for dismissal: ${e.message}`)
  }

  // A COMMENT review with nothing to say posts nothing — the sticky already
  // carries the verdict. REQUEST_CHANGES posts even with zero comments: the
  // gate intent must land.
  if (plan.event !== 'REQUEST_CHANGES' && plan.comments.length === 0) return

  // dedupKey is poster-local — the API gets path/line/side/body
  // (+start_line/start_side) verbatim.
  const toGh = (c) => {
    const { dedupKey: _dedupKey, ...rest } = c
    return rest
  }

  // KTD4 bounded retry ladder — at most three createReview calls:
  // (1) the serialized event; (2) on 403/422 (own-PR, permissions), COMMENT
  // with a downgrade note in the body; (3) on a comment-caused 422, drop
  // anchors failing diff membership and retry. Then warn and stop — never a
  // per-comment fallback loop.
  let event = plan.event
  let note
  let comments = plan.comments
  let lastErr
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await github.rest.pulls.createReview({
        owner,
        repo,
        pull_number: pr.number,
        commit_id: pr.head.sha,
        event,
        body: reviewBody(plan, note),
        comments: comments.map(toGh),
      })
      return
    } catch (e) {
      lastErr = e
      if (attempt === 0 && event === 'REQUEST_CHANGES' && (e.status === 403 || e.status === 422)) {
        event = 'COMMENT'
        note = {
          text:
            'Posted as a comment instead of requesting changes: GitHub did not allow a ' +
            'change request here (for example on your own PR, or without write permission).',
          diagnostic: `GitHub API ${e.status}: ${e.message}`,
        }
        continue
      }
      if (e.status === 422 && comments.length > 0) {
        const kept = comments.filter((c) => isOnDiff(c, plan.diffLines))
        if (kept.length < comments.length) {
          plan.dropped += comments.length - kept.length
          comments = kept
          continue
        }
      }
      break
    }
  }
  core.warning(`review post failed: ${lastErr?.message ?? 'unknown error'}; the sticky comment still posts`)
}

/** Create or update the one sticky comment (R9). The lookup reads every page,
 *  so a PR with more than 100 comments still has one sticky. A failed lookup
 *  skips the post rather than risk a duplicate sticky. */
async function postSticky(owner, repo, pr, body) {
  let existing
  try {
    const comments = await listAll((p) => github.rest.issues.listComments(p), {
      owner,
      repo,
      issue_number: pr.number,
    })
    existing = comments.find((c) => c.body && c.body.includes(SENTINEL))
  } catch (e) {
    await reportWriteFailure('find the existing PR comment, so it did not post one', e, 'pull-requests: read')
    return
  }
  try {
    if (existing) {
      await github.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body })
    } else {
      await github.rest.issues.createComment({ owner, repo, issue_number: pr.number, body })
    }
  } catch (e) {
    await reportWriteFailure(existing ? 'update the PR comment' : 'post the PR comment', e, 'pull-requests: write')
  }
}

// --- commit status (R8) ----------------------------------------------------------

/** GitHub rejects a commit status description over 140 characters. */
const STATUS_DESCRIPTION_MAX = 140

/** Join segments with ` · `, dropping whole trailing segments until the text
 *  fits; a lone first segment that still overflows is cut on a code point
 *  boundary and ends with an ellipsis, so no glyph is ever split. */
function fitStatusDescription(parts) {
  const kept = [...parts]
  let text = kept.join(' · ')
  while (text.length > STATUS_DESCRIPTION_MAX && kept.length > 1) {
    kept.pop()
    text = kept.join(' · ')
  }
  if (text.length <= STATUS_DESCRIPTION_MAX) return text
  const points = [...text]
  while (points.length > 0 && points.join('').length > STATUS_DESCRIPTION_MAX - 1) points.pop()
  return `${points.join('').trimEnd()}…`
}

/** The comment verdict line in status form: `<glyph> <verdict> · <n> findings · $<total>`.
 *  Cost and verdict come from the same sources the sticky header uses. */
function statusDescription({ conclusion, hasKey, ok, report, codeReview, manifest }) {
  if (conclusion === 'neutral') {
    return fitStatusDescription([statusText('skipped'), hasKey ? 'no lanes ran' : 'no OPENROUTER_API_KEY'])
  }
  const parts = [headline(ok, manifest?.aggregate?.status, codeReview)]
  const reviewed = codeReview && !codeReview.skipped
  if (reviewed) parts.push(plural(findingsOf(codeReview).length, 'finding'))
  const reviewSpend = reviewed ? codeReview.visionCostUsd ?? 0 : 0
  const cost = manifest !== undefined ? manifest.aggregate.costUsd : (report?.totals?.visionCostUsd ?? 0) + reviewSpend
  parts.push(formatUsd(cost))
  return fitStatusDescription(parts)
}

async function main() {
  const pr = context.payload && context.payload.pull_request
  const owner = context.repo.owner
  const repo = context.repo.repo
  const hasKey = !!process.env.OPENROUTER_API_KEY
  const workDir = process.env.VISION_E2E_WORKING_DIR || ''
  const reportDir = path.resolve(
    process.env.GITHUB_WORKSPACE,
    workDir,
    process.env.ARGUS_REPORT_DIR || 'argus-reviewer-report',
  )
  const runUrl = `${process.env.GITHUB_SERVER_URL}/${owner}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`

  let report
  let codeReview
  let manifest
  let manifestState = { state: 'missing' }
  // Every evidence file is run-scoped. GITHUB_RUN_ID is not knowable when a
  // commit or a planted file is authored (freshness, not secrecy — it is
  // public once the run exists), so a file that cannot present this run's
  // id is residue or plant and is ignored. No env → local/dogfood path,
  // where the gate is off by design.
  const expectedNonce = (process.env.GITHUB_RUN_ID ?? '').trim()
  const staleEvidence = []
  if (hasKey) {
    try {
      const raw = fs.readFileSync(path.join(reportDir, 'run.json'), 'utf8')
      const parsed = JSON.parse(raw)
      if (expectedNonce !== '' && parsed?.runNonce !== expectedNonce) {
        staleEvidence.push('run.json')
      } else {
        report = parsed
      }
    } catch {
      report = undefined
    }
    try {
      const raw = fs.readFileSync(path.join(reportDir, 'code-review.json'), 'utf8')
      const parsed = JSON.parse(raw)
      if (expectedNonce !== '' && parsed?.runNonce !== expectedNonce) {
        staleEvidence.push('code-review.json')
      } else {
        codeReview = parsed
      }
    } catch {
      codeReview = undefined
    }
    let raw
    try {
      raw = fs.readFileSync(path.join(reportDir, 'run-manifest.json'), 'utf8')
    } catch (e) {
      // Absent is "missing"; any other read error is "unreadable".
      raw = e && e.code === 'ENOENT' ? undefined : ''
    }
    manifestState = resolveManifest(raw, { headSha: pr ? pr.head.sha : context.sha, nonce: expectedNonce })
    manifest = manifestState.state === 'ok' ? manifestState.manifest : undefined
  }
  const reportHtmlPath = path.join(reportDir, 'report.html')
  const reportHtml = fs.existsSync(reportHtmlPath)
    ? path.relative(process.env.GITHUB_WORKSPACE || process.cwd(), reportHtmlPath).split(path.sep).join('/')
    : undefined

  // Missing code-review.json after a continue-on-error step means the review
  // crashed, not that it skipped — an intentional skip writes ok+skipped.
  // Fail closed rather than reporting it as a clean skip.
  const codeReviewOk = codeReview != null && codeReview.ok === true
  // run: 'false' consumers have no run.json by design — the conclusion then
  // reflects the code-review verdict alone.
  const runDisabled = process.env.ARGUS_RUN_DISABLED === '1'
  // A verify manifest is the authoritative lane verdict when it exists —
  // its aggregate already fails closed on missing lane reports. An
  // all-skipped aggregate (e.g. a push event where the review lane has no
  // PR to inspect) is a legitimate non-verdict — neutral, not failure,
  // matching the pre-manifest codeReviewOk contract.
  const aggregateSkipped =
    manifest !== undefined && manifest.aggregate.status === 'skipped'
  const ok = manifest !== undefined
    ? manifest.aggregate.ok === true
    : (runDisabled || report?.ok === true) && codeReviewOk
  const conclusion = !hasKey || aggregateSkipped ? 'neutral' : ok ? 'success' : 'failure'
  // Freshness + dedup + diff validation for the serialized review surface,
  // computed before the sticky body renders so the "+N not posted" note is
  // truthful. The review posts BEFORE the sticky so retry-ladder drops land
  // in that note too; a plan of undefined (old-format or stale report) makes
  // postInlineComments a no-op with no API calls.
  const inlinePlan = hasKey ? await planInlineComments(pr, codeReview) : undefined
  if (pr) await postInlineComments(pr, inlinePlan)
  const body = renderSticky({
    hasKey,
    runDisabled,
    eventName: context.eventName,
    report,
    codeReview,
    manifestState,
    inlinePlan,
    ok,
    reportDir,
    staleEvidence,
    runUrl,
    reportHtml,
  })

  if (pr) await postSticky(owner, repo, pr, body)

  const sha = pr ? pr.head.sha : context.sha
  // Commit statuses have no 'neutral'; a 'pending' skip would wedge a
  // required check forever, so skip maps to success with a clear label.
  const state = conclusion === 'failure' ? 'failure' : 'success'
  const description = statusDescription({ conclusion, hasKey, ok, report, codeReview, manifest })
  try {
    await github.rest.repos.createCommitStatus({
      owner,
      repo,
      sha,
      state,
      description,
      context: 'argus-reviewer',
      target_url: runUrl,
    })
  } catch (e) {
    await reportWriteFailure('set the commit status', e, 'statuses: write')
  }

  core.setOutput('conclusion', conclusion)
}

async function run(runtime) {
  github = runtime.github
  context = runtime.context
  core = runtime.core
  return main()
}

module.exports = {
  run,
  STATUS_GLYPH,
  PROOF_LEVELS,
  SEVERITY_GLYPH,
  SEVERITY_LABEL,
  VERDICT_STATUS,
  VERDICT_LABEL,
  proofMeter,
  validManifest,
  renderBody,
  renderReviewOnlyBody,
  renderManifestBody,
  renderManifestLanes,
  renderMissingKeyBody,
  renderNoReportBody,
  renderManifestStateBody,
  renderSticky,
  resolveManifest,
  COMMENT_BUDGET_BYTES,
  planInlineComments,
  postInlineComments,
  shortHash,
  postedDedupKey,
  INLINE_SENTINEL,
  normalizeFindingMessage,
  parseInlineBody,
  isArgusInlineBody,
  fitStatusDescription,
  statusDescription,
  reviewBody,
}
