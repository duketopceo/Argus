import { describe, expect, it } from 'vitest'

import {
  classifyPanels,
  initialDesk,
  overallStatus,
  PANELS,
  reduceDesk,
  verifyRuns,
} from '../../electron/ui/states.js'

// Desk panel states (plan U13, R20, state diagram in High-Level Technical
// Design): Loading -> Ready | Empty | Error; Ready -> Partial | Stale.

type State = Record<string, unknown>

const run = (runId: string, status = 'passed') => ({
  runId,
  finishedAt: '2026-09-30T20:02:00.000Z',
  aggregate: { status, ok: status === 'passed', costUsd: 0.001, calls: 1, tokens: 10 },
  lanes: {},
})

const base = (over: State = {}): State => ({
  prs: [],
  prChecks: {},
  runs: [],
  evalDoc: '',
  evalFile: '',
  journals: [],
  heals: [],
  sources: { gh: { state: 'ok' }, journal: { state: 'ok' } },
  keyPresent: true,
  workspace: { reportDir: '/r', runs: [], current: undefined, corrupt: 0, degraded: undefined },
  updatedAt: '2026-09-30T20:05:00.000Z',
  ...over,
})

const filled = (over: State = {}): State =>
  base({
    workspace: { reportDir: '/r', runs: [run('r0')], current: run('r1', 'failed'), corrupt: 0 },
    prs: [{ number: 7, title: 't' }],
    runs: [{ databaseId: 1, status: 'completed', conclusion: 'success' }],
    evalDoc: '# eval\n',
    evalFile: '2026-09-30.md',
    journals: [{ runId: 'j', ok: true, costUsd: 0.01, steps: 1, errors: 0 }],
    heals: [{ runId: 'j', test: 't', instruction: 'click', model: 'm' }],
    ...over,
  })

const data = (state: State, at = 1000) => ({ type: 'data', state, at })

describe('reduceDesk', () => {
  it('starts every panel in Loading', () => {
    const desk = initialDesk()
    for (const p of PANELS) expect(desk.panels[p].status).toBe('loading')
  })

  it('maps no data to Empty on every panel', () => {
    const desk = reduceDesk(initialDesk(), data(base()))
    for (const p of PANELS) expect(desk.panels[p].status, p).toBe('empty')
  })

  it('maps a bridge rejection before any success to Error, with the message', () => {
    const desk = reduceDesk(initialDesk(), { type: 'reject', error: 'collect failed: EACCES', at: 5 })
    for (const p of PANELS) {
      expect(desk.panels[p].status, p).toBe('error')
      expect(desk.panels[p].error).toBe('collect failed: EACCES')
    }
    expect(desk.lastGood).toBeUndefined()
  })

  it('maps gh missing plus runs present to Partial, never an empty PR list', () => {
    const state = filled({ prs: [], runs: [], sources: { gh: { state: 'missing' }, journal: { state: 'ok' } } })
    const desk = reduceDesk(initialDesk(), data(state))
    expect(desk.panels.runs.status).toBe('ready')
    expect(desk.panels.prs.status).toBe('partial')
    expect(desk.panels.prs.reason).toBe('gh-missing')
    expect(desk.panels.workflows.status).toBe('partial')
    expect(desk.panels.workflows.reason).toBe('gh-missing')
    expect(overallStatus(desk)).toBe('partial')
  })

  it('names an unauthenticated gh separately from a missing one', () => {
    const state = filled({ sources: { gh: { state: 'unauthenticated' }, journal: { state: 'ok' } } })
    const desk = reduceDesk(initialDesk(), data(state))
    expect(desk.panels.prs.reason).toBe('gh-auth')
  })

  it('maps another gh failure to Error with its detail', () => {
    const state = filled({ sources: { gh: { state: 'error', detail: 'HTTP 502' }, journal: { state: 'ok' } } })
    const desk = reduceDesk(initialDesk(), data(state))
    expect(desk.panels.prs.status).toBe('error')
    expect(desk.panels.prs.error).toBe('HTTP 502')
  })

  it('maps a refresh failure after success to Stale, keeping last-good data and time', () => {
    const ok = reduceDesk(initialDesk(), data(filled(), 1000))
    const stale = reduceDesk(ok, { type: 'reject', error: 'timed out', at: 2000 })
    for (const p of PANELS) {
      expect(stale.panels[p].status, p).toBe('stale')
      expect(stale.panels[p].lastGoodAt).toBe(1000)
      expect(stale.panels[p].error).toBe('timed out')
    }
    expect(stale.lastGood).toBe(ok.lastGood)
    expect(overallStatus(stale)).toBe('stale')
  })

  it('Retry from Error goes back to Loading; Retry from Stale keeps the data', () => {
    const err = reduceDesk(initialDesk(), { type: 'reject', error: 'x', at: 1 })
    const retrying = reduceDesk(err, { type: 'retry' })
    expect(retrying.panels.runs.status).toBe('loading')

    const ok = reduceDesk(initialDesk(), data(filled(), 1000))
    const stale = reduceDesk(ok, { type: 'reject', error: 'x', at: 2000 })
    const r2 = reduceDesk(stale, { type: 'retry' })
    expect(r2.panels.runs.status).toBe('stale')
    expect(r2.panels.runs.retrying).toBe(true)
    expect(r2.lastGood).toBe(ok.lastGood)
  })

  it('Stale returns to Ready when a retry succeeds', () => {
    const ok = reduceDesk(initialDesk(), data(filled(), 1000))
    const stale = reduceDesk(ok, { type: 'reject', error: 'x', at: 2000 })
    const back = reduceDesk(stale, data(filled(), 3000))
    expect(back.panels.runs.status).toBe('ready')
    expect(back.panels.runs.error).toBeUndefined()
    expect(back.panels.runs.lastGoodAt).toBe(3000)
    expect(overallStatus(back)).toBe('ready')
  })

  it('Partial returns to Ready when the source recovers; Empty to Ready when data arrives', () => {
    const partial = reduceDesk(
      initialDesk(),
      data(filled({ sources: { gh: { state: 'missing' }, journal: { state: 'ok' } } })),
    )
    expect(reduceDesk(partial, data(filled())).panels.prs.status).toBe('ready')
    const empty = reduceDesk(initialDesk(), data(base()))
    expect(reduceDesk(empty, data(filled())).panels.runs.status).toBe('ready')
  })
})

