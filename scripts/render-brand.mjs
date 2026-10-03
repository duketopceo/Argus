#!/usr/bin/env node
// npm run render:brand: the README hero (light and dark) and the social card,
// rendered by Playwright from real Argus output (plan U16, KTD7, R26).
//
// The source is a fixture in fixtures/manifests/ and its comment golden in
// tests/goldens/comment/, which tests/unit/comment-golden.test.ts keeps equal
// to what the action renderer (action/sticky-comment.cjs) posts. This script
// only lays that markdown out; it never writes copy of its own into the
// comment. Templates live in assets/brand/templates/.
//
//   node scripts/render-brand.mjs            # writes docs/assets/{hero-light,hero-dark,social}.png
//   node scripts/render-brand.mjs --out dir  # writes the three PNGs to dir instead
//
// Makes no model calls and refuses to run while OPENROUTER_API_KEY is set (R32).
// Requires `npx playwright install chromium`.
/* global document */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

/** The fixture the hero and social card are rendered from (Q14 provenance: fixtures/manifests/README.md). */
export const SOURCE_FIXTURE = 'dogfood-demo-pr'
export const OUT_DIR = 'docs/assets'
export const TEMPLATES = 'assets/brand/templates'
/** CSS width of the hero; rendered at 2x. */
export const HERO_WIDTH = 760
export const HERO_SCALE = 2
export const SOCIAL = { width: 1280, height: 640 }

/** Refuse while an OpenRouter key is set (R32). Returns the refusal text, or ''. */
export function keyRefusal(env = process.env) {
  if (env.OPENROUTER_API_KEY === undefined) return ''
  return [
    'render-brand: refusing to run while OPENROUTER_API_KEY is set.',
    'Brand renders must never be able to spend model credit (plan R32). Run:',
    '  env -u OPENROUTER_API_KEY npm run render:brand',
  ].join('\n')
}

/**
 * Read a fixture and its committed comment golden. Throws, naming the file
 * and the command that makes it, when either is missing: a hero rendered
 * from nothing would be a mock-up.
 */
export function loadSource(name = SOURCE_FIXTURE, root = ROOT) {
  const fixturePath = join(root, 'fixtures', 'manifests', `${name}.json`)
  const goldenPath = join(root, 'tests', 'goldens', 'comment', `${name}.md`)
  if (!existsSync(fixturePath)) {
    throw new Error(`render-brand: fixture ${fixturePath} is missing`)
  }
  if (!existsSync(goldenPath)) {
    throw new Error(
      `render-brand: comment golden ${goldenPath} is missing.\n` +
        'Add the fixture to tests/unit/comment-golden.test.ts, then run:\n' +
        '  UPDATE_GOLDENS=1 npx vitest run tests/unit/comment-golden.test.ts',
    )
  }
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'))
  return { fixture, markdown: readFileSync(goldenPath, 'utf8') }
}

/**
 * Total metered spend of a fixture in USD: the manifest total when there is
 * one, else the code review plus the vision run. Same sources the comment's
 * header reads.
 */
export function fixtureSpendUsd(fixture) {
  const total = fixture.manifest?.totals?.costUsd
  if (typeof total === 'number') return total
  const review = fixture.codeReview?.visionCostUsd ?? 0
  const vision = fixture.report?.totals?.visionCostUsd ?? 0
  return review + vision
}

/** DESIGN.md §6.2: 6 decimals at or below $0.01, 4 above. */
export function formatUsd(usd) {
  return `$${usd.toFixed(usd > 0.01 ? 4 : 6)}`
}

// ---- Markdown: the subset the sticky comment emits -------------------------

const escapeHtml = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Inline markdown: code spans, bold, emphasis, links, and the <br>/<sub> tags the comment uses. */
export function inline(text) {
  const codes = []
  // Code spans first (CommonMark: a run of n backticks closes on the next run of n).
  let s = text.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, ticks, body) => {
    let code = body
    if (ticks.length > 1 && code.startsWith(' ') && code.endsWith(' ')) code = code.slice(1, -1)
    codes.push(`<code>${escapeHtml(code)}</code>`)
    return `\u0000${codes.length - 1}\u0000`
  })
  s = escapeHtml(s.replace(/\\\|/g, '|'))
  s = s.replace(/&lt;br&gt;/g, '<br>').replace(/&lt;(\/?)sub&gt;/g, '<$1sub>')
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, '$1<em>$2</em>')
  s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>')
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)])
}

function splitRow(line) {
  const cells = []
  let cur = ''
  for (let i = 1; i < line.length - 1; i++) {
    if (line[i] === '\\' && line[i + 1] === '|') {
      cur += '\\|'
      i++
    } else if (line[i] === '|') {
      cells.push(cur.trim())
      cur = ''
    } else cur += line[i]
  }
  cells.push(cur.trim())
  return cells
}

function table(rows) {
  const head = splitRow(rows[0])
  const align = splitRow(rows[1]).map((a) => (a.endsWith(':') ? (a.startsWith(':') ? 'center' : 'right') : ''))
  const cell = (tag, c, i) => `<${tag}${align[i] ? ` align="${align[i]}"` : ''}>${inline(c)}</${tag}>`
  const body = rows
    .slice(2)
    .map((r) => `<tr>${splitRow(r).map((c, i) => cell('td', c, i)).join('')}</tr>`)
    .join('')
  return `<table><thead><tr>${head.map((c, i) => cell('th', c, i)).join('')}</tr></thead><tbody>${body}</tbody></table>`
}

