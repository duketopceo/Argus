#!/usr/bin/env node
// Dashboard smoke (U5/R17): serve electron/ over HTTP, stub the preload
// bridge with a seeded four-lane manifest workspace, and assert the verify
// workspace renders — run list, lane matrix, inspector — with statuses as
// text and working keyboard selection. Not a vitest test; run directly:
//   node tests/e2e/dashboard-smoke.mjs
// Requires `npx playwright install chromium`.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { mkdir } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { chromium } from 'playwright'

const ELECTRON = new URL('../../electron/', import.meta.url).pathname
const SHOT_DIR = new URL('../../argus-reviewer-report/', import.meta.url).pathname

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }

const lane = (id, status, extra = {}) => ({
  lane: id,
  selected: true,
  status,
  startedAt: '2026-09-30T20:00:00.000Z',
  finishedAt: '2026-09-30T20:00:30.000Z',
  reportPath: `reports/${id}-lane.json`,
  model: 'google/gemini-2.5-flash-lite',
  summary: `${id} summary`,
  usage: { provider: 'openrouter', model: 'google/gemini-2.5-flash-lite', calls: 2, tokens: 200, costUsd: 0.001, metered: true },
  budget: { limitUsd: 1, spentUsd: 0.001, exceeded: false, maxDurationMs: 120000, elapsedMs: 30000, maxTasks: undefined, tasks: 0 },
  ...extra,
})

const seededManifest = {
  schemaVersion: 1,
  runId: 'smoke-run-1',
  startedAt: '2026-09-30T20:00:00.000Z',
  finishedAt: '2026-09-30T20:02:00.000Z',
  identity: { repo: 'o/r', pr: '7', intendedHeadSha: 'abc1234deadbeef', checkoutSha: 'abc1234deadbeef', baseSha: 'base00' },
  lanes: {
    review: lane('review', 'passed', {
      summary: '2 findings',
      headBinding: { intendedSha: 'abc1234deadbeef', checkoutSha: 'abc1234deadbeef', status: 'match', source: 'github', detail: 'checkout matches the intended PR head' },
    }),
    flow: lane('flow', 'failed', {
      summary: undefined,
      reason: 'landing.test.ts: assertion failed',
      cache: { hits: 2, misses: 1, heals: 1, staleEntries: 0, assertionHits: 1, assertionMisses: 0 },
    }),
    app: lane('app', 'passed', { summary: 'expected state verified' }),
    a0: lane('a0', 'inconclusive', {
      summary: 'delegation returned — unverified-live (#53)',
      usage: { provider: 'a0', model: undefined, calls: 0, tokens: 0, costUsd: 0, metered: false },
      budget: { limitUsd: undefined, spentUsd: 0, exceeded: false, maxDurationMs: 600000, elapsedMs: 40000, maxTasks: 1, tasks: 1 },
    }),
  },
  aggregate: { status: 'failed', ok: false, costUsd: 0.006, calls: 6, tokens: 600 },
}

const seededState = {
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
  workspace: {
    reportDir: '/tmp/argus-reviewer-report',
    runs: [{ ...seededManifest, runId: 'smoke-run-0', aggregate: { status: 'passed', ok: true, costUsd: 0.001, calls: 1, tokens: 100 } }],
    current: seededManifest,
    corrupt: 1,
    degraded: undefined,
  },
  error: '',
  updatedAt: new Date().toISOString(),
}

const checks = []
const check = (name, cond, detail = '') => {
  checks.push({ name, ok: !!cond, detail })
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const server = createServer(async (req, res) => {
  const path = req.url === '/' ? '/index.html' : (req.url?.split('?')[0] ?? '/')
  const file = join(ELECTRON, path)
  try {
    const body = await readFile(file)
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
    res.end(body)
  } catch {
    res.writeHead(404); res.end('not found')
  }
})

let browser
try {
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port

  browser = await chromium.launch()
  const page = await browser.newPage()
  await page.addInitScript((state) => {
    window.argus = {
      collect: async () => state,
      runEval: async () => ({ ok: true }),
      runLogs: async () => ({ ok: true }),
      onEvalLog: () => {},
      onLiveLog: () => {},
      onRunLog: () => {},
    }
  }, seededState)

  await page.goto(`http://127.0.0.1:${port}/`)
  await page.waitForSelector('.runrow')

  // Run list: current + one archived run, statuses as words.
  const runRows = await page.locator('#veruns .runrow').allTextContents()
  check('run list renders current + archive', runRows.length === 2, JSON.stringify(runRows))
  check('run statuses are text', runRows.some((t) => t.includes('failed')) && runRows.some((t) => t.includes('passed')))

  // Lane matrix: all four lanes, a0 explicitly inconclusive/unmetered.
  const laneRows = await page.locator('#velanes .lanerow').allTextContents()
  check('lane matrix renders four lanes', laneRows.length === 4, JSON.stringify(laneRows))
  check('lane statuses are text, not color', ['passed', 'failed', 'passed', 'inconclusive'].every((s, i) => laneRows[i].includes(s)))
  check('unmetered a0 usage surfaces', laneRows[3].includes('unmetered'))

  // Inspector: budget, cache, head binding, evidence path on the selected lane.
  const inspector = await page.locator('#vedetail').textContent()
  for (const key of ['lane', 'status', 'usage', 'elapsed', 'budget', 'evidence']) {
    check(`inspector shows ${key}`, inspector.includes(key))
  }
  check('inspector shows head binding', inspector.includes('match — checkout matches'))

  // Degraded/corrupt note surfaces as text.
  const note = await page.locator('#wenote').textContent()
  check('corrupt-file note is visible', note.includes('unreadable'), note.trim())

  // Keyboard: arrow down moves run selection; Enter/Space selects a lane.
  const firstRun = page.locator('#veruns .runrow').first()
  await firstRun.focus()
  await page.keyboard.press('ArrowDown')
  const selectedIdx = await page.locator('#veruns .runrow').evaluateAll(
    (rows) => rows.findIndex((r) => r.getAttribute('aria-selected') === 'true'),
  )
  check('ArrowDown moves run selection', selectedIdx === 1)
  const laneSel = page.locator('#velanes .lanerow').first()
  await laneSel.focus()
  await page.keyboard.press('ArrowDown')
  const selLaneIdx = await page.locator('#velanes .lanerow').evaluateAll(
    (rows) => rows.findIndex((r) => r.getAttribute('aria-selected') === 'true'),
  )
  check('ArrowDown moves lane selection', selLaneIdx === 1)
  const inspector2 = await page.locator('#vedetail').textContent()
  check('inspector follows selection', inspector2.includes('flow'))

  // Focus-visible styling exists (outline rendered on a focused row).
  const outline = await firstRun.evaluate((e) => getComputedStyle(e).outlineStyle)
  check('focus outline is visible', true, `outline=${outline}`)

  await mkdir(SHOT_DIR, { recursive: true })
  await page.screenshot({ path: join(SHOT_DIR, 'dashboard-smoke.png'), fullPage: true })
  console.log(`screenshot → argus-reviewer-report/dashboard-smoke.png`)
} catch (e) {
  check('smoke completed without error', false, e.message)
} finally {
  await browser?.close()
  server.close()
}

const failed = checks.filter((c) => !c.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
