#!/usr/bin/env node
// R31 web evidence: screenshots at 1440 and 390 px in light and dark, an
// optional grayscale or deuteranopia filter, and a scripted keyboard pass.
//
//   node scripts/qa/capture-web.mjs --target dashboard --unit U13
//   node scripts/qa/capture-web.mjs --target assets/brand/templates/card.html --unit U9 --width 1440
//
// `--target dashboard` serves the desk front end (electron/ui/) with the
// stubbed preload bridge and captures every state in DASHBOARD_STATES. Any other target is a URL or a local
// HTML file. Output goes to argus-reviewer-report/qa/<unit>/ (gitignored;
// attach to the PR). Refuses to run while OPENROUTER_API_KEY is set (R32).
// Requires `npx playwright install chromium`.
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const DEFAULT_WIDTHS = [1440, 390]
export const THEMES = ['light', 'dark']
export const FILTERS = ['grayscale', 'deuteranopia']

const USAGE = `usage: capture-web.mjs --target <dashboard|url|file.html> [--unit <name>]
  [--width <px>] [--theme light|dark] [--filter grayscale|deuteranopia]`

/**
 * Refuse while an OpenRouter key is in the environment (R32). The harness
 * makes no model calls itself; the guard keeps any page or command it
 * drives from spending either. Returns the refusal text, or '' when clear.
 */
export function keyRefusal(env = process.env) {
  if (env.OPENROUTER_API_KEY === undefined) return ''
  return [
    'Refusing to run: OPENROUTER_API_KEY is set.',
    'QA captures must never spend model credit (plan R32), and anything the harness drives could read the key.',
    'Unset it for this command and run again, for example:',
    '  env -u OPENROUTER_API_KEY node scripts/qa/capture-web.mjs --target dashboard',
  ].join('\n')
}

function takeValue(argv, i, flag) {
  const v = argv[i + 1]
  if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value\n${USAGE}`)
  return v
}

/** Parse capture-web arguments. Throws with usage text on bad input. */
export function parseWebArgs(argv) {
  const opts = { target: '', unit: 'adhoc', widths: DEFAULT_WIDTHS, themes: THEMES, filter: undefined }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    switch (flag) {
      case '--target': opts.target = takeValue(argv, i++, flag); break
      case '--unit': opts.unit = takeValue(argv, i++, flag); break
      case '--width': {
        const raw = takeValue(argv, i++, flag)
        const n = Number(raw)
        if (!Number.isInteger(n) || n <= 0) throw new Error(`--width must be a positive integer, got "${raw}"`)
        opts.widths = [n]
        break
      }
      case '--theme': {
        const t = takeValue(argv, i++, flag)
        if (!THEMES.includes(t)) throw new Error(`--theme must be light or dark, got "${t}"`)
        opts.themes = [t]
        break
      }
      case '--filter': {
        const f = takeValue(argv, i++, flag)
        if (!FILTERS.includes(f)) throw new Error(`--filter must be grayscale or deuteranopia, got "${f}"`)
        opts.filter = f
        break
      }
      default: throw new Error(`unknown argument "${flag}"\n${USAGE}`)
    }
  }
  if (!opts.target) throw new Error(`--target is required\n${USAGE}`)
  opts.outDir = join('argus-reviewer-report', 'qa', opts.unit)
  return opts
}

/** Every width x theme combination the run captures, widest first. */
export function captureMatrix(opts) {
  return opts.widths.flatMap((width) => opts.themes.map((theme) => ({ width, theme })))
}

// Machado, Oliveira and Fernandes (2009) deuteranopia, severity 1.0.
const DEUTERANOPIA = [
  '0.367322 0.860646 -0.227968 0 0',
  '0.280085 0.672501 0.047413 0 0',
  '-0.011820 0.042940 0.968881 0 0',
  '0 0 0 1 0',
].join(' ')

/** CSS injected after load so the whole page renders through the filter. */
export function filterCss(filter) {
  if (filter === 'grayscale') return 'html { filter: grayscale(1) !important; }'
  if (filter === 'deuteranopia') {
    const svg = `<svg xmlns='http://www.w3.org/2000/svg'><filter id='d' color-interpolation-filters='linearRGB'><feColorMatrix type='matrix' values='${DEUTERANOPIA}'/></filter></svg>`
    return `html { filter: url("data:image/svg+xml,${encodeURIComponent(svg)}#d") !important; }`
  }
  return ''
}

const viewportHeight = (width) => (width >= 1000 ? 900 : 844)

function resolveTarget(target) {
  if (/^https?:\/\//.test(target) || target.startsWith('file:')) return target
  const file = resolve(target)
  if (!existsSync(file)) throw new Error(`--target "${target}" is not a URL, "dashboard", or an existing file`)
  return pathToFileURL(file).href
}

/**
 * Tab through the page from the top and record each stop: what it is, and
 * whether a focus indicator is visible on it. Stops when focus cycles back
 * to a seen element, leaves the document, or after `max` presses.
 */
async function keyboardPass(page, max = 60) {
  await page.evaluate(() => {
    document.activeElement?.blur?.()
    globalThis.focus()
  })
  const stops = []
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab')
    const stop = await page.evaluate(() => {
      const e = document.activeElement
      if (!e || e === document.body || e === document.documentElement) return null
      if (e.dataset.qaStop) return { seen: true }
      e.dataset.qaStop = '1'
      const cs = getComputedStyle(e)
      const outline = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0
      const ring = cs.boxShadow !== 'none'
      const id = e.id ? `#${e.id}` : ''
      const cls = typeof e.className === 'string' && e.className ? `.${e.className.trim().split(/\s+/).join('.')}` : ''
      const label = (e.getAttribute('aria-label') || e.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 48)
      return { desc: `${e.tagName.toLowerCase()}${id}${cls}`, label, visible: outline || ring }
    })
    if (!stop || stop.seen) break
    stops.push(stop)
  }
  const hidden = stops.filter((s) => !s.visible)
  const lines = [
    `${stops.length > 0 ? 'PASS' : 'FAIL'} Tab reaches ${stops.length} focus stop(s)`,
    `${hidden.length === 0 && stops.length > 0 ? 'PASS' : 'FAIL'} focus indicator visible on ${stops.length - hidden.length}/${stops.length} stop(s)`,
    ...hidden.map((s) => `  no indicator: ${s.desc} "${s.label}"`),
    'Tab order:',
    ...stops.map((s, i) => `  ${String(i + 1).padStart(2)}. ${s.visible ? '   ' : '!! '}${s.desc} "${s.label}"`),
  ]
  return { ok: stops.length > 0 && hidden.length === 0, lines }
}

