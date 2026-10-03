#!/usr/bin/env node
// Brand asset exports from hand-authored SVG masters (plan KTD6, unit U7).
//
// Masters live under assets/brand/src/ and draw in `currentColor` on a
// 24-unit grid (marks) or in font units (wordmark, lockup). This script
// writes assets/brand/export/, mirroring the src/ tree:
//
//   <name>.svg              SVGO-optimized, still currentColor
//   <name>-light.svg        colored for the paper canvas
//   <name>-dark.svg         colored for the graphite canvas
//   mark-<px>-<theme>.png   marks only, at 16/32/64/256 px; each size uses
//                           the optical master drawn for it
//   lockup-64-<theme>.png   lockups only, 64 px tall
//   glyphs.svg              sprite of every src/glyphs/ master (unit U8), one
//                           <symbol> per glyph with the master's file stem as
//                           its id (status-passed, proof-2, severity-q, lane-a0)
//   chrome.svg              sprite of every src/chrome/ master (unit U9, DESIGN.md
//                           A7): the UI chrome icons, id = file stem (refresh,
//                           chevron-down, …), drawn from lines and rectangles
//
//   empty/<name>-<theme>.svg  empty-state illustrations (unit U9, DESIGN.md
//                           A13), 160x120. Masters carry the two light-theme
//                           tones (ink-3, accent); the dark export swaps them
//                           for the dark tokens.
//
//   icons/                  app icon and favicons (unit U10, DESIGN.md A8/A9)
//                           from the full-color masters in src/icons/:
//     app-icon-<px>.png     16-1024; 16 and 32 use the app-icon-16 optical master
//     app-icon.ico          16, 32, 48, 256 (PNG entries)
//     app-icon.icns         the macOS 16-512 @1x/@2x set (PNG entries)
//     favicon.svg           mark with an internal prefers-color-scheme swap
//     favicon-32.png, apple-touch-icon.png (180), icon-512.png,
//     icon-maskable-512.png
//
// It also writes src/report/brand-assets.generated.ts (unit U14): the HTML
// evidence report's inline assets (tokens.css, the upright WOFF2 subsets as
// data URIs, the glyph sprite, the chrome icons it uses, two empty states and
// the mark), so they compile into dist/ and a packed install renders the
// report with no assets/ directory present.
//
// Glyphs stay in currentColor: surfaces color them through status tokens, so
// they get no per-theme or per-file exports. Icon masters carry their own
// colors (accent field, on-accent mark); the test pins them to tokens.json.
//
// Marks take the `accent` token, the wordmark and lockups take `ink`
// (DESIGN.md A1/A2, §6.1). Colors come from assets/brand/tokens.json so the
// token source stays single. Exports are committed;
// tests/unit/brand-assets.test.ts fails when they drift or stop reproducing.
//
// Usage:
//   node scripts/build-brand.mjs                  write assets/brand/export/
//   node scripts/build-brand.mjs --preview <png>  also write a contact sheet

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Resvg } from '@resvg/resvg-js'
import { optimize } from 'svgo'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const SRC_DIR = 'assets/brand/src'
export const EXPORT_DIR = 'assets/brand/export'

const THEMES = ['light', 'dark']
const MARK_SIZES = [16, 32, 64, 256]
const LOCKUP_HEIGHT = 64
export const GLYPH_PREFIX = 'glyphs/'
export const ICON_PREFIX = 'icons/'
export const CHROME_PREFIX = 'chrome/'
export const EMPTY_PREFIX = 'empty/'
/** The only tokens an empty-state master may draw in (DESIGN.md A13). */
export const EMPTY_TONES = ['ink-3', 'accent']
export const APP_ICON_SIZES = [16, 32, 48, 64, 128, 256, 512, 1024]
export const ICO_SIZES = [16, 32, 48, 256]
/** ICNS slot -> pixel size: the iconutil 16-512 @1x/@2x set. */
export const ICNS_TYPES = {
  icp4: 16,
  icp5: 32,
  ic11: 32,
  ic12: 64,
  ic07: 128,
  ic13: 256,
  ic08: 256,
  ic14: 512,
  ic09: 512,
  ic10: 1024,
}

/** Optical master for a pixel size: ticks and thin strokes drop out small. */
export function markMasterFor(px) {
  if (px < 20) return 'mark-16'
  if (px < 48) return 'mark-24'
  return 'mark'
}

function listSvgs(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listSvgs(path))
    else if (entry.name.endsWith('.svg')) out.push(path)
  }
  return out.sort()
}

