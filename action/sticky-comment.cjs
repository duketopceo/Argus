/* eslint-disable @typescript-eslint/no-require-imports */

const fs = require('fs')
const path = require('path')

// The composite action injects these objects at runtime. Keeping them in a
// module-level runtime binding lets the GitHub script load this file with a
// normal require() instead of evaluating its source dynamically.
let github
let context
let core

const SENTINEL = '<!-- argus-reviewer -->'

function formatUsd(n) {
  return `$${(n || 0).toFixed(6)}`
}

/** Escape a report string for one markdown table cell. */
function cell(s) {
  return String(s ?? '')
    .replace(/\|/g, '\\|')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 200)
}

function renderMissingKeyBody() {
  const lines = []
  lines.push(SENTINEL)
  lines.push('')
  lines.push('## argus-reviewer ⚪ skipped')
  lines.push('')
  lines.push(
    '`OPENROUTER_API_KEY` is not configured. Add it as a repository or workflow secret to run argus-reviewer.',
  )
  lines.push('')
  lines.push('This status is intentionally neutral, not a failure.')
  lines.push('')
  return lines.join('\n')
}

function renderNoReportBody(reportDir, runUrl) {
  const lines = []
  lines.push(SENTINEL)
  lines.push('')
  lines.push('## argus-reviewer ⚠️ no report')
  lines.push('')
  lines.push(
    `The run step produced no \`run.json\` under \`${reportDir}\`. The commit status fails closed — check the action logs before merging.`,
  )
  lines.push('')
  lines.push(`[View run](${runUrl})`)
  lines.push('')
  return lines.join('\n')
}

