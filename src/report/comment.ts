import { RunReport, TestReport } from './run.js'

export const SENTINEL = '<!-- vision-e2e -->'

export interface CommentOptions {
  /** Link to the workflow run or artifact index. */
  runUrl?: string
}

function formatUsd(n: number): string {
  return `$${(n ?? 0).toFixed(6)}`
}

function statusLine(report: RunReport | undefined, missingKey: boolean): string {
  if (missingKey) return '## vision-e2e ⚪ skipped — no OpenRouter key'
  if (!report) return '## vision-e2e ⚪ no report'
  const emoji = report.ok ? '✅' : '❌'
  const status = report.ok ? 'PASS' : 'FAIL'
  const budget = report.totals.budgetExceeded ? ' (budget cap exceeded)' : ''
  return `## vision-e2e ${emoji} ${status}${budget}`
}

function testRows(tests: TestReport[]): string[] {
  const lines = ['### Tests', '']
  lines.push('| Test | Result | Calls | Cost | Failure |')
  lines.push('| --- | --- | --- | --- | --- |')
  for (const t of tests) {
    const result = t.ok ? '✅ pass' : '❌ fail'
    const failure = t.failureMessage ? t.failureMessage.replace(/\|/g, '\\|') : ''
    lines.push(`| ${t.name} | ${result} | ${t.visionCalls} | ${formatUsd(t.visionCostUsd)} | ${failure} |`)
  }
  return lines
}

function costRows(totals: RunReport['totals']): string[] {
  const lines = ['### Cost ledger', '']
  lines.push('| Line item | Value |')
  lines.push('| --- | --- |')
  lines.push(`| Vision calls | ${totals.visionCalls} |`)
  const perCall =
    totals.visionCalls > 0 ? formatUsd(totals.visionCostUsd / totals.visionCalls) : '$0.00'
  lines.push(`| Per-call cost (avg) | ${perCall} |`)
  lines.push(`| Total vision spend | ${formatUsd(totals.visionCostUsd)} |`)
  lines.push(`| Sandbox seconds | ${totals.sandboxSeconds.toFixed(1)}s |`)
  return lines
}

function healRows(tests: TestReport[]): string[] {
  const lines = ['### Heal events', '']
  const heals = tests.flatMap((t) => t.healEvents)
  if (heals.length === 0) {
    lines.push('No heals this run.')
  } else {
    for (const h of heals) {
      lines.push(`- \`${h.instruction}\` healed with ${h.model ?? 'unknown model'}`)
    }
  }
  return lines
}

function assertRows(tests: TestReport[]): string[] {
  const lines = ['### Assertions', '']
  let any = false
  for (const t of tests) {
    if (t.asserts.length === 0) continue
    any = true
    lines.push(`**${t.name}**`)
    for (const a of t.asserts) {
      const icon = a.verdict === 'pass' ? '✅' : '❌'
      lines.push(`- ${icon} *${a.question}* — ${a.reasoning}`)
    }
    lines.push('')
  }
  if (!any) {
    lines.push('No assertions recorded.')
  }
  return lines
}

function evidenceRows(videos: string[], runUrl: string | undefined): string[] {
  const lines = ['### Evidence', '']
  for (const v of videos) {
    lines.push(`- video: ${v}`)
  }
  if (runUrl) {
    lines.push(`- [workflow run / artifacts](${runUrl})`)
  }
  if (videos.length === 0 && !runUrl) {
    lines.push('No artifact links configured.')
  }
  return lines
}

function missingKeyBody(): string[] {
  return [
    '',
    '`OPENROUTER_API_KEY` is not configured. Add it as a repository or workflow secret to run vision-e2e.',
    '',
    'This status is intentionally neutral, not a failure.',
    '',
  ]
}

function noReportBody(): string[] {
  return [
    '',
    'No run report was produced. The run may have failed before writing reports.',
    '',
  ]
}

/** Render the sticky PR comment markdown from a run report (or a missing-key state). */
export function renderComment(
  report: RunReport | undefined,
  opts: CommentOptions & { missingKey?: boolean } = {},
): string {
  const lines = [SENTINEL, '']
  lines.push(statusLine(report, opts.missingKey ?? false))
  lines.push('')

  if (opts.missingKey) {
    lines.push(...missingKeyBody())
  } else if (!report) {
    lines.push(...noReportBody())
  } else {
    lines.push(
      `**Summary:** ${report.totals.passed}/${report.totals.tests} passed · ` +
        `${report.totals.visionCalls} vision calls · ` +
        `${formatUsd(report.totals.visionCostUsd)} spend · ` +
        `${report.totals.sandboxSeconds.toFixed(1)}s sandbox · ` +
        `${(report.durationMs / 1000).toFixed(1)}s wall`,
    )
    lines.push('')
    lines.push(...testRows(report.tests))
    lines.push(...costRows(report.totals))
    lines.push(...healRows(report.tests))
    lines.push(...assertRows(report.tests))
    lines.push(...evidenceRows(report.artifacts.videos, opts.runUrl))
  }

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