/** Master files as { rel: 'mark-16.svg', svg: '<svg…' }, sorted. */
export function readMasters(root = ROOT) {
  const base = join(root, SRC_DIR)
  return listSvgs(base).map((path) => ({
    rel: relative(base, path).split('\\').join('/'),
    svg: readFileSync(path, 'utf8'),
  }))
}

export function readThemeColors(root = ROOT) {
  const tokens = JSON.parse(readFileSync(join(root, 'assets/brand/tokens.json'), 'utf8'))
  const colors = {}
  for (const theme of THEMES) {
    const t = tokens.color[theme]
    colors[theme] = {
      accent: t.accent.$value.hex,
      ink: t.ink.$value.hex,
      'ink-3': t['ink-3'].$value.hex,
    }
  }
  return colors
}

function svgoOptimize(svg, { keepStyles = false } = {}) {
  // keepStyles: inlining a <style> rule onto its element would outrank the
  // favicon's prefers-color-scheme override and freeze it in light colors.
  const preset = keepStyles
    ? { name: 'preset-default', params: { overrides: { inlineStyles: false } } }
    : { name: 'preset-default' }
  return optimize(svg, { multipass: true, floatPrecision: 3, plugins: [preset] }).data
}

function colorize(svg, hex) {
  return svg.replaceAll('currentColor', hex)
}

function renderPng(svg, fit) {
  return Buffer.from(
    new Resvg(svg, { fitTo: fit, font: { loadSystemFonts: false } }).render().asPng(),
  )
}

const kindOf = (rel) => {
  const name = rel
    .split('/')
    .pop()
    .replace(/\.svg$/, '')
  return name.startsWith('mark') ? 'mark' : name
}

/**
 * Build every export in memory. Returns a Map of path (relative to
 * assets/brand/export/) to Buffer, in a stable order.
 */
export function buildBrand(masters = readMasters(), colors = readThemeColors()) {
  const files = new Map()
  const optimized = new Map()
  const glyphs = masters.filter((m) => m.rel.startsWith(GLYPH_PREFIX))
  const chrome = masters.filter((m) => m.rel.startsWith(CHROME_PREFIX))
  const empty = masters.filter((m) => m.rel.startsWith(EMPTY_PREFIX))
  for (const { rel, svg } of masters) {
    if ([GLYPH_PREFIX, ICON_PREFIX, CHROME_PREFIX, EMPTY_PREFIX].some((p) => rel.startsWith(p)))
      continue
    const opt = svgoOptimize(svg)
    optimized.set(rel, opt)
    const stem = rel.replace(/\.svg$/, '')
    files.set(`${stem}.svg`, Buffer.from(opt))
    const role = kindOf(rel) === 'mark' ? 'accent' : 'ink'
    for (const theme of THEMES)
      files.set(`${stem}-${theme}.svg`, Buffer.from(colorize(opt, colors[theme][role])))
  }
  for (const rel of optimized.keys()) {
    const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/') + 1) : ''
    const name = rel.slice(dir.length)
    if (name === 'mark.svg') {
      for (const px of MARK_SIZES) {
        const master = optimized.get(`${dir}${markMasterFor(px)}.svg`) ?? optimized.get(rel)
        for (const theme of THEMES) {
          files.set(
            `${dir}mark-${px}-${theme}.png`,
            renderPng(colorize(master, colors[theme].accent), { mode: 'width', value: px }),
          )
        }
      }
    } else if (name === 'lockup.svg') {
      for (const theme of THEMES) {
        files.set(
          `${dir}lockup-${LOCKUP_HEIGHT}-${theme}.png`,
          renderPng(colorize(optimized.get(rel), colors[theme].ink), {
            mode: 'height',
            value: LOCKUP_HEIGHT,
          }),
        )
      }
    }
  }
  if (glyphs.length) files.set('glyphs.svg', Buffer.from(buildGlyphSprite(glyphs)))
  if (chrome.length) files.set('chrome.svg', Buffer.from(buildGlyphSprite(chrome, CHROME_PREFIX)))
  for (const [rel, buf] of buildEmptyStates(empty, colors)) files.set(rel, buf)
  const icons = masters.filter((m) => m.rel.startsWith(ICON_PREFIX))
  if (icons.length) for (const [rel, buf] of buildIcons(icons)) files.set(rel, buf)
  return files
}

/** Light and dark exports of the empty-state masters, tones swapped by token. */
export function buildEmptyStates(empty, colors) {
  const files = new Map()
  for (const { rel, svg } of empty) {
    const opt = svgoOptimize(svg)
    const stem = rel.replace(/\.svg$/, '')
    for (const theme of THEMES) {
      let out = opt
      for (const tone of EMPTY_TONES) {
        const from = new RegExp(colors.light[tone], 'gi')
        out = out.replace(from, colors[theme][tone])
      }
      files.set(`${stem}-${theme}.svg`, Buffer.from(out))
    }
  }
  return files
}

