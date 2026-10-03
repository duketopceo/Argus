/* eslint-disable no-control-regex -- asserting on terminal escape sequences is the point */
import { describe, expect, it } from 'vitest'

import {
  MIN_COLS,
  formatAge,
  formatDuration,
  renderFrame,
  renderSnapshot,
  visibleWidth,
} from '../../scripts/tui/render.mjs'
import { reduceKey } from '../../scripts/tui/keys.mjs'
import { colorEnabled, createStyler } from '../../src/ui/style.js'
import { manifestToRunView, STATUS_GLYPH } from '../../src/report/viewmodel.js'
import { fixtureManifest } from '../fixtures/manifest.js'

const NOW = Date.parse('2026-10-03T12:00:00.000Z')
const COLOR = createStyler(true)
const PLAIN = createStyler(false)
const ANSI = /\x1b\[[0-9;]*m/g
const strip = (s: string): string => s.replace(ANSI, '')

function seededData(overrides: Record<string, unknown> = {}) {
  const m = fixtureManifest()
  return {
    prs: [
      { number: 118, title: 'feat(tui): alternate screen and diff redraw', reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN' },
      { number: 117, title: 'fix(cli): print --json errors on stdout', reviewDecision: 'CHANGES_REQUESTED', mergeStateStatus: 'BLOCKED' },
    ],
    prChecks: {
      118: [
        { name: 'test (22)', state: 'SUCCESS', bucket: 'pass' },
        { name: 'test (24)', state: 'SUCCESS', bucket: 'pass' },
        { name: 'lint', state: 'PENDING', bucket: 'pending' },
      ],
      117: [{ name: 'test (22)', state: 'FAILURE', bucket: 'fail' }],
    },
    runs: [
      { displayTitle: 'ci', status: 'completed', conclusion: 'success', workflowName: 'CI', headBranch: 'main', createdAt: new Date(NOW - 5 * 60_000).toISOString() },
      { displayTitle: 'release', status: 'in_progress', conclusion: '', workflowName: 'Release', headBranch: 'main', createdAt: new Date(NOW - 90_000).toISOString() },
    ],
    evalDoc: '',
    evalFile: '',
    journal: undefined,
    live: [],
    review: { skipped: false, verdict: 'needs_changes', findings: 3, costUsd: 0.004, tokens: 12000, model: 'deepseek/deepseek-v4.1-flash', budgetExceeded: false },
    workspace: { reportDir: '/x', runs: [m, m], current: { ...m, view: manifestToRunView(m) }, corrupt: 0, degraded: undefined },
    sources: { gh: { state: 'ok' } },
    error: '',
    ...overrides,
  }
}

function model(overrides: Record<string, unknown> = {}) {
  return {
    data: seededData(),
    lastOkAt: NOW - 12_000,
    failure: undefined,
    live: [
      { ts: NOW - 30_000, source: 'code-review', level: 'info', msg: 'reviewing 4 files' },
      { ts: NOW - 20_000, source: 'run', level: 'error', msg: 'flow lane failed' },
    ],
    eval: { running: false, startedAt: undefined, log: [], exit: undefined, note: '', confirm: undefined },
    overlay: undefined,
    ...overrides,
  }
}

const frame = (m: unknown, cols: number, rows = 40, style = COLOR) =>
  renderFrame(m, { cols, rows, style, now: NOW }) as string[]

describe('TUI frame rendering (R17)', () => {
  it.each([72, 100, 140])('never exceeds %i columns and keeps lanes in canonical order', (cols) => {
    const lines = frame(model(), cols)
    for (const l of lines) expect(visibleWidth(l), strip(l)).toBeLessThanOrEqual(cols)
    const plain = lines.map(strip)
    const at = (lane: string) => plain.findIndex((l) => new RegExp(`\\s${lane}\\s`).test(l))
    const order = ['review', 'flow', 'app', 'a0'].map(at)
    expect(order.every((i) => i > 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('fits the frame to the terminal height with the key footer on the last row', () => {
    const lines = frame(model(), 80, 20)
    expect(lines.length).toBeLessThanOrEqual(20)
    const last = strip(lines[lines.length - 1]!)
    expect(last).toContain('? help')
    expect(last).toContain('q quit')
    expect(last).toContain('e eval')
  })

  it('orders panes Verify, Code review, Pull requests, Live', () => {
    const plain = frame(model(), 120, 60).map(strip)
    const idx = ['Verify', 'Code review', 'Pull requests', 'Live'].map((h) =>
      plain.findIndex((l) => l.startsWith(h)),
    )
    expect(idx.every((i) => i >= 0)).toBe(true)
    expect([...idx].sort((a, b) => a - b)).toEqual(idx)
  })

  it('returns only the widen message below 72 columns', () => {
    const lines = frame(model(), 60)
    expect(lines).toHaveLength(1)
    expect(strip(lines[0]!)).toMatch(/widen to 72 columns/)
    expect(visibleWidth(lines[0]!)).toBeLessThanOrEqual(60)
    expect(MIN_COLS).toBe(72)
  })

  it('renders gh missing as its own message, not "none open"', () => {
    const m = model({ data: seededData({ prs: [], runs: [], sources: { gh: { state: 'missing' } } }) })
    const text = frame(m, 100).map(strip).join('\n')
    expect(text).toContain('GitHub CLI not found')
    expect(text).toContain('gh auth login')
    expect(text).not.toMatch(/none open/i)
  })

  it('renders gh signed-out as its own message', () => {
    const m = model({ data: seededData({ prs: [], runs: [], sources: { gh: { state: 'unauthenticated' } } }) })
    const text = frame(m, 100).map(strip).join('\n')
    expect(text).toMatch(/not signed in/)
    expect(text).toContain('gh auth login')
  })

  it('formats ages per DESIGN 6.2', () => {
    expect(formatAge(90_000)).toBe('1m')
    expect(formatAge(1366 * 60_000)).toBe('22h')
    expect(formatAge(5 * 86_400_000)).toBe('5d')
    expect(formatAge(12_000)).toBe('12s')
  })

  it('formats durations per DESIGN 6.2', () => {
    expect(formatDuration(450)).toBe('450ms')
    expect(formatDuration(12_340)).toBe('12.3s')
    expect(formatDuration(245_000)).toBe('4m 05s')
    expect(formatDuration(8_040_000)).toBe('2h 14m')
  })

  it('emits no ANSI color under NO_COLOR, and does with color on', () => {
    const style = createStyler(colorEnabled({ env: { NO_COLOR: '1', FORCE_COLOR: '1' }, isTTY: true }))
    expect(frame(model(), 100, 40, style).join('\n')).not.toMatch(/\x1b\[/)
    expect(frame(model(), 100, 40, COLOR).join('\n')).toMatch(/\x1b\[/)
  })

  it('uses the Ocellus glyphs, never emoji or the legacy icons', () => {
    const text = frame(model(), 120, 60).join('\n')
    expect(text).toContain(STATUS_GLYPH.failed)
    expect(text).toContain(STATUS_GLYPH.passed)
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u)
    // The em-dash in the a0 summary is fixture data; literals are linted by no-emoji.test.ts.
    expect(text).not.toMatch(/[⛔⚠✓✗]/)
  })

  it('shows empty states that say what to do next', () => {
    const empty = seededData({
      prs: [],
      runs: [],
      review: undefined,
      workspace: { reportDir: '/x', runs: [], current: undefined, corrupt: 0, degraded: undefined },
    })
    const text = frame(model({ data: empty, live: [] }), 100).map(strip).join('\n')
    expect(text).toMatch(/No runs yet/)
    expect(text).toMatch(/argus-reviewer verify/)
    expect(text).toMatch(/No open pull requests/)
    expect(text).toMatch(/No code review yet/)
  })

  it('keeps the last frame and says it is retrying when collect fails', () => {
    const m = model({
      lastOkAt: NOW - 4 * 60_000,
      failure: { error: 'collect failed: EMFILE', at: NOW - 1000, retryInMs: 60_000 },
    })
    const text = frame(m, 100).map(strip).join('\n')
    expect(text).toMatch(/updated 4m ago, retrying in 1m/)
    expect(text).toMatch(/EMFILE/)
    expect(text).toMatch(/\sflow\s/)
  })

  it('shows exit code, last stderr line and spend when an eval fails', () => {
    const m = model({
      eval: {
        running: false,
        startedAt: NOW - 60_000,
        log: ['starting', 'Error: budget exceeded'],
        exit: { code: 2, lastStderr: 'Error: budget exceeded', spendUsd: 0.0123 },
        note: '',
        confirm: undefined,
      },
    })
    const text = frame(m, 100, 60).map(strip).join('\n')
    expect(text).toMatch(/exited 2/)
    expect(text).toContain('Error: budget exceeded')
    expect(text).toContain('$0.012300')
    expect(text).toMatch(/e to retry/)
  })

  it('shows the spend confirm inline, near the top', () => {
    const plan = {
      command: 'node evals/run.mjs',
      models: [{ model: 'google/gemini-2.5-flash-lite', lastCostUsd: 0.02, lastRunAt: 'x' }],
      budgetUsd: 1,
      capUsd: 2,
      runsPerModel: 2,
      cases: 5,
      estimateUsd: 0.02,
      estimatePartial: false,
      keyPresent: true,
      error: undefined,
    }
    const lines = frame(model({ eval: { ...model().eval, confirm: plan } }), 80, 24).map(strip)
    const ask = lines.findIndex((l) => l.includes('Run eval against OpenRouter?'))
    expect(ask).toBeGreaterThan(0)
    expect(lines[ask]).toContain('[y/N]')
    expect(lines.join('\n')).toContain('Budget cap: $1.00 per run')
    for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(80)
  })

  it('lists every key in the help overlay', () => {
    const text = frame(model({ overlay: 'help' }), 80, 30).map(strip).join('\n')
    for (const k of ['r', 'e', '\\?', 'q']) expect(text).toMatch(new RegExp(`^\\s+${k}\\s`, 'm'))
  })

  it('a non-TTY snapshot is plain, unclipped and has no footer', () => {
    const out = renderSnapshot(model(), { cols: 100, style: PLAIN, now: NOW }) as string
    expect(out).not.toMatch(/\x1b/)
    expect(out).not.toContain('q quit')
    expect(out.endsWith('\n')).toBe(true)
    expect(out).toContain('Verify')
  })

  it('counts wide characters as two cells when truncating', () => {
    const m = model({
      data: seededData({ prs: [{ number: 1, title: '漢字'.repeat(60), reviewDecision: '', mergeStateStatus: 'CLEAN' }] }),
    })
    for (const l of frame(m, 72)) expect(visibleWidth(l)).toBeLessThanOrEqual(72)
    expect(visibleWidth('漢a')).toBe(3)
  })
})

describe('TUI key handling keeps the spend confirm (PR #111)', () => {
  const plan = { keyPresent: true }
  const base = () => model().eval
  const ui = (ev = base(), overlay: string | undefined = undefined) => ({ eval: ev, overlay })
  const openPlan = () => plan

  it('e opens the confirm and never spends by itself', () => {
    const r = reduceKey(ui(), 'e', { evalPlan: openPlan })
    expect(r.effect).toBeUndefined()
    expect(r.ui.eval.confirm).toBe(plan)
  })

  it('only y runs the eval', () => {
    const open = reduceKey(ui(), 'e', { evalPlan: openPlan }).ui
    expect(reduceKey(open, 'y', { evalPlan: openPlan }).effect).toBe('run-eval')
    expect(reduceKey(open, 'Y', { evalPlan: openPlan }).effect).toBe('run-eval')
    for (const k of ['n', '\x1b', '\r', 'q', 'r']) {
      const r = reduceKey(open, k, { evalPlan: openPlan })
      expect(r.effect, k).not.toBe('run-eval')
    }
  })

  it('n, Esc and Enter cancel with a note', () => {
    const open = reduceKey(ui(), 'e', { evalPlan: openPlan }).ui
    for (const k of ['n', '\x1b', '\r']) {
      const r = reduceKey(open, k, { evalPlan: openPlan })
      expect(r.ui.eval.confirm).toBeUndefined()
      expect(r.ui.eval.note).toMatch(/cancelled, nothing was run/)
    }
  })

  it('e does nothing while an eval runs', () => {
    const r = reduceKey(ui({ ...base(), running: true }), 'e', { evalPlan: openPlan })
    expect(r.ui.eval.confirm).toBeUndefined()
  })

  it('retry after a failure reopens the confirm', () => {
    const failed = ui({ ...base(), exit: { code: 1, lastStderr: 'x', spendUsd: 0 } })
    const r = reduceKey(failed, 'e', { evalPlan: openPlan })
    expect(r.ui.eval.confirm).toBe(plan)
    expect(r.effect).toBeUndefined()
  })

  it('? toggles help, any key closes it, q and r map to effects', () => {
    const h = reduceKey(ui(), '?', { evalPlan: openPlan }).ui
    expect(h.overlay).toBe('help')
    const closed = reduceKey(h, 'x', { evalPlan: openPlan })
    expect(closed.ui.overlay).toBeUndefined()
    expect(closed.effect).toBeUndefined()
    expect(reduceKey(ui(), 'q', { evalPlan: openPlan }).effect).toBe('quit')
    expect(reduceKey(ui(), '\u0003', { evalPlan: openPlan }).effect).toBe('quit')
    expect(reduceKey(ui(), 'r', { evalPlan: openPlan }).effect).toBe('refresh')
  })
})

describe('TUI before the first collect', () => {
  it('says it is loading instead of showing empty states', () => {
    const lines = renderFrame(
      { data: undefined, lastOkAt: undefined, failure: undefined, live: [], eval: { running: false, log: [], note: '' }, overlay: undefined },
      { cols: 80, rows: 24, style: createStyler(false), now: 0 },
    ) as string[]
    const text = lines.join('\n')
    expect(text).toContain('loading')
    expect(text).not.toMatch(/No runs yet|No open pull requests/)
  })
})
