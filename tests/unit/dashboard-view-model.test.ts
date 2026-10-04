import { describe, expect, it } from 'vitest'

import {
  formatDuration,
  formatUsd,
  isRunManifest,
  laneView,
  LANE_STATUS_LABEL,
  manifestToRunView,
  maskSecrets,
  shortSha,
  STATUS_GLYPH,
} from '../../src/report/viewmodel.js'
import { emptyLane, LANE_STATUSES } from '../../src/report/manifest.js'
import { fixtureLane, fixtureManifest } from '../fixtures/manifest.js'

describe('manifestToRunView', () => {
  it('projects the whole manifest — lanes in canonical order, run identity', () => {
    const view = manifestToRunView(fixtureManifest())
    expect(view.status).toBe('failed')
    expect(view.ok).toBe(false)
    expect(view.costUsd).toBeCloseTo(0.0062)
    expect(view.calls).toBe(8)
    expect(view.tokens).toBe(8000)
    expect(view.repo).toBe('owner/repo')
    expect(view.pr).toBe('42')
    expect(view.intendedHeadSha).toBe('abc1234deadbeef')
    expect(view.lanes.map((l) => l.lane)).toEqual(['review', 'flow', 'app', 'a0'])
    expect(view.selectedLanes.map((l) => l.lane)).toEqual(['review', 'flow', 'app', 'a0'])
    expect(view.headBinding?.status).toBe('match')
  })

  it('keeps per-lane usage, budget, cache, and head fields verbatim', () => {
    const view = manifestToRunView(fixtureManifest())
    const flow = view.lanes[1]!
    expect(flow.status).toBe('failed')
    expect(flow.statusLabel).toBe('failed')
    expect(flow.usage.costUsd).toBeCloseTo(0.0015)
    expect(flow.cache).toMatchObject({ hits: 2, misses: 1, heals: 1 })
    expect(flow.durationMs).toBe(30_000)
    const a0 = view.lanes[3]!
    expect(a0.usage.metered).toBe(false)
    expect(a0.budget.tasks).toBe(1)
    expect(view.headBinding?.status).toBe('match')
  })

  it('laneView tolerates missing timestamps and falls back to usage model', () => {
    const lane = laneView(
      fixtureLane('app', {
        model: undefined,
        usage: {
          provider: 'openrouter',
          model: 'm/x',
          calls: 1,
          tokens: 1,
          costUsd: 0.001,
          metered: true,
        },
      }),
    )
    expect(lane.durationMs).toBeUndefined()
    expect(lane.model).toBe('m/x')
  })
})

describe('status contract', () => {
  it('every lane status has a label and a glyph — no unmapped status', () => {
    for (const status of LANE_STATUSES) {
      expect(LANE_STATUS_LABEL[status]).toBe(status)
      expect(STATUS_GLYPH[status]).toBeTruthy()
    }
    expect(Object.keys(LANE_STATUS_LABEL).sort()).toEqual([...LANE_STATUSES].sort())
  })
})

describe('isRunManifest', () => {
  it('accepts a well-formed manifest and rejects partial/wrong shapes', () => {
    expect(isRunManifest(fixtureManifest())).toBe(true)
    expect(isRunManifest(undefined)).toBe(false)
    expect(isRunManifest(null)).toBe(false)
    expect(isRunManifest({})).toBe(false)
    expect(isRunManifest({ ...fixtureManifest(), schemaVersion: 2 })).toBe(false)
    const badLane = fixtureManifest()
    badLane.lanes.app = { ...badLane.lanes.app, status: 'passed-ish' as never }
    expect(isRunManifest(badLane)).toBe(false)
    const missingLane = fixtureManifest()
    // @ts-expect-error deliberately remove a lane
    delete missingLane.lanes.a0
    expect(isRunManifest(missingLane)).toBe(false)
    // A partially-written lane block fails closed, not half-rendered.
    const partial = fixtureManifest()
    partial.lanes.flow = { status: 'passed' } as never
    expect(isRunManifest(partial)).toBe(false)
  })

  it('rejects type-confused aggregate and lane fields renderers dereference', () => {
    const badStatus = fixtureManifest()
    badStatus.aggregate.status = 'bogus' as never
    expect(isRunManifest(badStatus)).toBe(false)
    const badOk = fixtureManifest()
    // @ts-expect-error type-confused field
    badOk.aggregate.ok = 'yes'
    expect(isRunManifest(badOk)).toBe(false)
    const badCost = fixtureManifest()
    badCost.aggregate.costUsd = 'expensive' as never
    expect(isRunManifest(badCost)).toBe(false)
    const nanCalls = fixtureManifest()
    nanCalls.aggregate.calls = NaN
    expect(isRunManifest(nanCalls)).toBe(false)
    // @ts-expect-error identity is required
    expect(isRunManifest({ ...fixtureManifest(), identity: undefined })).toBe(false)
    const badUsage = fixtureManifest()
    badUsage.lanes.review.usage.calls = 'many' as never
    expect(isRunManifest(badUsage)).toBe(false)
  })
})