/** App icon, ICO, ICNS and favicon exports from the src/icons/ masters. */
export function buildIcons(icons) {
  const svg = new Map(
    icons.map(({ rel, svg }) => [
      rel.slice(ICON_PREFIX.length, -4),
      svgoOptimize(svg, { keepStyles: true }),
    ]),
  )
  const need = (name) => {
    const s = svg.get(name)
    if (!s) throw new Error(`missing master ${SRC_DIR}/${ICON_PREFIX}${name}.svg`)
    return s
  }
  const appIcon = (px) =>
    renderPng(need(px <= 32 ? 'app-icon-16' : 'app-icon'), { mode: 'width', value: px })
  const png = new Map(APP_ICON_SIZES.map((px) => [px, appIcon(px)]))
  const files = new Map()
  for (const [name, s] of svg) files.set(`${ICON_PREFIX}${name}.svg`, Buffer.from(s))
  for (const [px, buf] of png) files.set(`${ICON_PREFIX}app-icon-${px}.png`, buf)
  files.set(`${ICON_PREFIX}app-icon.ico`, encodeIco(ICO_SIZES.map((px) => [px, png.get(px)])))
  files.set(
    `${ICON_PREFIX}app-icon.icns`,
    encodeIcns(Object.entries(ICNS_TYPES).map(([type, px]) => [type, png.get(px)])),
  )
  files.set(`${ICON_PREFIX}favicon-32.png`, png.get(32))
  const maskable = need('app-icon-maskable')
  files.set(
    `${ICON_PREFIX}apple-touch-icon.png`,
    renderPng(maskable, { mode: 'width', value: 180 }),
  )
  files.set(`${ICON_PREFIX}icon-512.png`, png.get(512))
  files.set(
    `${ICON_PREFIX}icon-maskable-512.png`,
    renderPng(maskable, { mode: 'width', value: 512 }),
  )
  return files
}

/** ICO with PNG-compressed entries (Windows Vista+, every browser). */
export function encodeIco(entries) {
  const head = Buffer.alloc(6 + entries.length * 16)
  head.writeUInt16LE(0, 0)
  head.writeUInt16LE(1, 2)
  head.writeUInt16LE(entries.length, 4)
  let offset = head.length
  entries.forEach(([px, buf], i) => {
    const e = 6 + i * 16
    head.writeUInt8(px >= 256 ? 0 : px, e)
    head.writeUInt8(px >= 256 ? 0 : px, e + 1)
    head.writeUInt16LE(1, e + 4)
    head.writeUInt16LE(32, e + 6)
    head.writeUInt32LE(buf.length, e + 8)
    head.writeUInt32LE(offset, e + 12)
    offset += buf.length
  })
  return Buffer.concat([head, ...entries.map(([, buf]) => buf)])
}

/** ICNS with PNG entries, the format `iconutil` writes. */
export function encodeIcns(entries) {
  const chunks = entries.map(([type, buf]) => {
    const h = Buffer.alloc(8)
    h.write(type, 0, 'latin1')
    h.writeUInt32BE(buf.length + 8, 4)
    return Buffer.concat([h, buf])
  })
  const h = Buffer.alloc(8)
  h.write('icns', 0, 'latin1')
  h.writeUInt32BE(8 + chunks.reduce((n, c) => n + c.length, 0), 4)
  return Buffer.concat([h, ...chunks])
}

/**
 * One <symbol> per glyph master, id = file stem. The master's root
 * presentation attributes (fill, stroke, stroke-width…) move onto a <g> inside
 * the symbol so `<use href="glyphs.svg#status-passed">` keeps them.
 */
export function buildGlyphSprite(glyphs, prefix = GLYPH_PREFIX) {
  const symbols = glyphs.map(({ rel, svg }) => {
    const id = rel.slice(prefix.length).replace(/\.svg$/, '')
    const opt = svgoOptimize(svg)
    const m = /^<svg([^>]*)>([\s\S]*)<\/svg>$/.exec(opt)
    if (!m) throw new Error(`${rel}: unexpected SVGO output`)
    const attrs = m[1]
      .replace(/\sxmlns="[^"]*"/, '')
      .replace(/\sviewBox="[^"]*"/, '')
      .trim()
    const viewBox = /viewBox="([^"]*)"/.exec(m[1])?.[1]
    if (viewBox !== '0 0 24 24')
      throw new Error(`${rel}: sprite masters are drawn on the 24-unit grid`)
    const [, title = '', body] = /^(<title>[^<]*<\/title>)?([\s\S]*)$/.exec(m[2])
    return `<symbol id="${id}" viewBox="0 0 24 24">${title}<g ${attrs}>${body}</g></symbol>`
  })
  return `<svg xmlns="http://www.w3.org/2000/svg">${symbols.join('')}</svg>\n`
}

