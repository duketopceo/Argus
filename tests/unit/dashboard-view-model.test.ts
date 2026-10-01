import { describe, expect, it } from 'vitest'

import {
  formatDuration,
  formatUsd,
  isRunManifest,
  laneView,
  LANE_STATUS_EMOJI,
  LANE_STATUS_ICON,
  LANE_STATUS_LABEL,
  manifestToRunView,
  maskSecrets,
  shortSha,
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
  it('every lane status has a label, icon, and emoji — no unmapped status', () => {
    for (const status of LANE_STATUSES) {
      expect(LANE_STATUS_LABEL[status]).toBe(status)
      expect(LANE_STATUS_ICON[status]).toBeTruthy()
      expect(LANE_STATUS_EMOJI[status]).toBeTruthy()
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
    expect(formatDuration(undefined)).toBe('—')
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
