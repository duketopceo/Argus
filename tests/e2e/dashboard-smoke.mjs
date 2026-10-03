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
  identity: { repo: 'o/r', pr: '7', intendedHeadSha: 'abc1234deadbeef', checkoutSha: 'abc1234deadbeef', baseSha: 'base00', runNonce: 'smoke:1' },
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
      summary: 'delegation returned — self-reported',
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

// What main.mjs returns from 'eval-plan' (evalPlan + formatted lines).
const seededPlan = {
  keyPresent: true,
  capLabel: '$4.00',
  lines: [
    'Runs node evals/run.mjs: 3 test case(s) x 2 model(s), 2 runs each (cold, then cached).',
    '  google/gemini-2.5-flash-lite  (last run $0.0014)',
    '  moonshotai/kimi-k2.5  (last run $0.15)',
    'Estimated cost: about $0.15, based on the last recorded run.',
    'Budget cap: $1.00 per run, at most $4.00 in total. This spends real OpenRouter credit.',
  ],
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
  await page.addInitScript(({ state, plan }) => {
    // Spend-confirm gate: record every runEval call; never spawns anything.
    window.__evalCalls = []
    window.__planFails = false
    window.argus = {
      collect: async () => state,
      evalPlan: async () => {
        if (window.__planFails) throw new Error('plan read failed')
        return plan
      },
      runEval: async (opts) => {
        window.__evalCalls.push(opts ?? null)
        return { ok: true }
      },
      runLogs: async () => ({ ok: true }),
      onEvalLog: () => {},
      onLiveLog: () => {},
      onRunLog: () => {},
    }
  }, { state: seededState, plan: seededPlan })

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

  // Focus-visible styling exists — :focus-visible only matches keyboard
  // focus, so read the element the ArrowDown actually focused.
  const outline = await page.evaluate(
    () => getComputedStyle(document.activeElement).outlineStyle,
  )
  check('focus outline is visible', outline !== 'none' && outline !== '', `outline=${outline}`)

  await mkdir(SHOT_DIR, { recursive: true })
  await page.screenshot({ path: join(SHOT_DIR, 'dashboard-smoke.png'), fullPage: true })
  console.log(`screenshot → argus-reviewer-report/dashboard-smoke.png`)

  // Spend confirm (F6): "run eval" opens a dialog, never spends directly.
  const dlg = page.locator('#evalconfirm')
  const evalCalls = () => page.evaluate(() => window.__evalCalls.length)
  await page.click('#eval')
  await page.waitForSelector('#evalconfirm[open]')
  await page.waitForFunction(() => !document.getElementById('ecrun').disabled)
  const body = await page.locator('#ecbody').textContent()
  check('confirm shows estimate and cap', body.includes('Estimated cost') && body.includes('Budget cap'))
  check('confirm names the models', body.includes('moonshotai/kimi-k2.5'))
  check('Run button states the cap', (await page.locator('#ecrun').textContent()).includes('$4.00'))
  check('Cancel has initial focus', await page.evaluate(() => document.activeElement?.id === 'eccancel'))
  check('opening the confirm does not run the eval', (await evalCalls()) === 0)
  await page.screenshot({ path: join(SHOT_DIR, 'dashboard-eval-confirm.png') })
  console.log(`screenshot → argus-reviewer-report/dashboard-eval-confirm.png`)

  await page.keyboard.press('Escape')
  check('Esc closes the confirm', !(await dlg.evaluate((d) => d.open)))
  check('Esc does not run the eval', (await evalCalls()) === 0)
  check('cancel is reported', (await page.locator('#evallog').textContent()).includes('nothing was run'))

  await page.click('#eval')
  await page.waitForSelector('#evalconfirm[open]')
  await page.keyboard.press('Enter') // focus is on Cancel
  check('Enter on default focus cancels', (await evalCalls()) === 0 && !(await dlg.evaluate((d) => d.open)))

  await page.evaluate(() => { window.__planFails = true })
  await page.click('#eval')
  await page.waitForFunction(() => document.getElementById('ecbody').textContent.includes('Could not'))
  check('plan failure is a readable message', (await page.locator('#ecbody').textContent()).includes('was not started'))
  check('plan failure keeps Run disabled', await page.locator('#ecrun').isDisabled())
  await page.click('#eccancel')
  check('plan failure can still be cancelled', !(await dlg.evaluate((d) => d.open)) && (await evalCalls()) === 0)
  await page.evaluate(() => { window.__planFails = false })

  await page.click('#eval')
  await page.waitForFunction(() => !document.getElementById('ecrun').disabled)
  await page.click('#ecrun')
  const calls = await page.evaluate(() => window.__evalCalls)
  check('Run starts the eval once, explicitly confirmed', calls.length === 1 && calls[0]?.confirmed === true, JSON.stringify(calls))
} catch (e) {
  check('smoke completed without error', false, e.message)
} finally {
  await browser?.close()
  server.close()
}

const failed = checks.filter((c) => !c.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
