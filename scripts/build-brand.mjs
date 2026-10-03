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
//
// Glyphs stay in currentColor: surfaces color them through status tokens, so
// they get no per-theme or per-file exports.
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
    colors[theme] = { accent: t.accent.$value.hex, ink: t.ink.$value.hex }
  }
  return colors
}

function svgoOptimize(svg) {
  return optimize(svg, {
    multipass: true,
    floatPrecision: 3,
    plugins: [{ name: 'preset-default' }],
  }).data
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
  for (const { rel, svg } of masters) {
    if (rel.startsWith(GLYPH_PREFIX)) continue
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
  return files
}

/**
 * One <symbol> per glyph master, id = file stem. The master's root
 * presentation attributes (fill, stroke, stroke-width…) move onto a <g> inside
 * the symbol so `<use href="glyphs.svg#status-passed">` keeps them.
 */
export function buildGlyphSprite(glyphs) {
  const symbols = glyphs.map(({ rel, svg }) => {
    const id = rel.slice(GLYPH_PREFIX.length).replace(/\.svg$/, '')
    const opt = svgoOptimize(svg)
    const m = /^<svg([^>]*)>([\s\S]*)<\/svg>$/.exec(opt)
    if (!m) throw new Error(`${rel}: unexpected SVGO output`)
    const attrs = m[1]
      .replace(/\sxmlns="[^"]*"/, '')
      .replace(/\sviewBox="[^"]*"/, '')
      .trim()
    const viewBox = /viewBox="([^"]*)"/.exec(m[1])?.[1]
    if (viewBox !== '0 0 24 24') throw new Error(`${rel}: glyphs are drawn on the 24-unit grid`)
    const [, title = '', body] = /^(<title>[^<]*<\/title>)?([\s\S]*)$/.exec(m[2])
    return `<symbol id="${id}" viewBox="0 0 24 24">${title}<g ${attrs}>${body}</g></symbol>`
  })
  return `<svg xmlns="http://www.w3.org/2000/svg">${symbols.join('')}</svg>\n`
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
  const i = process.argv.indexOf('--preview')
  if (i !== -1) {
    const target = process.argv[i + 1]
    if (!target) throw new Error('--preview needs an output path')
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, buildPreview())
    console.log(`build-brand: wrote preview ${target}`)
  }
}
