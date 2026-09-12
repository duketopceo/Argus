#!/usr/bin/env node
// argus-reviewer watch — local-only TUI: PRs, checks, workflow runs, evals,
// journals. No deps; reads `gh` CLI + local artifacts. `npm run watch`.
// Keys: r refresh · e run eval · q quit. Auto-refresh every 30s.

import { execFile, spawn } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const ROOT = new URL('..', import.meta.url).pathname
const REFRESH_MS = 30_000
const MAX_W = 100

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  magenta: '\x1b[35m',
}
const paint = (s, c) => `${c}${s}${C.reset}`
const ok = (s) => paint(s, C.green)
const bad = (s) => paint(s, C.red)
const warn = (s) => paint(s, C.yellow)

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '')
const trunc = (s, w = MAX_W - 4) => (strip(s).length > w ? `${strip(s).slice(0, w - 1)}…` : s)

function hr(title) {
  const line = `── ${title} `
  return paint(line + '─'.repeat(Math.max(0, MAX_W - strip(line).length)), C.dim)
}

async function gh(args) {
  const { stdout } = await exec('gh', args, { cwd: ROOT, maxBuffer: 8 * 1024 * 1024 })
  return JSON.parse(stdout)
}

const state = {
  prs: [],
  prChecks: {},
  runs: [],
  evalDoc: '',
  journal: undefined,
  evalRunning: false,
  evalLog: [],
  error: '',
  updatedAt: new Date(),
}

async function fetchData() {
  try {
    const [prs, runs] = await Promise.all([
      gh(['pr', 'list', '--json', 'number,title,mergeStateStatus,reviewDecision,headRefName,state', '--limit', '12']),
      gh(['run', 'list', '--limit', '8', '--json', 'displayTitle,status,conclusion,workflowName,createdAt,headBranch']),
    ])
    state.prs = prs
    state.runs = runs
    const checks = await Promise.all(
      prs.slice(0, 6).map((p) =>
        gh(['pr', 'checks', String(p.number), '--json', 'name,state,bucket'])
          .then((c) => [p.number, c])
          .catch(() => [p.number, []]),
      ),
    )
    state.prChecks = Object.fromEntries(checks)
    state.error = ''
  } catch (e) {
    state.error = `gh: ${e.message.split('\n')[0]}`
  }

  const evalsDir = join(ROOT, 'docs/evals')
  if (existsSync(evalsDir)) {
    const files = (await readdir(evalsDir)).filter((f) => f.endsWith('.md')).sort()
    const last = files[files.length - 1]
    if (last) state.evalDoc = await readFile(join(evalsDir, last), 'utf8')
  }

  const journalDir = join(ROOT, '.argus-reviewer-cache/journal')
  if (existsSync(journalDir)) {
    const files = (await readdir(journalDir)).filter((f) => f.endsWith('.json')).sort()
    const last = files[files.length - 1]
    if (last) {
      try {
        state.journal = JSON.parse(await readFile(join(journalDir, last), 'utf8'))
      } catch { /* partial write */ }
    }
  }
  state.updatedAt = new Date()
}

function checkIcon(c) {
  if (c.state === 'SUCCESS') return ok('✓')
  if (c.state === 'FAILURE' || c.bucket === 'fail') return bad('✗')
  if (c.state === 'PENDING' || c.bucket === 'pending') return warn('…')
  return paint('·', C.dim)
}