describe('classifyPanels', () => {
  it('a corrupt newest manifest is Partial with the last valid run selected first', () => {
    const last = run('valid-last')
    const ws = {
      reportDir: '/r',
      runs: [run('older'), last],
      current: last,
      corrupt: 1,
      degraded: 'run-manifest.json unreadable, showing the last valid run',
    }
    const panels = classifyPanels(base({ workspace: ws }))
    expect(panels.runs.status).toBe('partial')
    expect(panels.runs.reason).toBe('manifest-unreadable')
    expect(verifyRuns(ws)[0].runId).toBe('valid-last')
    expect(verifyRuns(ws).map((r: { runId: string }) => r.runId)).toEqual(['valid-last', 'older'])
  })

  it('an unreadable manifest with no valid run left is Partial without data', () => {
    const ws = { reportDir: '/r', runs: [], current: undefined, corrupt: 1, degraded: 'run-manifest.json is unreadable' }
    const panels = classifyPanels(base({ workspace: ws }))
    expect(panels.runs.status).toBe('partial')
    expect(panels.runs.reason).toBe('manifest-unreadable')
    expect(panels.runs.hasData).toBe(false)
  })

  it('a missing key yields the no-key state on every panel that needs it', () => {
    const panels = classifyPanels(base({ keyPresent: false }))
    expect(panels.runs.status).toBe('nokey')
    expect(panels.evals.status).toBe('nokey')
    // Heals, spend and the gh panels do not need a model key.
    expect(panels.heals.status).toBe('empty')
    expect(panels.spend.status).toBe('empty')
    expect(panels.prs.status).toBe('empty')
  })

  it('a missing key never hides data that already exists', () => {
    const panels = classifyPanels(filled({ keyPresent: false }))
    expect(panels.runs.status).toBe('ready')
    expect(panels.evals.status).toBe('ready')
  })

  it('an unreadable journal makes Heals Partial, naming the file', () => {
    const panels = classifyPanels(
      filled({ sources: { gh: { state: 'ok' }, journal: { state: 'error', detail: '2026-09-30T20.json' } } }),
    )
    expect(panels.heals.status).toBe('partial')
    expect(panels.heals.reason).toBe('journal-unreadable')
    expect(panels.heals.detail).toBe('2026-09-30T20.json')
  })
})

describe('autoRetryDelay', async () => {
  const { autoRetryDelay } = await import('../../electron/ui/states.js')

  it('backs off 1s, 2s, 4s with jitter, then leaves it to Retry and the poll', () => {
    expect(autoRetryDelay(0, 0.5)).toBe(1000)
    expect(autoRetryDelay(1, 0.5)).toBe(2000)
    expect(autoRetryDelay(2, 0.5)).toBe(4000)
    expect(autoRetryDelay(3, 0.5)).toBeUndefined()
    expect(autoRetryDelay(0, 0)).toBe(800)
    expect(autoRetryDelay(0, 1)).toBe(1200)
  })
})