// ---- HTML evidence report assets (U14) --------------------------------------

export const REPORT_ASSETS_PATH = 'src/report/brand-assets.generated.ts'
/** Chrome icons the report draws (copy buttons, run link). */
export const REPORT_CHROME = ['copy', 'check', 'external']
/** Empty states the report can show (DESIGN.md A13). */
export const REPORT_EMPTY = ['manifest-unreadable', 'nothing-to-heal']

/**
 * fonts.css with every url() inlined as a data URI. Italic faces go: the
 * report sets no italic, and they would add 35 KB of base64 to every run.
 */
export function inlineFontFaces(root = ROOT) {
  const css = readFileSync(join(root, 'assets/brand/fonts.css'), 'utf8')
  const faces = css.match(/@font-face\s*\{[^}]*\}/g) ?? []
  const vars = /:root\s*\{[^}]*\}/.exec(css)?.[0] ?? ''
  const out = faces
    .filter((face) => !/font-style:\s*italic/.test(face))
    .map((face) =>
      face.replace(/url\('fonts\/([\w.-]+\.woff2)'\)/g, (_, file) => {
        const b64 = readFileSync(join(root, 'assets/brand/fonts', file)).toString('base64')
        return `url(data:font/woff2;base64,${b64})`
      }),
    )
  return [...out, vars].join('\n')
}

/** Keep only the named <symbol>s of a sprite. */
function pickSymbols(sprite, ids) {
  const symbols = sprite.match(/<symbol id="[^"]+"[\s\S]*?<\/symbol>/g) ?? []
  return symbols.filter((s) => ids.includes(/id="([^"]+)"/.exec(s)[1])).join('')
}

/** TypeScript source of src/report/brand-assets.generated.ts. */
export function buildReportAssets(files = buildBrand(), root = ROOT) {
  const text = (rel) => files.get(rel).toString('utf8').trim()
  const glyphs = /^<svg[^>]*>([\s\S]*)<\/svg>$/.exec(text('glyphs.svg'))[1]
  const chrome = pickSymbols(text('chrome.svg'), REPORT_CHROME)
  const empty = Object.fromEntries(
    REPORT_EMPTY.map((name) => [
      name,
      { light: text(`empty/${name}-light.svg`), dark: text(`empty/${name}-dark.svg`) },
    ]),
  )
  const tokens = readFileSync(join(root, 'assets/brand/tokens.css'), 'utf8').replace(
    /^\/\*[^*]*\*\/\s*/,
    '',
  )
  const lit = (v) => JSON.stringify(v)
  return [
    '// Generated by scripts/build-brand.mjs (npm run brand). Do not edit by hand.',
    '// Inline assets for the HTML evidence report (src/report/html.ts, plan U14).',
    '',
    `export const TOKENS_CSS = ${lit(tokens.trim())}`,
    '',
    `export const FONT_FACES_CSS = ${lit(inlineFontFaces(root))}`,
    '',
    '/** <symbol> elements: every glyph (U8) plus the chrome icons the report uses (U9). */',
    `export const SPRITE_SYMBOLS = ${lit(glyphs + chrome)}`,
    '',
    `export const EMPTY_STATES: Record<string, { light: string; dark: string }> = ${lit(empty)}`,
    '',
    `export const MARK_SVG = ${lit(text('mark.svg'))}`,
    '',
  ].join('\n')
}

export function writeExports(files, root = ROOT) {
  const out = join(root, EXPORT_DIR)
  rmSync(out, { recursive: true, force: true })
  for (const [rel, buf] of files) {
    mkdirSync(dirname(join(out, rel)), { recursive: true })
    writeFileSync(join(out, rel), buf)
  }
}

// ---- Contact sheet (review aid, not committed) ------------------------------

const CANVAS = { light: '#F4F5F7', dark: '#0C0E12' }
const LABEL = { light: '#5D6571', dark: '#8A929E' }

function pngImage(buf, x, y, w, h) {
  return `<image x="${x}" y="${y}" width="${w}" height="${h}" href="data:image/png;base64,${buf.toString('base64')}"/>`
}

