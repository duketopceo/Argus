import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { captureMatrix, filterCss, parseWebArgs } from '../../scripts/qa/capture-web.mjs'
import { buildTape, parseTermArgs } from '../../scripts/qa/capture-term.mjs'

const ROOT = join(import.meta.dirname, '..', '..')

describe('capture-web arguments', () => {
  it('defaults to both widths in both themes: four combinations', () => {
    const opts = parseWebArgs(['--target', 'dashboard', '--unit', 'U2'])
    expect(captureMatrix(opts)).toEqual([
      { width: 1440, theme: 'light' },
      { width: 1440, theme: 'dark' },
      { width: 390, theme: 'light' },
      { width: 390, theme: 'dark' },
    ])
    expect(opts.outDir).toBe(join('argus-reviewer-report', 'qa', 'U2'))
  })

  it('accepts a single width', () => {
    const opts = parseWebArgs(['--target', 'dashboard', '--width', '390'])
    expect(captureMatrix(opts)).toEqual([
      { width: 390, theme: 'light' },
      { width: 390, theme: 'dark' },
    ])
  })

  it('rejects a width that is not a positive integer', () => {
    expect(() => parseWebArgs(['--target', 'dashboard', '--width', 'wide'])).toThrow(/--width/)
  })

  it('requires a target', () => {
    expect(() => parseWebArgs([])).toThrow(/--target/)
  })
})

describe('capture-web filters', () => {
  it('grayscale applies a filter to the whole page before capture', () => {
    const opts = parseWebArgs(['--target', 'dashboard', '--filter', 'grayscale'])
    expect(filterCss(opts.filter)).toMatch(/html\s*\{\s*filter:\s*grayscale\(1\)\s*!important/)
  })

  it('deuteranopia applies a color-matrix filter', () => {
    const css = filterCss('deuteranopia')
    expect(css).toMatch(/html\s*\{\s*filter:\s*url\(/)
    expect(css).toContain('feColorMatrix')
  })

  it('no filter adds no CSS', () => {
    expect(filterCss(undefined)).toBe('')
  })

  it('rejects an unknown filter', () => {
    expect(() => parseWebArgs(['--target', 'dashboard', '--filter', 'sepia'])).toThrow(/--filter/)
  })
})

describe('capture-term', () => {
  it('defaults to 80 and 120 columns and accepts a single width', () => {
    expect(parseTermArgs(['--', 'node', 'dist/cli.js', '--help']).cols).toEqual([80, 120])
    expect(parseTermArgs(['--cols', '80', '--', 'node', 'dist/cli.js']).cols).toEqual([80])
  })

  it('requires a command after --', () => {
    expect(() => parseTermArgs(['--unit', 'U11'])).toThrow(/command/)
  })

  it('pins the column count and keeps a frame after the screenshot', () => {
    // Real paths: absolute, under a dot-directory (.claude/worktrees), with dashes.
    const png = '/home/u/.claude/worktrees/a-b/argus-reviewer-report/qa/U2/term-80.png'
    const tape = buildTape({ command: 'node dist/cli.js --help', cols: 80, png, gif: '/tmp/argus-qa-term-x/80.gif', waitMs: 1500 })
    const lines = tape.split('\n')
    expect(tape).toContain('stty cols 80')
    // VHS rejects unquoted paths like these.
    expect(tape).toContain('Output "/tmp/argus-qa-term-x/80.gif"')
    const shot = lines.indexOf(`Screenshot "${png}"`)
    expect(shot).toBeGreaterThan(-1)
    // VHS drops a Screenshot that is the last frame of the tape.
    expect(lines.slice(shot + 1).some((l) => l.startsWith('Sleep'))).toBe(true)
  })
})

describe('R32: the harness refuses to run with an OpenRouter key set', () => {
  const run = (script: string, args: string[]) =>
    spawnSync(process.execPath, [join(ROOT, 'scripts/qa', script), ...args], {
      cwd: ROOT,
      env: { ...process.env, OPENROUTER_API_KEY: 'sk-or-test-not-a-real-key' },
      encoding: 'utf8',
      timeout: 20_000,
    })

  it('capture-web exits non-zero with an explanation', () => {
    const r = run('capture-web.mjs', ['--target', 'dashboard', '--unit', 'refusal-test'])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('OPENROUTER_API_KEY')
    expect(r.stderr).toMatch(/unset/i)
    expect(r.stdout).not.toContain('wrote')
  })

  it('capture-term exits non-zero with an explanation', () => {
    const r = run('capture-term.mjs', ['--unit', 'refusal-test', '--', 'echo', 'hi'])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('OPENROUTER_API_KEY')
    expect(r.stdout).not.toContain('wrote')
  })
})
