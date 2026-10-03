#!/usr/bin/env node
// Dashboard smoke (U5/R17): serve electron/ over HTTP, stub the preload
// bridge with a seeded four-lane manifest workspace (shared with the QA
// harness in scripts/qa/dashboard-fixture.mjs), and assert the verify
// workspace renders — run list, lane matrix, inspector — with statuses as
// text and working keyboard selection. Not a vitest test; run directly:
//   node tests/e2e/dashboard-smoke.mjs
// Requires `npx playwright install chromium`.
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright'

import { installBridgeStub, seededPlan, seededState, serveElectron } from '../../scripts/qa/dashboard-fixture.mjs'

const SHOT_DIR = new URL('../../argus-reviewer-report/', import.meta.url).pathname

const checks = []
const check = (name, cond, detail = '') => {
  checks.push({ name, ok: !!cond, detail })
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

let browser
let server
try {
  server = await serveElectron()

  browser = await chromium.launch()
  const page = await browser.newPage()
  await installBridgeStub(page, seededState, seededPlan)

  await page.goto(server.url)
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
  await server?.close()
}

const failed = checks.filter((c) => !c.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