describe('maskSecrets', () => {
  it('masks provider/git/npm token shapes inside evidence text', () => {
    expect(maskSecrets('key sk-or-v1-abcdef12345 leaked')).toBe('key ••• leaked')
    expect(maskSecrets('token ghp_abcdefghijklmnop')).toBe('token •••')
    expect(maskSecrets('github_pat_abcdefghijkl')).toBe('•••')
    expect(maskSecrets('xoxb-1234567890-abcdef')).toBe('•••')
    // Constructed at runtime — a literal AWS-shaped example key in the file
    // trips secret scanners even though it's the docs' canonical fake.
    expect(maskSecrets(`AKIA${'IOSFODNN7EXAMPLE'}`)).toBe('•••')
    expect(maskSecrets('npm_abcdefghijklmnopqrstuvwxyz')).toBe('•••')
    expect(maskSecrets('nothing secret here')).toBe('nothing secret here')
  })
})

describe('formatters', () => {
  it('formats money, durations, and shas consistently', () => {
    expect(formatUsd(0.0042)).toBe('$0.004200')
    expect(formatUsd(undefined)).toBe('$0.000000')
    expect(formatDuration(42_000)).toBe('42.0s')
    expect(formatDuration(120)).toBe('120ms')
    expect(formatDuration(undefined)).toBe('–')
    expect(shortSha('abc1234deadbeef')).toBe('abc1234')
    expect(shortSha(undefined)).toBeUndefined()
    expect(shortSha('')).toBeUndefined()
  })

  it('emptyLane view stays honest — skipped and unselected by default', () => {
    const lane = laneView(emptyLane('flow', false))
    expect(lane.status).toBe('skipped')
    expect(lane.selected).toBe(false)
    expect(lane.usage.metered).toBe(true)
  })
})

