#!/usr/bin/env node
// R31 terminal evidence: run a CLI or TUI command in a terminal pinned to 80
// and 120 columns and save a PNG of each via VHS `Screenshot`.
//
//   node scripts/qa/capture-term.mjs --unit U11 -- node dist/cli.js --help
//   node scripts/qa/capture-term.mjs --unit U12 --cols 120 --wait 4000 -- npm run watch
//
// Output goes to argus-reviewer-report/qa/<unit>/term-<label>-<cols>.png
// (gitignored; attach to the PR). Requires vhs, ttyd and ffmpeg on PATH.
// Refuses to run while OPENROUTER_API_KEY is set (R32).
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { keyRefusal } from './capture-web.mjs'

export const DEFAULT_COLS = [80, 120]
const ROWS = 30
const FONT = 14
const PAD = 12

const USAGE = `usage: capture-term.mjs [--unit <name>] [--cols <n>] [--label <name>] [--wait <ms>] -- <command...>`

/** Parse capture-term arguments. Throws with usage text on bad input. */
export function parseTermArgs(argv) {
  const opts = { unit: 'adhoc', cols: DEFAULT_COLS, label: '', waitMs: 2500, command: [] }
  const sep = argv.indexOf('--')
  const flags = sep === -1 ? argv : argv.slice(0, sep)
  opts.command = sep === -1 ? [] : argv.slice(sep + 1)
  const num = (flag, raw) => {
    const n = Number(raw)
    if (!Number.isInteger(n) || n <= 0) throw new Error(`${flag} must be a positive integer, got "${raw}"`)
    return n
  }
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i]
    const v = flags[i + 1]
    if (v === undefined) throw new Error(`${flag} needs a value\n${USAGE}`)
    i++
    if (flag === '--unit') opts.unit = v
    else if (flag === '--cols') opts.cols = [num(flag, v)]
    else if (flag === '--label') opts.label = v
    else if (flag === '--wait') opts.waitMs = num(flag, v)
    else throw new Error(`unknown argument "${flag}"\n${USAGE}`)
  }
  if (opts.command.length === 0) throw new Error(`a command to run is required after --\n${USAGE}`)
  if (!opts.label) opts.label = opts.command.map((a) => a.replace(/[^A-Za-z0-9]+/g, '-')).join('-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
  opts.outDir = join('argus-reviewer-report', 'qa', opts.unit)
  return opts
}

/** Quote one argv entry for bash. */
const shq = (a) => (/^[A-Za-z0-9_./:=@%+-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)

/** Quote a string for a VHS tape (", ' or ` delimited; VHS has no escapes). */
function vhsString(s) {
  for (const q of ['"', "'", '`']) if (!s.includes(q)) return `${q}${s}${q}`
  throw new Error(`cannot quote for VHS, contains all of \` " and ': ${s}`)
}

/**
 * The VHS tape for one capture. The kernel tty is pinned to `cols` with
 * stty so output wraps exactly there; the pixel width is sized to fit it.
 */
export function buildTape({ command, cols, png, gif, waitMs }) {
  // Cells measure about 0.62 x FontSize; leave room for a few extra so the
  // stty column count, not the window, decides where output wraps.
  const width = Math.ceil((cols + 4) * FONT * 0.65) + 2 * PAD
  const height = Math.ceil(ROWS * FONT * 1.35) + 2 * PAD
  return [
    `Output ${vhsString(gif)}`,
    'Set Shell "bash"',
    `Set FontSize ${FONT}`,
    `Set Width ${width}`,
    `Set Height ${height}`,
    `Set Padding ${PAD}`,
    'Set TypingSpeed 0',
    'Hide',
    `Type "stty cols ${cols} rows ${ROWS} && clear"`,
    'Enter',
    'Sleep 300ms',
    'Show',
    `Type ${vhsString(command)}`,
    'Enter',
    `Sleep ${waitMs}ms`,
    `Screenshot ${vhsString(png)}`,
    // VHS drops a Screenshot that is the last frame of the tape.
    'Sleep 500ms',
    '',
  ].join('\n')
}

export async function captureTerm(opts, log = console.log) {
  const outDir = resolve(opts.outDir)
  await mkdir(outDir, { recursive: true })
  const command = opts.command.map(shq).join(' ')
  const work = await mkdtemp(join(tmpdir(), 'argus-qa-term-'))
  try {
    for (const cols of opts.cols) {
      const name = `term-${opts.label}-${cols}.png`
      const tape = join(work, `${cols}.tape`)
      await writeFile(tape, buildTape({ command, cols, png: join(outDir, name), gif: join(work, `${cols}.gif`), waitMs: opts.waitMs }))
      const r = spawnSync('vhs', [tape], { cwd: process.cwd(), encoding: 'utf8' })
      if (r.error) throw new Error(`could not start vhs (${r.error.message}); install vhs, ttyd and ffmpeg`)
      if (r.status !== 0) throw new Error(`vhs exited ${r.status}: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' / ')}`)
      log(`wrote ${join(opts.outDir, name)}`)
    }
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const refusal = keyRefusal()
  if (refusal) {
    console.error(refusal)
    process.exit(3)
  }
  let opts
  try {
    opts = parseTermArgs(process.argv.slice(2))
  } catch (e) {
    console.error(e.message)
    process.exit(2)
  }
  try {
    await captureTerm(opts)
  } catch (e) {
    console.error(`capture failed: ${e.message}`)
    process.exit(2)
  }
}
