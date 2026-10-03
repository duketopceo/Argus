import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { main } from '../../src/cli.js'
import { createLogger } from '../../src/log.js'
import { LANE_STATUSES } from '../../src/report/manifest.js'
import { STATUS_GLYPH } from '../../src/report/viewmodel.js'
import { colorEnabled, createStyler, ROLE_SGR, STATUS_SGR } from '../../src/ui/style.js'
import { renderSummary, verifySummary } from '../../src/ui/summary.js'
import { fixtureManifest } from '../fixtures/manifest.js'

const MIN_ENV = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' }
const ESC = '\x1b['

function capture(): { lines: string[]; fn: (line: string) => void } {
  const lines: string[] = []
  return { lines, fn: (line) => lines.push(line) }
}

async function help(env: Record<string, string>, opts: { isTTY: boolean; argv?: string[] }) {
  const out = capture()
  const code = await main(opts.argv ?? ['--help'], { env: { ...MIN_ENV, ...env }, out: out.fn, isTTY: opts.isTTY })
  return { code, text: out.lines.join('\n') }
}

describe('color resolution (KTD5 precedence)', () => {
  it('TTY decides when no env flag is set', () => {
    expect(colorEnabled({ env: {}, isTTY: true })).toBe(true)
    expect(colorEnabled({ env: {}, isTTY: false })).toBe(false)
  })

  it('NO_COLOR and --no-color beat FORCE_COLOR; FORCE_COLOR beats TTY detection', () => {
    expect(colorEnabled({ env: { NO_COLOR: '1', FORCE_COLOR: '1' }, isTTY: true })).toBe(false)
    expect(colorEnabled({ env: { FORCE_COLOR: '1' }, isTTY: true, noColorFlag: true })).toBe(false)
    expect(colorEnabled({ env: { FORCE_COLOR: '1' }, isTTY: false })).toBe(true)
    // An empty NO_COLOR does not count (no-color.org); FORCE_COLOR=0 forces nothing.
    expect(colorEnabled({ env: { NO_COLOR: '' }, isTTY: true })).toBe(true)
    expect(colorEnabled({ env: { FORCE_COLOR: '0' }, isTTY: false })).toBe(false)
  })

  it('the styler uses the U1 ANSI map and is the identity when off', async () => {
    const ansi = JSON.parse(await readFile(join(import.meta.dirname, '../../assets/brand/ansi.json'), 'utf8')) as {
      roles: Record<string, { sgr: string }>
      status: Record<string, { sgr: string }>
    }
    for (const [role, v] of Object.entries(ansi.roles)) expect(ROLE_SGR[role as keyof typeof ROLE_SGR], role).toBe(v.sgr)
    for (const s of LANE_STATUSES) expect(STATUS_SGR[s], s).toBe(ansi.status[s]?.sgr)

    const on = createStyler(true)
    expect(on.glyph('passed')).toBe(`${ESC}32m${STATUS_GLYPH.passed}${ESC}0m`)
    expect(on.glyph('failed')).toBe(`${ESC}31m${STATUS_GLYPH.failed}${ESC}0m`)
    const off = createStyler(false)
    expect(off.glyph('failed')).toBe(STATUS_GLYPH.failed)
    expect(off.bold('x') + off.dim('y') + off.role('accent', 'z')).toBe('xyz')
  })
})

describe('CLI output is TTY-aware (R12)', () => {
  it('styled in a TTY, plain when piped', async () => {
    expect((await help({}, { isTTY: true })).text).toContain(ESC)
    expect((await help({}, { isTTY: false })).text).not.toContain(ESC)
  })

  it('NO_COLOR=1 with FORCE_COLOR=1 yields no color; FORCE_COLOR=1 on a non-TTY yields color', async () => {
    expect((await help({ NO_COLOR: '1', FORCE_COLOR: '1' }, { isTTY: true })).text).not.toContain(ESC)
    expect((await help({ FORCE_COLOR: '1' }, { isTTY: false })).text).toContain(ESC)
  })

  it('--no-color beats FORCE_COLOR and is accepted anywhere on the command line', async () => {
    const r = await help({ FORCE_COLOR: '1' }, { isTTY: true, argv: ['--no-color', '--help'] })
    expect(r.code).toBe(0)
    expect(r.text).not.toContain(ESC)
    expect(r.text).toContain('Review')
  })

  it('injected output without an isTTY hint stays plain', async () => {
    const out = capture()
    await main(['--help'], { env: MIN_ENV, out: out.fn })
    expect(out.lines.join('\n')).not.toContain(ESC)
  })
})

describe('--help groups commands by job (R16)', () => {
  it('lists Review, Test, Operate, Setup in order with the default command first', async () => {
    const { code, text } = await help({}, { isTTY: false })
    expect(code).toBe(0)
    const lines = text.split('\n')
    const groups = ['Review', 'Test', 'Operate', 'Setup'].map((g) => lines.indexOf(g))
    expect(groups.every((i) => i > 0)).toBe(true)
    expect([...groups].sort((a, b) => a - b)).toEqual(groups)
    // First command under Review is verify, the default.
    const firstCommand = lines.slice(groups[0]! + 1).find((l) => l.trim() !== '')
    expect(firstCommand?.trim()).toMatch(/^argus-reviewer verify\b/)
    for (const cmd of ['record', 'run', 'verify', 'code-review', 'mention', 'delegate', 'cache', 'index', 'init']) {
      expect(text).toContain(`argus-reviewer ${cmd}`)
    }
    expect(text).toContain('--json')
    expect(text).toContain('--no-color')
    expect(text).not.toContain('—')
  })

  it('fits 80 columns', async () => {
    const { text } = await help({}, { isTTY: false })
    for (const line of text.split('\n')) expect(line.length, line).toBeLessThanOrEqual(80)
  })
})