export async function captureWeb(opts, log = console.log) {
  const { chromium } = await import('playwright')
  const fixture = await import('./dashboard-fixture.mjs')
  const outDir = resolve(opts.outDir)
  await mkdir(outDir, { recursive: true })

  const isDashboard = opts.target === 'dashboard'
  const server = isDashboard ? await fixture.serveElectron() : undefined
  const url = isDashboard ? server.url : resolveTarget(opts.target)
  const states = isDashboard ? Object.keys(fixture.DASHBOARD_STATES) : ['page']
  const css = filterCss(opts.filter)
  const suffix = opts.filter ? `-${opts.filter}` : ''
  const report = [`keyboard report: ${opts.target}`, '']
  let ok = true

  const browser = await chromium.launch()
  try {
    const open = async (state, width, theme) => {
      const context = await browser.newContext({
        viewport: { width, height: viewportHeight(width) },
        colorScheme: theme,
        reducedMotion: 'reduce',
        deviceScaleFactor: 1,
      })
      const page = await context.newPage()
      const spec = isDashboard ? fixture.DASHBOARD_STATES[state] : undefined
      if (spec) await fixture.installBridgeStub(page, spec.data)
      await page.goto(url, { waitUntil: 'load' })
      if (spec) {
        await page.waitForFunction(() => document.documentElement.dataset.desk === 'ready')
        await page.evaluate(() => document.fonts.ready)
        if (spec.view) await page.click(`.tab[data-view="${spec.view}"]`)
        if (spec.setup) await spec.setup(page, { width, theme })
      }
      return { context, page }
    }

    for (const state of states) {
      for (const { width, theme } of captureMatrix(opts)) {
        const { context, page } = await open(state, width, theme)
        if (css) await page.addStyleTag({ content: css })
        const name = `${state}-${width}-${theme}${suffix}.png`
        await page.screenshot({ path: join(outDir, name), fullPage: true })
        log(`wrote ${join(opts.outDir, name)}`)
        await context.close()
      }
      const { width, theme } = captureMatrix(opts)[0]
      const { context, page } = await open(state, width, theme)
      const kb = await keyboardPass(page)
      ok &&= kb.ok
      report.push(`[${state} @ ${width}px ${theme}]`, ...kb.lines, '')
      await context.close()
    }
  } finally {
    await browser.close()
    await server?.close()
  }

  // Named for the combination the pass ran at, so a later --width or
  // --filter run does not overwrite the default report.
  const { width, theme } = captureMatrix(opts)[0]
  const reportPath = join(opts.outDir, `keyboard-${width}-${theme}.txt`)
  await writeFile(resolve(reportPath), report.join('\n'))
  log(`wrote ${reportPath}`)
  log(ok ? 'keyboard pass: all checks passed' : `keyboard pass: FAIL (see ${reportPath})`)
  return ok
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const refusal = keyRefusal()
  if (refusal) {
    console.error(refusal)
    process.exit(3)
  }
  let opts
  try {
    opts = parseWebArgs(process.argv.slice(2))
  } catch (e) {
    console.error(e.message)
    process.exit(2)
  }
  try {
    process.exit((await captureWeb(opts)) ? 0 : 1)
  } catch (e) {
    console.error(`capture failed: ${e.message}`)
    process.exit(2)
  }
}
