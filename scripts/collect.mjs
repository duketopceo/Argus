// Shared data collector for `npm run watch` (TUI) and `npm run app` (Electron).
// Reads `gh` CLI + local artifacts only — nothing leaves the machine.
import { execFile } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
export const ROOT = new URL('..', import.meta.url).pathname

async function gh(args, cwd) {
  const { stdout } = await exec('gh', args, { cwd, maxBuffer: 8 * 1024 * 1024 })
  return JSON.parse(stdout)
}

// Sanitize strings from repo/PR/journal data before display — strip control
// chars so a malicious branch name or commit msg can't inject escapes.
export function safe(s) {
  return String(s ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\x1b/g, ' ')
}

export async function collect(root = ROOT) {
  const state = {
    prs: [],
    prChecks: {},
    runs: [],
    evalDoc: '',
    evalFile: '',
    journal: undefined,
    journals: [],
    journalFiles: 0,
    live: [],
    review: undefined,
    error: '',
    updatedAt: new Date().toISOString(),
  }

  try {
    const [prs, runs] = await Promise.all([
      gh(['pr', 'list', '--json', 'number,title,mergeStateStatus,reviewDecision,headRefName,state,author', '--limit', '12'], root),
      gh(['run', 'list', '--limit', '8', '--json', 'displayTitle,status,conclusion,workflowName,createdAt,headBranch,databaseId'], root),
    ])
    state.prs = prs.map((p) => ({ ...p, title: safe(p.title), headRefName: safe(p.headRefName) }))
    state.runs = runs.map((r) => ({ ...r, displayTitle: safe(r.displayTitle), headBranch: safe(r.headBranch) }))
    const checks = await Promise.all(
      prs.slice(0, 6).map((p) =>
        gh(['pr', 'checks', String(p.number), '--json', 'name,state,bucket'], root)
          .then((c) => [p.number, c.map((x) => ({ ...x, name: safe(x.name) }))])
          .catch(() => [p.number, []]),
      ),
    )
    state.prChecks = Object.fromEntries(checks)
  } catch (e) {
    state.error = `gh: ${safe(e.message).split('\n')[0]}`
  }

  const evalsDir = join(root, 'docs/evals')
  if (existsSync(evalsDir)) {
    const files = (await readdir(evalsDir)).filter((f) => f.endsWith('.md')).sort()
    const last = files[files.length - 1]
    if (last) {
      state.evalFile = last
      state.evalDoc = safe(await readFile(join(evalsDir, last), 'utf8'))
    }
  }

  const journalDir = join(root, '.argus-reviewer-cache/journal')
  if (existsSync(journalDir)) {
    const files = (await readdir(journalDir)).filter((f) => f.endsWith('.json')).sort()
    state.journalFiles = files.length
    const recent = files.slice(-20)
    for (const f of recent) {
      try {
        const j = JSON.parse(await readFile(join(journalDir, f), 'utf8'))
        state.journals.push({
          runId: safe(j.runId ?? f.replace(/\.json$/, '')),
          ok: !!j.ok,
          costUsd: j.costUsd ?? 0,
          steps: Array.isArray(j.steps) ? j.steps.length : 0,
          errors: (j.errors ?? []).length,
        })
      } catch { /* partial write */ }
    }
    state.journal = state.journals.length
      ? JSON.parse(await readFile(join(journalDir, recent[recent.length - 1]), 'utf8'))
      : undefined
    state.journalFile = recent[recent.length - 1]
  }

  // Recent live.ndjson lines — argus processes (code-review, run, debug)
  // append NDJSON here; the TUI shows the tail between refreshes.
  const livePath = join(root, '.argus-reviewer-cache/live.ndjson')
  if (existsSync(livePath)) {
    try {
      const lines = (await readFile(livePath, 'utf8')).split('\n').filter(Boolean)
      state.live = lines.slice(-20).map((l) => {
        try {
          const e = JSON.parse(l)
          return { ts: e.ts ?? 0, source: safe(e.source), level: safe(e.level), msg: safe(e.msg) }
        } catch {
          return { ts: 0, source: '?', level: 'info', msg: safe(l.slice(0, 200)) }
        }
      })
    } catch { /* partial write */ }
  }

  // Latest code-review.json summary — verdict/cost/counts for the pane.
  const reviewPath = join(root, 'argus-reviewer-report/code-review.json')
  if (existsSync(reviewPath)) {
    try {
      const r = JSON.parse(await readFile(reviewPath, 'utf8'))
      state.review = {
        skipped: !!r.skipped,
        verdict: safe(r.verdict),
        findings: Array.isArray(r.findings) ? r.findings.length : 0,
        costUsd: r.visionCostUsd ?? 0,
        tokens: r.tokens ?? 0,
        model: safe(r.model),
        budgetExceeded: !!r.budgetExceeded,
      }
    } catch { /* partial write */ }
  }
  return state
}