/**
 * GitHub-flavored markdown to HTML for the constructs the sticky comment
 * emits: the sentinel, ### headings, paragraphs, tables, lists, quoted
 * notices and <details> folds. Anything else (a code fence, a raw HTML
 * block) throws, so a renderer change cannot silently produce a wrong hero.
 */
export function commentToHtml(markdown) {
  const lines = markdown.replace(/\n+$/, '').split('\n')
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === '' || line === '<!-- argus-reviewer -->') continue
    if (line.startsWith('### ')) out.push(`<h3>${inline(line.slice(4))}</h3>`)
    else if (line === '<details>') out.push('<details>')
    else if (line === '</details>') out.push('</details>')
    else if (/^<summary>.*<\/summary>$/.test(line)) out.push(`<summary>${inline(line.slice(9, -10))}</summary>`)
    else if (line.startsWith('| ')) {
      const rows = []
      while (lines[i]?.startsWith('|')) rows.push(lines[i++])
      i--
      if (rows.length < 2 || !/^\|[-:|]+\|$/.test(rows[1])) throw new Error(`render-brand: malformed table at line ${i + 1}`)
      out.push(table(rows))
    } else if (line.startsWith('- ')) {
      const items = []
      while (lines[i]?.startsWith('- ')) items.push(`<li>${inline(lines[i++].slice(2))}</li>`)
      i--
      out.push(`<ul>${items.join('')}</ul>`)
    } else if (line.startsWith('> ')) out.push(`<blockquote><p>${inline(line.slice(2))}</p></blockquote>`)
    else if (line.startsWith('```') || line.startsWith('````') || /^<(?!sub>)[a-z]/i.test(line)) {
      throw new Error(`render-brand: unsupported markdown at line ${i + 1}: ${line.slice(0, 40)}`)
    } else out.push(`<p>${inline(line)}</p>`)
  }
  return out.join('\n')
}

/** The comment frame with the rendered body in place. */
export function frameHtml(markdown, root = ROOT) {
  const frame = readFileSync(join(root, TEMPLATES, 'comment-frame.html'), 'utf8')
  if (!frame.includes('{{body}}')) throw new Error('render-brand: comment-frame.html has no {{body}} slot')
  return frame.replace('{{body}}', () => commentToHtml(markdown))
}

// ---- Render ----------------------------------------------------------------

async function fill(page, slots) {
  await page.evaluate((s) => {
    for (const [name, html] of Object.entries(s)) {
      const el = document.querySelector(`[data-slot="${name}"]`)
      if (!el) throw new Error(`template has no data-slot="${name}"`)
      el.innerHTML = html
    }
    document.dispatchEvent(new Event('slots-filled'))
  }, slots)
  await page.evaluate(async () => {
    await document.fonts.ready
    await Promise.all([...document.images].map((img) => img.decode().catch(() => undefined)))
  })
  // Templates set data-ready to 1 once laid out, or to the error that stopped them.
  const handle = await page.waitForFunction(() => document.documentElement.dataset.ready !== '0' && document.documentElement.dataset.ready)
  const ready = await handle.jsonValue()
  if (ready !== '1') throw new Error(`render-brand: template failed: ${ready}`)
}

export async function renderBrand({ outDir = OUT_DIR, root = ROOT, log = console.log } = {}) {
  const { chromium } = await import('playwright')
  const { fixture, markdown } = loadSource(SOURCE_FIXTURE, root)
  const spend = formatUsd(fixtureSpendUsd(fixture))
  const comment = frameHtml(markdown, root)
  const out = resolve(root, outDir)
  mkdirSync(out, { recursive: true })
  const url = (name) => pathToFileURL(join(root, TEMPLATES, name)).href
  const written = []

  const browser = await chromium.launch()
  try {
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({
        viewport: { width: HERO_WIDTH, height: 800 },
        deviceScaleFactor: HERO_SCALE,
        colorScheme: theme,
        reducedMotion: 'reduce',
      })
      const page = await context.newPage()
      await page.goto(url('hero.html'), { waitUntil: 'load' })
      await fill(page, { comment, spend })
      const path = join(out, `hero-${theme}.png`)
      await page.locator('#hero').screenshot({ path, animations: 'disabled', caret: 'hide' })
      written.push(path)
      await context.close()
    }
    const context = await browser.newContext({
      viewport: SOCIAL,
      deviceScaleFactor: 1,
      colorScheme: 'dark',
      reducedMotion: 'reduce',
    })
    const page = await context.newPage()
    await page.goto(url('social.html'), { waitUntil: 'load' })
    await fill(page, { comment, spend })
    const path = join(out, 'social.png')
    await page.screenshot({ path, animations: 'disabled', caret: 'hide' })
    written.push(path)
    await context.close()
  } finally {
    await browser.close()
  }
  for (const p of written) log(`render-brand: wrote ${p.slice(root.length + 1)}`)
  return written
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const refusal = keyRefusal()
  if (refusal) {
    console.error(refusal)
    process.exit(3)
  }
  const i = process.argv.indexOf('--out')
  const outDir = i === -1 ? OUT_DIR : process.argv[i + 1]
  if (!outDir) {
    console.error('render-brand: --out needs a directory')
    process.exit(2)
  }
  try {
    await renderBrand({ outDir })
  } catch (e) {
    console.error(e.message)
    process.exit(2)
  }
}

