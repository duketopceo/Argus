#!/usr/bin/env node
// argus watch: contributor-only local TUI (not shipped in the npm package).
// Verify run, code review, PRs and workflow runs, live log, evals. No deps;
// reads `gh` and local artifacts via scripts/collect.mjs. `npm run watch`.
//
// Keys: r refresh, e eval (opens a spend confirm; only y runs it), ? help,
// q quit. Refreshes every 30s and backs off while collect keeps failing.
// When stdout is not a TTY it prints one snapshot and exits.
//
// Frames come from scripts/tui/render.mjs (pure) and reach the terminal
// through scripts/tui/screen.mjs (alternate screen, per-line diff redraw).

import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { colorEnabled, createStyler } from '../dist/ui/style.js'
import { collect, ROOT, safe } from './collect.mjs'
import { evalPlan, evalSpendSince } from './eval-plan.mjs'
import { createLiveTailer } from './tail-live.mjs'
import { reduceKey } from './tui/keys.mjs'
import { renderFrame, renderSnapshot } from './tui/render.mjs'
import { createScreen } from './tui/screen.mjs'

const REFRESH_MS = 30_000
const MAX_BACKOFF_MS = 5 * 60_000
// Relative ages in the header and Live pane go stale between polls; a cheap
// tick keeps them true. The differ rewrites only rows whose text changed.
const AGE_TICK_MS = 10_000

const out = process.stdout
const style = createStyler(colorEnabled({ env: process.env, isTTY: Boolean(out.isTTY) }))

const model = {
  data: undefined,
  lastOkAt: undefined,
  // Set while collect keeps failing: the last good data stays on screen.
  failure: undefined,
  live: [],
  eval: { running: false, startedAt: undefined, log: [], exit: undefined, note: '', confirm: undefined },
  overlay: undefined,
}

let delay = REFRESH_MS

async function refresh() {
  try {
    model.data = await collect()
    model.lastOkAt = Date.now()
    model.failure = undefined
    delay = REFRESH_MS
  } catch (e) {
    // A failed poll is a bad tick, not a dead watcher: keep the last frame,
    // say how stale it is, and back off.
    delay = Math.min(delay * 2, MAX_BACKOFF_MS)
    model.failure = {
      error: `collect failed: ${safe(e instanceof Error ? e.message : String(e))}`,
      at: Date.now(),
      retryInMs: delay,
    }
  }
}

// --- non-TTY: one snapshot (R17) -------------------------------------------

if (!out.isTTY) {
  await refresh()
  model.live = model.data?.live ?? []
  // Piped stdout has no width; use the terminal's (via stderr) when there is one.
  const cols = out.columns ?? process.stderr.columns ?? (Number(process.env.COLUMNS) || 100)
  out.write(renderSnapshot(model, { cols, style, now: Date.now() }))
  process.exit(model.data === undefined ? 1 : 0)
}

// --- interactive -------------------------------------------------------------

const screen = createScreen(out)

function draw() {
  screen.draw(renderFrame(model, { cols: out.columns ?? 80, rows: out.rows ?? 24, style, now: Date.now() }))
}

let pollTimer
function schedulePoll() {
  clearTimeout(pollTimer)
  pollTimer = setTimeout(async () => {
    await refresh()
    draw()
    schedulePoll()
  }, delay)
}

let quitting = false
function quit(code = 0) {
  if (quitting) return
  quitting = true
  screen.leave()
  if (process.stdin.isTTY) process.stdin.setRawMode(false)
  process.exit(code)
}

function runEval() {
  if (model.eval.running) return
  if (!process.env.OPENROUTER_API_KEY) {
    model.eval.note = 'eval not started: OPENROUTER_API_KEY is not set. Export it, then press e.'
    draw()
    return
  }
  const startedAt = Date.now()
  model.eval = { ...model.eval, running: true, startedAt, log: [], exit: undefined, note: '' }
  let lastStderr = ''
  const lines = (d) => String(d).split(/\r?\n/).map((l) => safe(l).trimEnd()).filter(Boolean)
  const child = spawn('node', ['evals/run.mjs'], { cwd: ROOT, env: process.env })
  child.stdout.on('data', (d) => {
    model.eval.log.push(...lines(d))
    model.eval.log = model.eval.log.slice(-50)
    draw()
  })
  child.stderr.on('data', (d) => {
    const ls = lines(d)
    if (ls.length > 0) lastStderr = ls[ls.length - 1]
    model.eval.log.push(...ls)
    model.eval.log = model.eval.log.slice(-50)
    draw()
  })
  // 'error' with no listener throws: a spawn ENOENT (node missing from a
  // bare PATH) must not crash the TUI.
  child.on('error', (err) => {
    model.eval.running = false
    model.eval.exit = { code: null, signal: undefined, lastStderr: `spawn failed: ${safe(err.message)}`, spendUsd: 0 }
    draw()
  })
  child.on('close', async (code, signal) => {
    if (!model.eval.running) return
    model.eval.running = false
    model.eval.exit = { code, signal: signal ?? undefined, lastStderr, spendUsd: evalSpendSince(ROOT, startedAt) }
    await refresh()
    draw()
  })
}

async function onKey(key) {
  const { ui, effect } = reduceKey(model, key, { evalPlan: () => evalPlan(ROOT) })
  model.eval = ui.eval
  model.overlay = ui.overlay
  if (effect === 'quit') return quit(0)
  if (effect === 'run-eval') return runEval()
  if (effect === 'refresh') {
    await refresh()
    schedulePoll()
  }
  draw()
}

process.on('exit', () => screen.leave())
process.on('SIGTERM', () => quit(143))
process.on('SIGHUP', () => quit(129))
process.on('uncaughtException', (e) => {
  screen.leave()
  console.error(`watch: ${e instanceof Error ? e.stack : String(e)}`)
  process.exit(1)
})

screen.enter()
draw()
await refresh()
draw()
schedulePoll()
setInterval(draw, AGE_TICK_MS).unref()
out.on('resize', () => {
  screen.invalidate()
  draw()
})

// Stream live.ndjson between refreshes: argus commands (code-review, run,
// debug) append stage lines here while they work.
createLiveTailer(join(ROOT, '.argus-reviewer-cache/live.ndjson'), {
  onLine: (e) => {
    model.live.push({ ts: e.ts ?? Date.now(), source: safe(e.source), level: safe(e.level), msg: safe(e.msg) })
    if (model.live.length > 50) model.live = model.live.slice(-50)
    draw()
  },
}).start(2000)

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true)
  process.stdin.resume()
  process.stdin.on('data', (key) => {
    onKey(key.toString())
  })
}