describe('summary block (R13, DESIGN 7.7)', () => {
  it('renders the mixed four-lane fixture in the comment grammar with spend against budget', () => {
    const lines = renderSummary(verifySummary(fixtureManifest(), 'reports/run-manifest.json'), createStyler(false), 80)
    expect(lines).toEqual([
      '⊘ failed   head abc1234   120.0s',
      '  ● review   2 findings                                          $0.004200',
      '  ⊘ flow     landing.test.ts: assertion failed                   $0.001500',
      '  ● app      expected state verified                             $0.000500',
      '  ◐ a0       delegation returned — self-reported                 unmetered',
      '  total $0.006200 of $4.00 budget · report reports/run-manifest.json',
    ])
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(80)
  })

  it('shows the budget-exceeded form with the config key to raise it', () => {
    const m = fixtureManifest()
    m.lanes.review.budget = { ...m.lanes.review.budget, limitUsd: 1, spentUsd: 1.02, exceeded: true }
    const text = renderSummary(verifySummary(m, 'r/run-manifest.json'), createStyler(false), 80).join('\n')
    expect(text).toContain('⊘ budget exceeded: spent $1.02 of $1.00 (review)')
    expect(text).toContain('codeReviewBudgetUsd')
  })

  it('truncates long lane detail to the terminal width and masks secrets', () => {
    const m = fixtureManifest()
    m.lanes.flow.reason = `token sk-or-abcdefghijkl leaked ${'x'.repeat(200)}`
    const lines = renderSummary(verifySummary(m, 'r.json'), createStyler(false), 80)
    const flow = lines.find((l) => l.includes(' flow '))!
    expect(flow.length).toBeLessThanOrEqual(80)
    expect(flow).toContain('…')
    expect(flow).not.toContain('sk-or-abcdefghijkl')

    const longPath = `argus-reviewer-report/${'nested/'.repeat(6)}run-manifest.json`
    const tail = renderSummary(verifySummary(fixtureManifest(), longPath), createStyler(false), 80).slice(-2)
    expect(tail).toEqual(['  total $0.006200 of $4.00 budget', `  report ${longPath}`])
  })

  it('colors glyphs only when styled', () => {
    const styled = renderSummary(verifySummary(fixtureManifest(), 'r.json'), createStyler(true), 120).join('\n')
    expect(styled).toContain(`${ESC}31m⊘`)
    expect(styled).toContain(`${ESC}32m●`)
  })
})

describe('run and verify plain output changes only where intended (characterization)', () => {
  it('verify ends with the summary block instead of the old lane lines', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'argus-sum-'))
    const out = capture()
    const err = capture()
    const code = await main(['verify', '--no-review'], { cwd, env: MIN_ENV, out: out.fn, err: err.fn })
    // Exit code unchanged from before U11 (all lanes off fails closed).
    expect(code).toBe(1)
    expect(out.lines).toEqual([
      expect.stringMatching(/^– skipped {3}\d+ms$/),
      '  total $0.000000 · report argus-reviewer-report/run-manifest.json',
    ])
    expect(err.lines.join('\n')).not.toContain('[')
  })

  it('run ends with the summary block; the earlier progress lines are unchanged', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'argus-sum-'))
    const out = capture()
    const code = await main(['run', '--url', 'http://127.0.0.1:9/'], { cwd, env: MIN_ENV, out: out.fn, err: capture().fn })
    expect(code).toBe(1)
    expect(out.lines[0]).toBe(`no test files found under ${join(cwd, 'tests')}`)
    expect(out.lines.slice(1)).toEqual([
      expect.stringMatching(/^⊘ failed {3}(head [0-9a-f]{7} {3})?\d+ms$/),
      '  ⊘ flow     0/0 tests passed                                    $0.000000',
      '  total $0.000000 · report argus-reviewer-report/run.json',
    ])
  })
})

describe('logger prefixes (DESIGN 7.7)', () => {
  it('plain: level word, no brackets', () => {
    const lines: string[] = []
    const log = createLogger('warn', { err: (l) => lines.push(l) })
    log.warn('careful')
    log.error('broken')
    expect(lines).toEqual(['warn: careful', 'error: broken'])
  })

  it('styled: dim warn, bold error', () => {
    const lines: string[] = []
    const log = createLogger('warn', { err: (l) => lines.push(l) }, undefined, createStyler(true))
    log.warn('careful')
    log.error('broken')
    expect(lines[0]).toBe(`${ESC}2mwarn${ESC}0m: careful`)
    expect(lines[1]).toBe(`${ESC}1merror${ESC}0m: broken`)
  })
})