function renderBody(report, codeReview, runUrl, ok, inlinePlan) {
  if (!report) return renderMissingKeyBody()

  const lines = []
  const budgetCap = report.config?.budgetUsd ?? 0
  const healCount = report.tests.reduce((n, t) => n + (t.healEvents?.length ?? 0), 0)
  const assertCount = report.tests.reduce((n, t) => n + (t.asserts?.length ?? 0), 0)
  const assertFails = report.tests.reduce(
    (n, t) => n + (t.asserts?.filter((a) => a.verdict === 'fail').length ?? 0),
    0,
  )
  const trace = report.trace ?? {}

  lines.push(SENTINEL)
  lines.push('')
  lines.push(`## argus-reviewer ${ok ? '✅ PASS' : '❌ FAIL'}`)
  lines.push('')
  lines.push(
    `**Summary:** ${report.totals.passed}/${report.totals.tests} passed · ` +
      `${report.totals.visionCalls} vision calls · ` +
      `${formatUsd(report.totals.visionCostUsd)} spend · ` +
      `${report.totals.sandboxSeconds.toFixed(1)}s sandbox`,
  )
  lines.push(
    `**Fingerprint cache:** ${report.totals.cacheHits ?? 0} hit(s) · ` +
      `${report.totals.cacheMisses ?? 0} miss(es) · ${report.totals.cacheHeals ?? 0} heal(s)`,
  )
  lines.push('')

  lines.push('<details>')
  lines.push('<summary>📝 Summary</summary>')
  lines.push('')
  lines.push('**What ran**')
  for (const t of report.tests) {
    lines.push(`- \`${path.basename(t.file)}\` — ${t.name}`)
  }
  lines.push('')
  lines.push(
    `**Risk:** ${ok ? 'Low — UI regression tests and code review passed; no heals or failures.' : 'High — investigate failures before merge.'}`,
  )
  lines.push('')
  if (Object.keys(trace).length > 0) {
    lines.push('**Trace**')
    for (const [k, v] of Object.entries(trace)) {
      lines.push(`- ${k}: \`${v}\``)
    }
    lines.push('')
  }
  lines.push('</details>')
  lines.push('')

  lines.push('<details>')
  lines.push(`<summary>📒 Tests (${report.totals.tests})</summary>`)
  lines.push('')
  lines.push('| Test | Result | Calls | Cost | Heals | Asserts |')
  lines.push('| --- | --- | ---: | ---: | ---: | ---: |')
  for (const t of report.tests) {
    const result = t.ok ? '✅ pass' : '❌ fail'
    lines.push(
      `| ${t.name} | ${result} | ${t.visionCalls} | ${formatUsd(t.visionCostUsd)} | ${t.healEvents?.length ?? 0} | ${t.asserts?.length ?? 0} |`,
    )
  }
  lines.push('')
  lines.push('</details>')
  lines.push('')

  lines.push('<details>')
  lines.push('<summary>💰 Cost ledger</summary>')
  lines.push('')
  lines.push('| Line item | Value |')
  lines.push('| --- | ---: |')
  lines.push(`| Vision calls | ${report.totals.visionCalls} |`)
  const perCall =
    report.totals.visionCalls > 0
      ? formatUsd(report.totals.visionCostUsd / report.totals.visionCalls)
      : '$0.00'
  lines.push(`| Per-call cost (avg) | ${perCall} |`)
  for (const model of Object.keys(report.totals.callsByModel ?? {}).sort()) {
    lines.push(`| Calls (${model}) | ${report.totals.callsByModel[model]} |`)
    lines.push(`| Spend (${model}) | ${formatUsd(report.totals.costByModel?.[model] ?? 0)} |`)
  }
  lines.push(`| Total vision spend | ${formatUsd(report.totals.visionCostUsd)} |`)
  lines.push(`| Sandbox seconds | ${report.totals.sandboxSeconds.toFixed(1)}s |`)
  if (budgetCap > 0) {
    lines.push(`| Budget cap | ${formatUsd(budgetCap)} |`)
    lines.push(`| Budget exceeded | ${report.totals.budgetExceeded ? '⚠️ yes' : '✅ no'} |`)
  }
  lines.push('')
  lines.push('</details>')
  lines.push('')

  lines.push('<details>')
  lines.push('<summary>🔧 Heal events</summary>')
  lines.push('')
  const heals = report.tests.flatMap((t) => t.healEvents ?? [])
  if (heals.length === 0) {
    lines.push('No heals this run.')
  } else {
    for (const h of heals) {
      lines.push(`- \`${h.instruction}\` healed with ${h.model || 'unknown model'}`)
    }
  }
  lines.push('')
  lines.push('</details>')
  lines.push('')

  lines.push('<details>')
  lines.push('<summary>✅ Assertions</summary>')
  lines.push('')
  let any = false
  for (const t of report.tests) {
    if (!t.asserts || t.asserts.length === 0) continue
    any = true
    lines.push(`**${t.name}**`)
    for (const a of t.asserts) {
      const icon = a.verdict === 'pass' ? '✅' : a.verdict === 'fail' ? '❌' : '⚪'
      lines.push(`- ${icon} *${a.question}* — ${a.reasoning}`)
    }
    lines.push('')
  }
  if (!any) {
    lines.push('No assertions recorded.')
    lines.push('')
  }
  lines.push('</details>')
  lines.push('')

  lines.push('<details>')
  lines.push('<summary>📂 Evidence</summary>')
  lines.push('')
  if (report.artifacts && report.artifacts.videos.length > 0) {
    for (const v of report.artifacts.videos) lines.push(`- video: \`${v}\``)
  }
  if (runUrl) lines.push(`- [workflow run / artifacts](${runUrl})`)
  if ((!report.artifacts || report.artifacts.videos.length === 0) && !runUrl) {
    lines.push('No artifact links available.')
  }
  lines.push('')
  lines.push('</details>')
  lines.push('')

  lines.push('<details>')
  lines.push('<summary>🚥 Pre-merge checks</summary>')
  lines.push('')
  lines.push('| Check | Status | Explanation |')
  lines.push('| --- | --- | --- |')
  lines.push(
    `| Tests | ${report.ok ? '✅ Passed' : '❌ Failed'} | ${report.totals.passed}/${report.totals.tests} tests passed |`,
  )
  lines.push(
    `| Budget | ${report.totals.budgetExceeded ? '⚠️ Warning' : '✅ Passed'} | ${formatUsd(report.totals.visionCostUsd)} spent${budgetCap > 0 ? ` of ${formatUsd(budgetCap)}` : ''} |`,
  )
  lines.push(
    `| Heal events | ${healCount === 0 ? '✅ Passed' : '⚠️ Warning'} | ${healCount} heal event${healCount === 1 ? '' : 's'} |`,
  )
  lines.push(
    `| Assertions | ${assertFails === 0 ? '✅ Passed' : '❌ Failed'} | ${assertFails === 0 ? assertCount : `${assertFails} failed`} assertion${assertCount === 1 ? '' : 's'} |`,
  )
  lines.push(`| OpenRouter key | ✅ Passed | \`OPENROUTER_API_KEY\` configured |`)
  if (codeReview && !codeReview.skipped) {
    const codeStatus = codeReview.ok ? '✅ Passed' : '❌ Failed'
    lines.push(
      `| Code review | ${codeStatus} | ${codeReview.findings.length} findings (${codeReview.model}) |`,
    )
  } else {
    lines.push(`| Code review | ⚪ Skipped | ${codeReview?.summary ?? 'no report'} |`)
  }
  lines.push('')
  lines.push('</details>')
  lines.push('')

  pushCodeReviewDetails(lines, codeReview, inlinePlan)

  lines.push('<details>')
  lines.push('<summary>✨ Actions</summary>')
  lines.push('')
  lines.push('- [ ] Re-run argus-reviewer')
  lines.push('- [ ] Open a heal PR')
  lines.push('- [ ] Record a new flow')
  lines.push('')
  lines.push('</details>')
  lines.push('')
  lines.push('---')
  lines.push('')
  lines.push('<sub>`argus-reviewer` — self-hosted, BYOK OpenRouter UI regression.</sub>')
  lines.push('')
  return lines.join('\n')
}

