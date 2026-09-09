/* global github, context, core, require, process */

const fs = require('fs')
const path = require('path')

const SENTINEL = '<!-- vision-e2e -->'

function formatUsd(n) {
  return `$${(n || 0).toFixed(6)}`
}

function renderMissingKeyBody() {
  const lines = []
  lines.push(SENTINEL)
  lines.push('')
  lines.push('## vision-e2e ⚪ skipped — no OpenRouter key')
  lines.push('')
  lines.push('`OPENROUTER_API_KEY` is not configured. Add it as a repository or workflow secret to run vision-e2e.')
  lines.push('')
  lines.push('This status is intentionally neutral, not a failure.')
  lines.push('')
  return lines.join('\n')
}

function renderBody(report, runUrl) {
  if (!report) return renderMissingKeyBody()
  const lines = []
  lines.push(SENTINEL)
  lines.push('')
  const budget = report.totals.budgetExceeded ? ' (budget cap exceeded)' : ''
  const status = report.ok ? `✅ PASS${budget}` : `❌ FAIL${budget}`
  lines.push(`## vision-e2e ${status}`)
  lines.push('')
  lines.push(
    `**Summary:** ${report.totals.passed}/${report.totals.tests} passed · ` +
      `${report.totals.visionCalls} vision calls · ` +
      `${formatUsd(report.totals.visionCostUsd)} spend · ` +
      `${report.totals.sandboxSeconds.toFixed(1)}s sandbox`,
  )
  lines.push('')
  lines.push('### Tests')
  lines.push('')
  lines.push('| Test | Result | Calls | Cost |')
  lines.push('| --- | --- | --- | --- |')
  for (const t of report.tests) {
    const result = t.ok ? '✅ pass' : '❌ fail'
    lines.push(`| ${t.name} | ${result} | ${t.visionCalls} | ${formatUsd(t.visionCostUsd)} |`)
  }
  lines.push('')
  lines.push('### Cost ledger')
  lines.push('')
  lines.push('| Line item | Value |')
  lines.push('| --- | --- |')
  lines.push(`| Vision calls | ${report.totals.visionCalls} |`)
  const perCall =
    report.totals.visionCalls > 0
      ? formatUsd(report.totals.visionCostUsd / report.totals.visionCalls)
      : '$0.00'
  lines.push(`| Per-call cost (avg) | ${perCall} |`)
  lines.push(`| Total vision spend | ${formatUsd(report.totals.visionCostUsd)} |`)
  lines.push(`| Sandbox seconds | ${report.totals.sandboxSeconds.toFixed(1)}s |`)
  lines.push('')
  lines.push('### Heal events')
  lines.push('')
  const heals = report.tests.reduce((acc, t) => acc.concat(t.healEvents || []), [])
  if (heals.length === 0) {
    lines.push('No heals this run.')
  } else {
    for (const h of heals) {
      lines.push(`- \`${h.instruction}\` healed with ${h.model || 'unknown model'}`)
    }
  }
  lines.push('')
  lines.push('### Assertions')
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
  lines.push('### Evidence')
  lines.push('')
  if (report.artifacts && report.artifacts.videos.length > 0) {
    for (const v of report.artifacts.videos) lines.push(`- video: ${v}`)
  }
  if (runUrl) lines.push(`- [workflow run / artifacts](${runUrl})`)
  if ((!report.artifacts || report.artifacts.videos.length === 0) && !runUrl) {
    lines.push('No artifact links available.')
  }
  return lines.join('\n')
}

async function main() {
  const pr = context.payload && context.payload.pull_request
  const owner = context.repo.owner
  const repo = context.repo.repo
  const hasKey = !!process.env.OPENROUTER_API_KEY
  const workDir = process.env.VISION_E2E_WORKING_DIR || ''
  const reportDir = path.resolve(process.env.GITHUB_WORKSPACE, workDir, 'vision-e2e-report')
  const runUrl = `${process.env.GITHUB_SERVER_URL}/${owner}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`

  let report
  if (hasKey) {
    try {
      const raw = fs.readFileSync(path.join(reportDir, 'run.json'), 'utf8')
      report = JSON.parse(raw)
    } catch {
      report = undefined
    }
  }

  const conclusion = !hasKey ? 'neutral' : report && report.ok ? 'success' : 'failure'
  const body = !hasKey ? renderMissingKeyBody() : renderBody(report, runUrl)

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
  const state = conclusion === 'success' ? 'success' : conclusion === 'failure' ? 'failure' : 'pending'
  await github.rest.repos.createCommitStatus({
    owner,
    repo,
    sha,
    state,
    description: `vision-e2e ${conclusion}`,
    context: 'vision-e2e',
    target_url: runUrl,
  })

  core.setOutput('conclusion', conclusion)
}

return await main()