/** Nearest-neighbour zoom of a small raster, drawn as one rect per pixel. */
function pixelZoom(svg, px, x, y, scale) {
  const img = new Resvg(svg, {
    fitTo: { mode: 'width', value: px },
    font: { loadSystemFonts: false },
  }).render()
  const out = []
  for (let j = 0; j < img.height; j++) {
    for (let i = 0; i < img.width; i++) {
      const o = (j * img.width + i) * 4
      const a = img.pixels[o + 3]
      if (!a) continue
      // resvg pixels are premultiplied; un-premultiply for the fill.
      const c = [0, 1, 2].map((k) => Math.round((img.pixels[o + k] * 255) / a))
      out.push(
        `<rect x="${x + i * scale}" y="${y + j * scale}" width="${scale}" height="${scale}" fill="rgb(${c})" fill-opacity="${(a / 255).toFixed(3)}"/>`,
      )
    }
  }
  return out.join('')
}

/** One block per mark set: 16/24/32/64/256 px, 5x pixel zooms of 16/24, lockups; paper, graphite, mono. */
export function buildPreview(masters = readMasters(), colors = readThemeColors()) {
  const bySet = new Map()
  for (const { rel, svg } of masters) {
    const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
    if (!bySet.has(dir)) bySet.set(dir, new Map())
    bySet.get(dir).set(rel.slice(dir ? dir.length + 1 : 0).replace(/\.svg$/, ''), svgoOptimize(svg))
  }
  const sets = [...bySet.entries()].filter(([, m]) => m.has('mark'))
  const W = 1720
  const ROW = 320
  const parts = []
  let y = 0
  for (const [name, m] of sets) {
    const variants = [
      ['light', 'accent', 'paper'],
      ['dark', 'accent', 'graphite'],
      ['light', 'ink', 'paper, mono'],
      ['dark', 'ink', 'graphite, mono'],
    ]
    const half = W / 2
    variants.forEach(([theme, role, label], i) => {
      const x0 = (i % 2) * half
      const y0 = y + Math.floor(i / 2) * ROW
      const fg = colors[theme][role]
      parts.push(
        `<rect x="${x0}" y="${y0}" width="${half}" height="${ROW}" fill="${CANVAS[theme]}"/>`,
      )
      parts.push(
        `<text x="${x0 + 16}" y="${y0 + 24}" font-family="sans-serif" font-size="14" fill="${LABEL[theme]}">${name || 'argus'} · ${label}</text>`,
      )
      let x = x0 + 16
      const base = y0 + 40
      for (const px of [16, 24, 32, 64]) {
        const svg = colorize(m.get(markMasterFor(px)) ?? m.get('mark'), fg)
        parts.push(pngImage(renderPng(svg, { mode: 'width', value: px }), x, base, px, px))
        x += px + 16
      }
      for (const px of [16, 24]) {
        const svg = colorize(m.get(markMasterFor(px)) ?? m.get('mark'), fg)
        parts.push(pixelZoom(svg, px, x, base, 5))
        x += px * 5 + 16
      }
      const big = colorize(m.get('mark'), fg)
      parts.push(
        pngImage(renderPng(big, { mode: 'width', value: 256 }), x0 + half - 272, base, 256, 256),
      )
      const lockup = m.get('lockup') ?? bySet.get('')?.get('wordmark')
      if (lockup) {
        const lk = colorize(lockup, colors[theme].ink)
        let lx = x0 + 16
        for (const h of [56, 24]) {
          const img = new Resvg(lk, {
            fitTo: { mode: 'height', value: h },
            font: { loadSystemFonts: false },
          }).render()
          parts.push(pngImage(Buffer.from(img.asPng()), lx, base + 200 - h, img.width, h))
          lx += img.width + 24
        }
      }
    })
    y += ROW * 2 + 8
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${y}" viewBox="0 0 ${W} ${y}"><rect width="${W}" height="${y}" fill="#888"/>${parts.join('')}</svg>`
  return Buffer.from(new Resvg(svg, { font: { loadSystemFonts: true } }).render().asPng())
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const files = buildBrand()
  writeExports(files)
  console.log(`build-brand: wrote ${files.size} files to ${EXPORT_DIR}/`)
  writeFileSync(join(ROOT, REPORT_ASSETS_PATH), buildReportAssets(files))
  console.log(`build-brand: wrote ${REPORT_ASSETS_PATH}`)
  const i = process.argv.indexOf('--preview')
  if (i !== -1) {
    const target = process.argv[i + 1]
    if (!target) throw new Error('--preview needs an output path')
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, buildPreview())
    console.log(`build-brand: wrote preview ${target}`)
  }
}