// The 🧠 Code review details block — shared by the full body and the
// review-only body (run lane disabled).
function pushCodeReviewDetails(lines, codeReview, inlinePlan) {
  if (!codeReview || codeReview.skipped) return
  lines.push('<details>')
  lines.push('<summary>🧠 Code review</summary>')
  lines.push('')
  lines.push(
    `**Verdict:** ${codeReview.verdict} · ${codeReview.model} · ${codeReview.tokens}tok ${formatUsd(codeReview.visionCostUsd)}`,
  )
  if (codeReview.headBinding) {
    lines.push(
      `**Head binding:** ${cell(codeReview.headBinding.status)} · ${cell(codeReview.headBinding.detail)}`,
    )
  }
  // U7 triage record — Jev annotate/route signals, never the gate.
  if (codeReview.triage) {
    const t = codeReview.triage
    if (t.unadjudicated === true) {
      lines.push(` · 🧭 triage unadjudicated — Jev unavailable`)
    } else {
      lines.push(
        ` · 🧭 triage: risk ${t.risk ?? '?'}/5` +
          `${typeof t.needsDeepReview === 'number' ? ` · deep-review ${t.needsDeepReview.toFixed(2)}` : ''}` +
          `${t.topRiskArea !== undefined ? ` · top area \`${cell(t.topRiskArea)}\`` : ''}` +
          ` (${cell(t.mode)})`,
      )
    }
  }
  if (Array.isArray(codeReview.probes) && codeReview.probes.length > 0) {
    const reproduced = codeReview.probes.filter((p) => p.outcome === 'reproduced').length
    lines.push(
      ` · 🧪 ${codeReview.probes.length} probe${codeReview.probes.length === 1 ? '' : 's'} run, ${reproduced} reproduced`,
    )
  }
  if (typeof codeReview.probeLaneSkipped === 'string') {
    lines.push(` · 🧪 probe lane skipped — ${cell(codeReview.probeLaneSkipped)}`)
  }
  lines.push('')
  lines.push(codeReview.summary)
  lines.push('')
  if (codeReview.findings.length > 0) {
    const evidenceIcon = {
      exercised: '✅',
      corroborated: '🔴',
      not_exercised: '⚪',
      inconclusive: '❔',
      reproduced: '🧪',
    }
    lines.push('| File | Severity | p | Category | Evidence | Finding |')
    lines.push('| --- | --- | --- | --- | --- | --- |')
    // Findings/evidence strings are model- and probe-emitted — sanitize
    // for the markdown table and bound the section so an oversized report
    // can't push the body past GitHub's 65536-char comment limit.
    const MAX_FINDING_ROWS = 25
    for (const f of codeReview.findings.slice(0, MAX_FINDING_ROWS)) {
      const ev = f.evidence
        ? `${evidenceIcon[f.evidence.status] ?? '❔'} ${cell(f.evidence.detail)}`
        : '—'
      // U8 — Jev P(true positive); unadjudicated findings render '—'.
      const p = typeof f.p === 'number' ? f.p.toFixed(2) : '—'
      lines.push(
        `| \`${cell(f.file)}\` | ${cell(f.severity)} | ${p} | ${cell(f.category ?? '—')} | ${ev} | ${cell(f.message)} |`,
      )
    }
    if (codeReview.findings.length > MAX_FINDING_ROWS) {
      lines.push(
        `| … | — | — | — | — | ${codeReview.findings.length - MAX_FINDING_ROWS} more findings in \`code-review.json\` |`,
      )
    }
    lines.push('')
    // Serialized comments that didn't post — the maxComments cap
    // (serialized overflow) plus post-time drops (off-diff anchors,
    // retry-ladder discards).
    if (inlinePlan !== undefined && inlinePlan.dropped > 0) {
      const overflow = inlinePlan.overflow ?? 0
      const reasons = []
      if (overflow > 0) reasons.push(`\`review.maxComments\` cap ${inlinePlan.cap}`)
      if (inlinePlan.dropped - overflow > 0) {
        reasons.push(`${inlinePlan.dropped - overflow} outside the PR diff`)
      }
      lines.push(`*+${inlinePlan.dropped} inline comment(s) not posted — ${reasons.join(', ')}.*`)
      lines.push('')
    }
    // Secrets-lane audit line — adjudicated/suppressed counts, never literals.
    if (codeReview.secretsScan) {
      if (typeof codeReview.secretsScan.skipped === 'string') {
        lines.push(`*🔐 secrets scan skipped — ${cell(codeReview.secretsScan.skipped)}*`)
      } else if (Array.isArray(codeReview.secretsScan.records)) {
        const suppressed = codeReview.secretsScan.records.filter((r) => r.suppressed).length
        const unadj = codeReview.secretsScan.records.filter((r) => !r.adjudicated).length
        lines.push(
          `*🔐 secrets scan: ${codeReview.secretsScan.records.length} candidate(s)` +
            `${suppressed > 0 ? `, ${suppressed} adjudicated-suppressed` : ''}` +
            `${unadj > 0 ? `, ${unadj} unadjudicated` : ''}` +
            `${codeReview.secretsScan.overflow > 0 ? `, +${codeReview.secretsScan.overflow} over cap` : ''}.*`,
        )
      }
      lines.push('')
    }
  }
  // U8 adjudication audit — outside the findings guard so suppressed-
  // only reviews still show what Jev removed. p values live on the
  // findings table and in code-review.json records.
  if (codeReview.findingAdjudication && Array.isArray(codeReview.findingAdjudication.records)) {
    const fa = codeReview.findingAdjudication
    if (fa.unadjudicated === true) {
      lines.push('*🧮 adjudication: unadjudicated — Jev unavailable, nothing suppressed.*')
    } else {
      const suppressed = fa.records.filter((r) => r.suppressed).length
      const unadj = fa.records.filter((r) => !r.adjudicated).length
      lines.push(
        `*🧮 adjudication: ${fa.records.length} finding(s) scored` +
          `${suppressed > 0 ? `, ${suppressed} suppressed (nit/q)` : ''}` +
          `${unadj > 0 ? `, ${unadj} unadjudicated` : ''}` +
          `${fa.overflow > 0 ? `, +${fa.overflow} over cap` : ''}.*`,
      )
    }
    lines.push('')
  }
  lines.push('</details>')
  lines.push('')
}

