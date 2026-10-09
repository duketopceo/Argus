#!/usr/bin/env node
// Desk smoke (U5/R17, U13/R18-R21): serve the desk front end (electron/ui/)
// over HTTP with the same path map as the Electron app scheme, stub the
// preload bridge with seeded workspaces (shared with the QA harness in
// scripts/qa/dashboard-fixture.mjs), and assert the Runs view, panel states,
// keyboard model, inspector sheet and spend confirm. Nothing spawns or
// spends: the stub's runEval only records its call. Run directly:
//   node tests/e2e/dashboard-smoke.mjs
// Requires `npx playwright install chromium`.
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright'

import {
  emptyState,
  installBridgeStub,
  partialState,
  seededPlan,
  seededState,
  serveElectron,
} from '../../scripts/qa/dashboard-fixture.mjs'

const SHOT_DIR = new URL('../../argus-reviewer-report/', import.meta.url).pathname

const checks = []
const check = (name, cond, detail = '') => {
  checks.push({ name, ok: !!cond, detail })
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`)
}

let browser
let server

async function openDesk(spec, { width = 1440, reducedMotion = 'no-preference' } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await installBridgeStub(page, spec, seededPlan)
  await page.goto(server.url)
  await page.waitForFunction(() => document.documentElement.dataset.desk === 'ready')
  return { context, page, errors }
}

const selectedIndex = (page, list) =>
  page.locator(`${list} [role="option"]`).evaluateAll((rows) => rows.findIndex((r) => r.getAttribute('aria-selected') === 'true'))
const activeId = (page) =>
  page.evaluate(() => document.activeElement?.id || document.activeElement?.dataset?.key || document.activeElement?.tagName)

try {
  server = await serveElectron()
  browser = await chromium.launch()

  // ---- Runs view: run list, lane matrix, inspector ------------------------
  const { context, page, errors } = await openDesk(seededState)
  const runRows = await page.locator('#veruns .runrow').allTextContents()
  check('run list renders current + archive', runRows.length === 6, `${runRows.length} rows`)
  check('run statuses are text', runRows.some((t) => t.includes('failed')) && runRows.some((t) => t.includes('passed')))

  const laneRows = await page.locator('#velanes .lanerow').allTextContents()
  check('lane matrix renders four lanes', laneRows.length === 4, JSON.stringify(laneRows))
  check('lane statuses are text, not color', ['passed', 'failed', 'passed', 'inconclusive'].every((s, i) => laneRows[i]?.includes(s)))
  check('unmetered a0 usage surfaces', laneRows[3]?.includes('unmetered'))

  const statusCells = await page.locator('.status').evaluateAll((tags) =>
    tags.map((t) => ({ glyph: t.querySelector('svg') !== null, word: t.querySelector('.word')?.textContent?.trim() ?? '' })),
  )
  check('every status cell is glyph plus word', statusCells.length > 0 && statusCells.every((s) => s.glyph && s.word), `${statusCells.length} cells`)

  const inspector = await page.locator('#vedetail').textContent()
  for (const key of ['lane', 'status', 'usage', 'elapsed', 'budget', 'evidence']) {
    check(`inspector shows ${key}`, inspector.includes(key))
  }
  check('inspector shows head binding', inspector.includes('match: checkout matches'))
  check('no image frame without screenshots', (await page.locator('#vedetail .shots').count()) === 0)

  const note = await page.locator('#runs-note').textContent()
  check('corrupt-file note is visible', note.includes('unreadable'), note.trim())
  check('no page errors', errors.length === 0, errors.join('; '))

  // Listbox arrows (kept from U5).
  await page.locator('#veruns .runrow').first().focus()
  await page.keyboard.press('ArrowDown')
  check('ArrowDown moves run selection', (await selectedIndex(page, '#veruns')) === 1)
  await page.keyboard.press('ArrowUp')
  await page.locator('#velanes .lanerow').first().focus()
  await page.keyboard.press('ArrowDown')
  check('ArrowDown moves lane selection', (await selectedIndex(page, '#velanes')) === 1)
  check('inspector follows selection', (await page.locator('#vedetail').textContent()).includes('flow'))
  const outline = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle)
  check('focus outline is visible', outline !== 'none' && outline !== '', `outline=${outline}`)
  check('flow screenshot shows the before/after pair', (await page.locator('#vedetail .shots img').count()) === 2)
  const lazy = await page
    .locator('#vedetail .shots img')
    .evaluateAll((imgs) => imgs.every((i) => i.loading === 'lazy' && i.width > 0 && i.height > 0))
  check('thumbnails are lazy with a fixed box', lazy)

  // Desk keys: j/k runs, [/] lanes, / filter, ? help, Esc closes.
  await page.locator('#veruns .runrow').first().focus()
  await page.keyboard.press('j')
  check('j moves run selection', (await selectedIndex(page, '#veruns')) === 1)
  await page.keyboard.press('k')
  check('k moves run selection back', (await selectedIndex(page, '#veruns')) === 0)
  await page.keyboard.press(']')
  check('] moves lane selection', (await selectedIndex(page, '#velanes')) === 1)
  await page.keyboard.press('[')
  check('[ moves lane selection back', (await selectedIndex(page, '#velanes')) === 0)
  await page.keyboard.press('/')
  check('/ focuses the filter', (await activeId(page)) === 'filter')
  await page.keyboard.type('blocked')
  check('filter narrows the run list', (await page.locator('#veruns .runrow').count()) === 1)
  await page.keyboard.press('Escape')
  check('Esc clears the filter', (await page.locator('#veruns .runrow').count()) === 6)
  await page.keyboard.press('Escape')
  await page.keyboard.press('?')
  check('? opens the key sheet', await page.locator('#help').evaluate((d) => d.open))
  const help = await page.locator('#helpkeys').textContent()
  check(
    'key sheet lists the keys',
    ['j', 'k', '[', ']', '/', '?', 'Enter', 'Esc'].every((k) => help.includes(k)) && help.includes('Filter runs'),
  )
  await page.keyboard.press('Escape')
  check('Esc closes the key sheet', !(await page.locator('#help').evaluate((d) => d.open)))

  // A poll with identical data must leave the DOM and focus alone.
  await page.locator('#veruns .runrow').nth(2).click()
  await page.evaluate(() => {
    window.__row = document.querySelector('#veruns [aria-selected="true"]')
    window.__lane = document.querySelector('#velanes [role="option"]')
  })
  const before = await activeId(page)
  const callsBefore = await page.evaluate(() => window.__collectCalls)
  await page.keyboard.press('r')
  await page.waitForFunction((n) => window.__collectCalls > n, callsBefore)
  await page.waitForTimeout(50)
  const same = await page.evaluate(
    () =>
      document.querySelector('#veruns [aria-selected="true"]') === window.__row &&
      document.querySelector('#velanes [role="option"]') === window.__lane,
  )
  check('identical poll leaves the DOM untouched', same)
  check('focus survives the poll', (await activeId(page)) === before && String(before).startsWith('run:'), before)

  await mkdir(SHOT_DIR, { recursive: true })
  await page.screenshot({ path: join(SHOT_DIR, 'dashboard-smoke.png'), fullPage: true })
  console.log('screenshot: argus-reviewer-report/dashboard-smoke.png')

  // ---- Spend confirm (F6, PR #111): run eval never spends directly ---------
  const dlg = page.locator('#evalconfirm')
  const evalCalls = () => page.evaluate(() => window.__evalCalls.length)
  await page.click('#eval')
  await page.waitForSelector('#evalconfirm[open]')
  await page.waitForFunction(() => !document.getElementById('ecrun').disabled)
  const body = await page.locator('#ecbody').textContent()
  check('confirm shows estimate and cap', body.includes('Estimated cost') && body.includes('Budget cap'))
  check('confirm names the models', body.includes('moonshotai/kimi-k2.5'))
  check('Run button states the cap', (await page.locator('#ecrun').textContent()).includes('$4.00'))
  check('Cancel has initial focus', (await activeId(page)) === 'eccancel')
  check('opening the confirm does not run the eval', (await evalCalls()) === 0)
  await page.screenshot({ path: join(SHOT_DIR, 'dashboard-eval-confirm.png') })

  await page.keyboard.press('Escape')
  check('Esc closes the confirm', !(await dlg.evaluate((d) => d.open)))
  check('Esc does not run the eval', (await evalCalls()) === 0)
  check('cancel is reported', (await page.locator('#evallog').textContent()).includes('nothing was run'))

  await page.click('#eval')
  await page.waitForSelector('#evalconfirm[open]')
  await page.keyboard.press('Enter') // focus is on Cancel
  check('Enter on default focus cancels', (await evalCalls()) === 0 && !(await dlg.evaluate((d) => d.open)))

  await page.evaluate(() => {
    window.__planFails = true
  })
  await page.click('#eval')
  await page.waitForFunction(() => document.getElementById('ecbody').textContent.includes('Could not'))
  check('plan failure is a readable message', (await page.locator('#ecbody').textContent()).includes('was not started'))
  check('plan failure keeps Run disabled', await page.locator('#ecrun').isDisabled())
  await page.click('#eccancel')
  check('plan failure can still be cancelled', !(await dlg.evaluate((d) => d.open)) && (await evalCalls()) === 0)
  await page.evaluate(() => {
    window.__planFails = false
  })

  await page.click('#eval')
  await page.waitForFunction(() => !document.getElementById('ecrun').disabled)
  await page.click('#ecrun')
  const calls = await page.evaluate(() => window.__evalCalls)
  check('Run starts the eval once, explicitly confirmed', calls.length === 1 && calls[0]?.confirmed === true, JSON.stringify(calls))

  // Eval failure shows inline with exit code, last stderr line and Retry.
  await page.click('.tab[data-view="repo"]')
  check('eval running sets aria-busy on its panel', (await page.locator('#panel-evals').getAttribute('aria-busy')) === 'true')
  await page.evaluate(() => {
    window.__evalLog({ stream: 'err', line: 'Error: budget cap reached' })
    window.__evalLog({ stream: 'done', line: 'eval exited 1' })
  })
  const evalStatus = await page.locator('#evalstatus').textContent()
  check(
    'eval failure names the exit code and last stderr line',
    evalStatus.includes('code 1') && evalStatus.includes('budget cap reached'),
    evalStatus,
  )
  await page.locator('#evalstatus button').click()
  await page.waitForSelector('#evalconfirm[open]')
  check('eval Retry reopens the confirm, not the eval', (await evalCalls()) === 1)
  await page.keyboard.press('Escape')
  check('evals render as tables', (await page.locator('#evals table th').count()) >= 4)
  check(
    'running workflow is busy with a running status',
    (await page.locator('#workflows li[aria-busy="true"] .status[data-status="running"]').count()) === 1,
  )

  // ---- Heals + Spend views (per-view coverage) ---------------------------
  await page.click('.tab[data-view="heals"]')
  const healHeads = await page.locator('#heals table th').allTextContents()
  check(
    'heals table columns are labeled',
    ['Test', 'Step', 'Action', 'Model', 'Run', 'Age'].every((h) => healHeads.includes(h)),
    JSON.stringify(healHeads),
  )
  const healRows = await page.locator('#heals table tbody tr').allTextContents()
  check('heals list renders seeded entries', healRows.length === 2, `${healRows.length} rows`)
  check(
    'heal rows carry test, step, action and model',
    healRows[0]?.includes('landing loads') && healRows[0]?.includes('Sign in') && healRows[0]?.includes('gemini-2.5-flash-lite'),
    healRows[0],
  )

  await page.click('.tab[data-view="spend"]')
  const figure = await page.locator('#spend .figure').textContent()
  check('spend shows a total figure', figure.includes('$'), figure)
  const parts = await page.locator('#spend .ledger-part h3').allTextContents()
  check('spend ledger splits model, lane and day', parts.join(',') === 'By model,By lane,By day', JSON.stringify(parts))
  const laneCells = await page.locator('#spend .ledger-part').nth(1).locator('tbody tr').allTextContents()
  check('by-lane ledger has all four lanes', laneCells.length === 4, `${laneCells.length} rows`)
  const modelCells = await page.locator('#spend .ledger-part').first().locator('tbody tr').allTextContents()
  check('by-model ledger surfaces unmetered usage', modelCells.some((r) => r.includes('unmetered')), JSON.stringify(modelCells))
  const tally = await page.locator('#spend .tally').textContent()
  check('spend tally states latest run vs budget', tally.includes('latest run spent') && tally.includes('of $1.00'), tally.trim())
  const tallyTicks = await page.locator('#spend .tally .ticks i').count()
  check('tally meter renders its 20-tick strip', tallyTicks === 20, `${tallyTicks}/20`)

  await context.close()

  // ---- Panel states --------------------------------------------------------
  {
    const { context, page } = await openDesk(partialState)
    await page.click('.tab[data-view="repo"]')
    const prs = await page.locator('#prs').textContent()
    check(
      'gh missing is its own state, not an empty list',
      prs.includes('GitHub CLI not found') && !prs.includes('No open PRs') && prs.includes('gh auth login'),
    )
    await page.click('.tab[data-view="runs"]')
    check(
      'corrupt newest manifest keeps the last valid run selected',
      (await page.locator('#veruns [aria-selected="true"]').textContent()).includes('smoke-run-0'),
    )
    await context.close()
  }
  {
    const { context, page } = await openDesk({ state: emptyState })
    const text = await page.locator('#runs-note').textContent()
    check(
      'empty runs: art, sentence and command',
      text.includes('No verify runs yet') && text.includes('argus-reviewer verify') && (await page.locator('#runs-note img').count()) === 1,
    )
    await context.close()
  }
  {
    const { context, page } = await openDesk({ state: emptyState })
    await page.click('.tab[data-view="heals"]')
    check(
      'empty heals: art and sentence',
      (await page.locator('#heals').textContent()).includes('No heals waiting') &&
        (await page.locator('#heals img').count()) === 1,
    )
    await page.click('.tab[data-view="spend"]')
    const spendEmpty = await page.locator('#spend').textContent()
    check(
      'empty spend: sentence plus configured budget line',
      spendEmpty.includes('No spend recorded yet') && spendEmpty.includes('Run budget') && spendEmpty.includes('argus-reviewer.config.ts'),
      spendEmpty.trim().slice(0, 120),
    )
    await context.close()
  }
  {
    const { context, page } = await openDesk({ state: partialState })
    await page.click('.tab[data-view="heals"]')
    const partial = await page.locator('#heals').textContent()
    check(
      'partial heals: banner names the unreadable journal, rows still render',
      partial.includes('unreadable') && (await page.locator('#heals table tbody tr').count()) === 2,
      partial.trim().slice(0, 120),
    )
    await context.close()
  }
  {
    const { context, page } = await openDesk({ state: { ...emptyState, keyPresent: false } })
    check('no key: the no-key state, not an empty list', (await page.locator('#runs-note').textContent()).includes('OPENROUTER_API_KEY'))
    await context.close()
  }
  {
    const { context, page } = await openDesk({ reject: 'collect failed: EACCES' })
    const t = await page.locator('#runs-note').textContent()
    check(
      'bridge rejection is an inline error with Retry',
      t.includes('Could not read') && t.includes('EACCES') && (await page.locator('#runs-note button').count()) === 1,
    )
    await context.close()
  }
  {
    const { context, page } = await openDesk({ state: seededState, reject: 'gh timed out', failAfter: 1 })
    await page.keyboard.press('r')
    await page.waitForSelector('#banner:not([hidden])')
    const b = await page.locator('#banner').textContent()
    check('failed refresh shows last-good time with Retry', b.includes('Refresh failed') && b.includes('Showing data from') && b.includes('Retry'))
    check('stale keeps the last-good runs', (await page.locator('#veruns .runrow').count()) === 6)
    await page.evaluate(() => {
      window.__collectFails = null
    })
    await page.locator('#banner button').click()
    await page.waitForSelector('#banner', { state: 'hidden' })
    check('Retry that succeeds clears the stale banner', true)
    await context.close()
  }

  // ---- Inspector sheet at 1000 px -----------------------------------------
  {
    const { context, page } = await openDesk(seededState, { width: 1000 })
    await page.locator('#velanes .lanerow').nth(1).focus()
    await page.keyboard.press('Enter')
    const inSheet = () => page.evaluate(() => document.getElementById('inspector').contains(document.activeElement))
    check('Enter opens the inspector sheet with focus on its heading', (await activeId(page)) === 'insp-h')
    let trapped = true
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('Tab')
      trapped &&= await inSheet()
    }
    check('Tab stays inside the sheet', trapped)
    await page.keyboard.press('Escape')
    check('Esc closes the sheet', !(await page.locator('#inspector').evaluate((n) => n.classList.contains('open'))))
    check('focus returns to the lane row', (await activeId(page)) === 'lane:smoke-run-1:flow')
    await context.close()
  }

  // ---- Running is its own shape under reduced motion (grayscale) ----------
  {
    const { context, page } = await openDesk(seededState, { reducedMotion: 'reduce' })
    await page.click('.tab[data-view="repo"]')
    await page.addStyleTag({ content: 'html { filter: grayscale(1) } .status .glyph { color: #000 !important }' })
    const run = page.locator('#workflows .status[data-status="running"] svg').first()
    const vis = await run.evaluate((s) => ({
      pupil: getComputedStyle(s.querySelector('.argus-scan__pupil')).display,
      lid: getComputedStyle(s.querySelector('.argus-scan__lid')).display,
    }))
    check('reduced motion: running holds a still pupil, no half-lid', vis.pupil !== 'none' && vis.lid === 'none', JSON.stringify(vis))
    const runShot = await run.screenshot()
    await page.click('.tab[data-view="runs"]')
    const incShot = await page.locator('#veruns .status[data-status="inconclusive"] svg').first().screenshot()
    check('running and inconclusive differ in grayscale', !incShot.equals(runShot))
    await context.close()
  }
} catch (e) {
  check('smoke completed without error', false, e.message)
} finally {
  await browser?.close()
  await server?.close()
}

const failed = checks.filter((c) => !c.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