function render() {
  const out = []
  out.push(
    paint('argus-reviewer watch', C.bold + C.cyan) +
      paint(`  ${state.updatedAt.toLocaleTimeString()}  r refresh · e eval · q quit`, C.dim),
  )
  if (state.error) out.push(bad(`  ${state.error}`))
  out.push('')

  out.push(hr('Pull Requests'))
  if (state.prs.length === 0) out.push(paint('  none open', C.dim))
  for (const p of state.prs) {
    const checks = state.prChecks[p.number] ?? []
    const line = `  ${paint(`#${p.number}`, C.cyan)} ${trunc(p.title, 52)}`
    const verdict = p.reviewDecision === 'CHANGES_REQUESTED' ? bad('changes')
      : p.reviewDecision === 'APPROVED' ? ok('approved')
      : paint(p.mergeStateStatus.toLowerCase(), C.dim)
    out.push(`${line}  ${verdict}`)
    for (const c of checks.slice(0, 6)) {
      out.push(`     ${checkIcon(c)} ${trunc(c.name, 40)}`)
    }
  }
  out.push('')

  out.push(hr('Workflow Runs'))
  for (const r of state.runs) {
    const icon = r.conclusion === 'success' ? ok('✓')
      : r.conclusion === 'failure' ? bad('✗')
      : r.status === 'in_progress' || r.status === 'queued' ? warn('…')
      : paint('·', C.dim)
    const age = Math.round((Date.now() - new Date(r.createdAt).getTime()) / 60000)
    out.push(`  ${icon} ${trunc(r.displayTitle, 46)} ${paint(`${r.workflowName} · ${r.headBranch} · ${age}m`, C.dim)}`)
  }
  out.push('')

  out.push(hr('Latest Eval'))
  if (state.evalDoc) {
    for (const l of state.evalDoc.split('\n').slice(0, 14)) out.push(`  ${trunc(l)}`)
  } else {
    out.push(paint('  no docs/evals/*.md yet — press e to run', C.dim))
  }
  if (state.evalRunning || state.evalLog.length > 0) {
    out.push('')
    out.push(hr(`Eval ${state.evalRunning ? 'running…' : 'finished'}`))
    for (const l of state.evalLog.slice(-8)) out.push(`  ${trunc(l)}`)
  }
  out.push('')

  out.push(hr('Latest Journal'))
  const j = state.journal
  if (j) {
    out.push(`  run ${paint(j.runId ?? '?', C.cyan)}  ok=${j.ok ? ok('true') : bad('false')}  cost=$${(j.costUsd ?? 0).toFixed(4)}`)
    const errs = (j.errors ?? []).slice(-4)
    for (const e of errs) out.push(`  ${bad('err')} ${trunc(`${e.phase ?? ''} ${e.message ?? e}`, 80)}`)
  } else {
    out.push(paint('  no journal entries in .argus-reviewer-cache/', C.dim))
  }
  out.push('')

  process.stdout.write(`\x1b[2J\x1b[H${out.join('\n')}\n`)
}

function runEval() {
  if (state.evalRunning) return
  if (!process.env.OPENROUTER_API_KEY) {
    state.evalLog.push(warn('OPENROUTER_API_KEY not set — export it and retry'))
    render()
    return
  }
  state.evalRunning = true
  state.evalLog = []
  const child = spawn('node', ['evals/run.mjs'], { cwd: ROOT, env: process.env })
  child.stdout.on('data', (d) => {
    state.evalLog.push(...String(d).trim().split('\n'))
    render()
  })
  child.stderr.on('data', (d) => {
    state.evalLog.push(...String(d).trim().split('\n').map((l) => bad(l)))
    render()
  })
  child.on('close', async (code) => {
    state.evalRunning = false
    state.evalLog.push(code === 0 ? ok('eval finished') : bad(`eval exited ${code}`))
    await fetchData()
    render()
  })
}

async function main() {
  await fetchData()
  render()
  const timer = setInterval(async () => {
    await fetchData()
    render()
  }, REFRESH_MS)
  timer.unref()

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.on('data', async (key) => {
      const k = key.toString()
      if (k === 'q' || k === '\u0003') {
        process.stdout.write('\x1b[2J\x1b[H')
        process.exit(0)
      }
      if (k === 'r') {
        await fetchData()
        render()
      }
      if (k === 'e') runEval()
    })
  }
}

main().catch((e) => {
  console.error(`watch: ${e.message}`)
  process.exit(1)
})