// Sticky body for `run: 'false'` consumers — no run.json exists by
// design, so the body and conclusion reflect code-review alone.
function renderReviewOnlyBody(codeReview, runUrl, ok, inlinePlan) {
  const lines = []
  lines.push(SENTINEL)
  lines.push('')
  lines.push(`## argus-reviewer ${ok ? '✅ PASS' : '❌ FAIL'}`)
  lines.push('')
  if (!codeReview) {
    lines.push(
      '**Summary:** code-review only (run lane disabled) — no `code-review.json` found. The review step crashed or produced no report; the commit status fails closed — check the action logs before merging.',
    )
  } else if (codeReview.skipped) {
    lines.push(
      `**Summary:** code-review only (run lane disabled) — review skipped: ${cell(codeReview.summary)}`,
    )
  } else {
    lines.push(
      `**Summary:** code review only (run lane disabled) · verdict **${codeReview.verdict}** · ` +
        `${codeReview.findings.length} finding(s) · ${codeReview.model} · ` +
        `${codeReview.tokens}tok ${formatUsd(codeReview.visionCostUsd)}`,
    )
  }
  lines.push('')
  lines.push('<details>')
  lines.push('<summary>🚥 Pre-merge checks</summary>')
  lines.push('')
  lines.push('| Check | Status | Explanation |')
  lines.push('| --- | --- | --- |')
  lines.push('| OpenRouter key | ✅ Passed | `OPENROUTER_API_KEY` configured |')
  if (codeReview && !codeReview.skipped) {
    const codeStatus = codeReview.ok ? '✅ Passed' : '❌ Failed'
    lines.push(
      `| Code review | ${codeStatus} | ${codeReview.findings.length} findings (${codeReview.model}) |`,
    )
  } else {
    lines.push(
      `| Code review | ${codeReview ? '⚪ Skipped' : '❌ Failed'} | ${cell(codeReview?.summary ?? 'no report')} |`,
    )
  }
  lines.push('')
  lines.push('</details>')
  lines.push('')
  pushCodeReviewDetails(lines, codeReview, inlinePlan)
  if (runUrl) lines.push(`[View run](${runUrl})`)
  lines.push('')
  lines.push('<details>')
  lines.push('<summary>✨ Actions</summary>')
  lines.push('')
  lines.push('- [ ] Re-run argus-reviewer')
  lines.push('')
  lines.push('</details>')
  lines.push('')
  lines.push('---')
  lines.push('')
  lines.push('<sub>`argus-reviewer` — self-hosted, BYOK OpenRouter UI regression.</sub>')
  lines.push('')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// U3 — the review poster is deliberately dumb (KTD3): the CLI serializes the
// whole surface into code-review.json (`reviewComments[]` arrives
// eligibility-filtered, sanitized, severity-sorted, capped, keyed). This file
// only: freshness-gates the report (R9), dedups against posted comments (R10),
// validates anchors against the live diff (R8), dismisses stale self-reviews
// (KTD5), and POSTs one batched review with the serialized event plus a
// bounded retry ladder (R4/KTD4).

/** djb2 → 8 hex chars. Must match shortHash() in src/cli.ts — the CLI's
 *  dedupKey suffix is this hash over the raw suggestion text. */
function shortHash(s) {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(16).padStart(8, '0')
}

/** Pull the fenced ```` ```suggestion ```` block out of a posted comment body.
 *  The CLI's fence is longest-backtick-run+1 (min 4), so a run of exactly the
 *  fence's length can only appear as the closing fence — the backreference is
 *  safe against interior ``` runs. */
function extractSuggestion(body) {
  const m = /\r?\n(`{4,})suggestion\r?\n([\s\S]*?)\r?\n\1/.exec(body)
  return m === null ? '' : m[2]
}

/** Reconstruct the R10 dedupKey for an already-posted review comment:
 *  `path:line:bodyFirstLine:hash8(suggestion|'')` — identical to the key the
 *  CLI serialized, so a corrected suggestion re-posts instead of colliding. */
function postedDedupKey(c) {
  const body = c.body ?? ''
  return `${c.path}:${c.line}:${body.split('\n')[0]}:${shortHash(extractSuggestion(body))}`
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
  // it renders status text, not code.
  if (codeReview.headBinding?.intendedSha !== pr.head.sha) {
    core.warning(
      `code-review.json head binding ` +
        `(${codeReview.headBinding?.intendedSha ?? 'missing'}) does not match ` +
        `PR head ${pr.head.sha} — skipping inline review`,
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
    // reconstructed from the posted body (first line + hash of the embedded
    // suggestion), so a re-run with a corrected suggestion posts the fix
    // instead of colliding.
    const posted = new Set()
    const existing = await listAll((p) => github.rest.pulls.listReviewComments(p), prRef)
    for (const c of existing) {
      if (
        c.commit_id === pr.head.sha &&
        typeof c.body === 'string' &&
        c.body.startsWith('**argus-reviewer')
      ) {
        posted.add(postedDedupKey(c))
      }
    }
    const fresh = codeReview.reviewComments.filter((c) => !posted.has(c.dedupKey))

    // R8 live-diff validation — the diff is authoritative only at post time;
    // drop anchors that aren't RIGHT-side lines in the current PR diff.
    const files = await listAll((p) => github.rest.pulls.listFiles(p), prRef)
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
    core.warning(`review planning failed: ${e.message} — sticky still posts`)
    return undefined
  }
}

/** Review body: verdict line + honest blocker counts (R6 — reproduced and
 *  p-gated are never lumped). Always present — REQUEST_CHANGES requires a
 *  body. Carries the sentinel so KTD5 dismissal can self-identify. */
function reviewBody(plan, note) {
  const parts = [`verdict **${plan.verdict ?? 'unknown'}**`]
  if (plan.provenBlockers > 0) {
    parts.push(`⛔ ${plan.provenBlockers} reproduced blocker(s)`)
  }
  if (plan.highConfidenceBlockers > 0) {
    parts.push(`◎ ${plan.highConfidenceBlockers} high-confidence blocker(s)`)
  }
  let body = `${SENTINEL}\n**argus-reviewer** — ${parts.join(' · ')}`
  if (note !== undefined) body += `\n\n*${note}*`
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
        note = `REQUEST_CHANGES downgraded to COMMENT — ${e.status} ${e.message}`
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
  core.warning(`review post failed: ${lastErr?.message ?? 'unknown error'} — sticky still posts`)
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
  if (hasKey) {
    try {
      const raw = fs.readFileSync(path.join(reportDir, 'run.json'), 'utf8')
      report = JSON.parse(raw)
    } catch {
      report = undefined
    }
    try {
      const raw = fs.readFileSync(path.join(reportDir, 'code-review.json'), 'utf8')
      codeReview = JSON.parse(raw)
    } catch {
      codeReview = undefined
    }
  }

  // Missing code-review.json after a continue-on-error step means the review
  // crashed, not that it skipped — an intentional skip writes ok+skipped.
  // Fail closed rather than reporting it as a clean skip.
  const codeReviewOk = codeReview != null && codeReview.ok === true
  // run: 'false' consumers have no run.json by design — the conclusion then
  // reflects the code-review verdict alone.
  const runDisabled = process.env.ARGUS_RUN_DISABLED === '1'
  const ok = (runDisabled || report?.ok === true) && codeReviewOk
  const conclusion = !hasKey ? 'neutral' : ok ? 'success' : 'failure'
  // Freshness + dedup + diff validation for the serialized review surface,
  // computed before the sticky body renders so the "+N not posted" note is
  // truthful. The review posts BEFORE the sticky so retry-ladder drops land
  // in that note too; a plan of undefined (old-format or stale report) makes
  // postInlineComments a no-op with no API calls.
  const inlinePlan = hasKey ? await planInlineComments(pr, codeReview) : undefined
  if (pr) await postInlineComments(pr, inlinePlan)
  const body = !hasKey
    ? renderMissingKeyBody()
    : runDisabled
      ? renderReviewOnlyBody(codeReview, runUrl, ok, inlinePlan)
      : report === undefined
        ? renderNoReportBody(reportDir, runUrl)
        : renderBody(report, codeReview, runUrl, ok, inlinePlan)

  if (pr) {
    const { data: comments } = await github.rest.issues.listComments({
      owner,
      repo,
      issue_number: pr.number,
      per_page: 100,
    })
    const existing = comments.find((c) => c.body && c.body.includes(SENTINEL))
    if (existing) {
      await github.rest.issues.updateComment({
        owner,
        repo,
        comment_id: existing.id,
        body,
      })
    } else {
      await github.rest.issues.createComment({
        owner,
        repo,
        issue_number: pr.number,
        body,
      })
    }
  }

  const sha = pr ? pr.head.sha : context.sha
  // Commit statuses have no 'neutral'; a 'pending' skip would wedge a
  // required check forever, so skip maps to success with a clear label.
  const state = conclusion === 'failure' ? 'failure' : 'success'
  const description =
    conclusion === 'neutral'
      ? 'argus-reviewer skipped (no OPENROUTER_API_KEY)'
      : `argus-reviewer ${conclusion}`
  await github.rest.repos.createCommitStatus({
    owner,
    repo,
    sha,
    state,
    description,
    context: 'argus-reviewer',
    target_url: runUrl,
  })

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
  renderBody,
  renderReviewOnlyBody,
  renderMissingKeyBody,
  renderNoReportBody,
  planInlineComments,
  postInlineComments,
  shortHash,
  postedDedupKey,
}