// Desk app formatting and derived views (plan U13, DESIGN.md 6.2, 7.4). The
// desk front end is plain browser ESM; these helpers stay DOM-free so they
// are tested here.
describe('desk view-model', async () => {
  const vm = await import('../../electron/ui/model.js')

  it('formats ages without ever printing 1366m', () => {
    expect(vm.formatAge(12_000)).toBe('12s')
    expect(vm.formatAge(3 * 60_000)).toBe('3m')
    expect(vm.formatAge(1366 * 60_000)).toBe('22h')
    expect(vm.formatAge(5 * 86_400_000)).toBe('5d')
    expect(vm.formatAge(-5)).toBe('0s')
  })

  it('formats durations per 6.2 and never uses an em-dash', () => {
    expect(vm.formatDuration(450)).toBe('450ms')
    expect(vm.formatDuration(12_300)).toBe('12.3s')
    expect(vm.formatDuration(245_000)).toBe('4m 05s')
    expect(vm.formatDuration(2 * 3600_000 + 14 * 60_000)).toBe('2h 14m')
    expect(vm.formatDuration(undefined)).toBe('n/a')
  })

  it('money: 6 decimals per lane, 4 for totals above a cent', () => {
    expect(vm.usd6(0.0042)).toBe('$0.004200')
    expect(vm.usdTotal(0.0042)).toBe('$0.004200')
    expect(vm.usdTotal(0.15)).toBe('$0.1500')
    expect(vm.usd6(undefined)).toBe('$0.000000')
  })

  it('middle-truncates run ids keeping the distinguishing suffix', () => {
    expect(vm.middleTruncate('short', 12)).toBe('short')
    const t = vm.middleTruncate('run-2026-09-30T20-14-21-abcd', 16)
    expect(t.length).toBe(16)
    expect(t.endsWith('abcd')).toBe(true)
    expect(t).toContain('…')
  })

  it('derives the spend ledger by model, lane and day from run lanes', () => {
    const runs = [
      {
        runId: 'a',
        startedAt: '2026-09-29T10:00:00.000Z',
        lanes: {
          review: { lane: 'review', selected: true, usage: { model: 'm/x', costUsd: 0.01, calls: 1, metered: true } },
          a0: { lane: 'a0', selected: true, usage: { model: undefined, costUsd: 0, calls: 0, metered: false } },
        },
      },
      {
        runId: 'b',
        startedAt: '2026-09-30T10:00:00.000Z',
        lanes: {
          review: { lane: 'review', selected: true, usage: { model: 'm/x', costUsd: 0.02, calls: 2, metered: true } },
          flow: { lane: 'flow', selected: true, usage: { model: 'm/y', costUsd: 0.005, calls: 1, metered: true } },
        },
      },
    ]
    const l = vm.spendLedger(runs)
    expect(l.total).toBeCloseTo(0.035)
    expect(l.calls).toBe(4)
    expect(l.byModel.map((r: { key: string }) => r.key)).toEqual(['m/x', 'm/y', 'unmetered'])
    expect(l.byModel[0].costUsd).toBeCloseTo(0.03)
    expect(l.byLane.map((r: { key: string }) => r.key)).toEqual(['review', 'flow', 'a0'])
    expect(l.byDay.map((r: { key: string }) => r.key)).toEqual(['2026-09-30', '2026-09-29'])
  })

  it('parses an eval doc into heading, text, table and list blocks', () => {
    const md = [
      '# argus-reviewer eval',
      '',
      'Budget cap: $1.00/run',
      '',
      '| Model | Cold pass | Cold cost |',
      '| --- | --- | --- |',
      '| `google/gemini` | 3/3 | $0.0014 |',
      '',
      '### Failures',
      '',
      '- `kimi` failed one',
    ].join('\n')
    const blocks = vm.parseEvalDoc(md)
    expect(blocks.map((b: { type: string }) => b.type)).toEqual(['heading', 'text', 'table', 'heading', 'list'])
    const table = blocks[2]
    expect(table.head).toEqual(['Model', 'Cold pass', 'Cold cost'])
    expect(table.rows).toEqual([['google/gemini', '3/3', '$0.0014']])
    expect(blocks[4].items).toEqual(['kimi failed one'])
  })

  it('a poll returning identical data yields an identical fingerprint', () => {
    const ws = { runs: [{ runId: 'a', aggregate: { status: 'passed' }, lanes: {} }], current: undefined, corrupt: 0 }
    expect(vm.verifyKey(ws)).toBe(vm.verifyKey(JSON.parse(JSON.stringify(ws))))
    const changed = { ...ws, corrupt: 1 }
    expect(vm.verifyKey(changed)).not.toBe(vm.verifyKey(ws))
  })

  it('status display: glyph id, word and tone for every status, running included', () => {
    for (const s of ['passed', 'failed', 'skipped', 'blocked', 'unavailable', 'inconclusive']) {
      const d = vm.statusDisplay(s)
      expect(d.glyph).toBe(`status-${s}`)
      expect(d.word).toBe(s)
    }
    expect(vm.statusDisplay('running')).toMatchObject({ glyph: 'running', word: 'running' })
    expect(vm.statusDisplay('weird').word).toBe('weird')
  })
})
