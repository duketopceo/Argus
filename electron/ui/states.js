// Desk panel data states (plan U13, R20). Every panel follows one diagram:
//
//   Loading -> Ready | Empty | Error (bridge rejects)
//   Ready   -> Partial (a source fails: gh missing, corrupt manifest)
//   Ready   -> Stale   (a refresh fails after a success; last-good kept)
//   Stale   -> Ready   (retry succeeds)      Error -> Loading (Retry)
//
// Pure: no DOM. Tested in tests/unit/desk-states.test.ts.
import { verifyRuns } from './model.js'

export { verifyRuns }

/** Panels in the desk, by view: Runs (runs), Heals, Spend, Repo (prs, workflows, evals). */
export const PANELS = ['runs', 'heals', 'spend', 'prs', 'workflows', 'evals']

const GH_REASON = { missing: 'gh-missing', unauthenticated: 'gh-auth' }

function ghPanel(gh, hasData) {
  const reason = GH_REASON[gh?.state]
  if (reason) return { status: 'partial', reason, hasData: false }
  if (gh?.state === 'error') return { status: 'error', error: gh.detail || 'gh failed', detail: gh.detail || 'gh failed' }
  return { status: hasData ? 'ready' : 'empty', hasData }
}

/** What each panel shows for one successful collect. */
export function classifyPanels(state) {
  const ws = state?.workspace ?? {}
  const runs = verifyRuns(ws)
  const keyPresent = state?.keyPresent !== false
  const gh = state?.sources?.gh
  const journal = state?.sources?.journal

  let runsPanel
  if (ws.corrupt > 0 || ws.degraded) {
    runsPanel = { status: 'partial', reason: 'manifest-unreadable', detail: ws.degraded, corrupt: ws.corrupt ?? 0, hasData: runs.length > 0 }
  } else if (runs.length > 0) runsPanel = { status: 'ready', hasData: true }
  else runsPanel = { status: keyPresent ? 'empty' : 'nokey', hasData: false }

  const heals = state?.heals ?? []
  const healsPanel =
    journal?.state === 'error'
      ? { status: 'partial', reason: 'journal-unreadable', detail: journal.detail, hasData: heals.length > 0 }
      : { status: heals.length > 0 ? 'ready' : 'empty', hasData: heals.length > 0 }

  const spendRows = runs.length > 0
  const evals = Boolean(state?.evalDoc)

  return {
    runs: runsPanel,
    heals: healsPanel,
    spend: { status: spendRows ? 'ready' : 'empty', hasData: spendRows },
    prs: ghPanel(gh, (state?.prs ?? []).length > 0),
    workflows: ghPanel(gh, (state?.runs ?? []).length > 0),
    evals: { status: evals ? 'ready' : keyPresent ? 'empty' : 'nokey', hasData: evals },
  }
}

export function initialDesk() {
  return {
    panels: Object.fromEntries(PANELS.map((p) => [p, { status: 'loading' }])),
    lastGood: undefined,
    lastGoodAt: undefined,
    error: undefined,
  }
}

/**
 * Fold one bridge event into the desk:
 *   { type: 'data', state, at }   a collect resolved
 *   { type: 'reject', error, at } a collect rejected
 *   { type: 'retry' }             the user pressed Retry
 */
export function reduceDesk(prev, event) {
  if (event.type === 'data') {
    const classified = classifyPanels(event.state)
    const panels = {}
    for (const p of PANELS) panels[p] = { ...classified[p], lastGoodAt: event.at }
    return { panels, lastGood: event.state, lastGoodAt: event.at, error: undefined }
  }
  if (event.type === 'reject') {
    const error = String(event.error ?? 'refresh failed')
    const panels = {}
    for (const p of PANELS) {
      const before = prev.panels[p]
      panels[p] =
        prev.lastGood !== undefined
          ? { ...before, status: 'stale', was: before.was ?? before.status, error, retrying: false, lastGoodAt: prev.lastGoodAt }
          : { status: 'error', error }
    }
    return { ...prev, panels, error }
  }
  if (event.type === 'retry') {
    const panels = {}
    for (const p of PANELS) {
      const before = prev.panels[p]
      panels[p] =
        before.status === 'stale'
          ? { ...before, retrying: true }
          : before.status === 'error' && prev.lastGood === undefined
            ? { status: 'loading' }
            : before
    }
    return { ...prev, panels }
  }
  return prev
}

const RANK = { error: 4, stale: 3, partial: 2, loading: 1, nokey: 0, empty: 0, ready: 0 }

/** Worst state across panels, for the top-bar status. */
export function overallStatus(desk) {
  let worst = 'ready'
  for (const p of PANELS) {
    const s = desk.panels[p].status
    if (RANK[s] > RANK[worst]) worst = s
  }
  return worst
}
