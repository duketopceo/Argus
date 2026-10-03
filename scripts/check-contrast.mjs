#!/usr/bin/env node
// WCAG 2.x contrast check for the DESIGN.md color tokens (R29, section 6.1).
//
// Computes the ratio for every text/background pair section 6.1 lists, in
// both themes, and exits 1 when any pair falls below its threshold:
//   text (ink, ink-2, ink-3, accent, statuses)   4.5:1
//   control borders                               3:1
//   hairline                                      reported only (decorative)
//
// Usage: node scripts/check-contrast.mjs

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseFrontMatter } from './build-tokens.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const TEXT = 4.5
const NON_TEXT = 3

function luminance(hex) {
  const n = Number.parseInt(hex.slice(1), 16)
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG 2.x contrast ratio between two #RRGGBB colors. */
export function contrastRatio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

const TEXT_TOKENS = ['ink', 'ink-2', 'ink-3', 'accent', 'passed', 'failed', 'caution']
const STATUSES = ['passed', 'failed', 'caution']

/** Section 6.1 pairs as [fg, bg, minimum or null for report-only]. */
function pairs() {
  const out = []
  for (const fg of TEXT_TOKENS) for (const bg of ['canvas', 'surface']) out.push([fg, bg, TEXT])
  // Code wells and popovers carry text too; checked when U1 made both themes define them.
  for (const fg of ['ink', 'ink-2', 'ink-3']) for (const bg of ['surface-sunk', 'raised']) out.push([fg, bg, TEXT])
  for (const bg of ['canvas', 'surface']) out.push(['control-border', bg, NON_TEXT])
  for (const bg of ['canvas', 'surface']) out.push(['hairline', bg, null])
  out.push(['on-accent', 'accent', TEXT])
  for (const s of STATUSES) out.push([s, `${s}-tint`, TEXT])
  return out
}

/**
 * One row per theme and pair: { theme, fg, bg, ratio, min, pass }.
 * A token missing from the set is an error, not a skipped row.
 */
export function checkContrast(colors) {
  const rows = []
  for (const theme of ['light', 'dark']) {
    const set = colors[theme]
    for (const [fg, bg, min] of pairs()) {
      if (!set[fg] || !set[bg]) throw new Error(`contrast: ${theme} is missing ${!set[fg] ? fg : bg}`)
      const ratio = contrastRatio(set[fg], set[bg])
      rows.push({ theme, fg, bg, ratio, min, pass: min === null || ratio >= min })
    }
  }
  return rows
}

export function formatReport(rows) {
  const lines = ['theme  pair                         ratio   min   result']
  for (const r of rows) {
    const pair = `${r.fg} on ${r.bg}`.padEnd(28)
    const min = r.min === null ? 'n/a ' : `${r.min.toFixed(1)}:1`.padStart(5)
    const result = r.min === null ? 'report only' : r.pass ? 'pass' : 'FAIL'
    lines.push(`${r.theme.padEnd(6)} ${pair} ${r.ratio.toFixed(2).padStart(5)}  ${min}  ${result}`)
  }
  const failed = rows.filter((r) => !r.pass).length
  lines.push('', failed === 0 ? `${rows.length} pairs, all pass` : `${failed} of ${rows.length} pairs below threshold`)
  return lines.join('\n')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const rows = checkContrast(parseFrontMatter(readFileSync(join(ROOT, 'DESIGN.md'), 'utf8')).colors)
  console.log(formatReport(rows))
  if (rows.some((r) => !r.pass)) process.exit(1)
}
