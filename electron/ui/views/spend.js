// Spend view (DESIGN.md 7.4): the ledger by model, lane and day, built from
// the same manifests the Runs view shows. Money uses tabular figures.
import { el, emptyState, table } from '../dom.js'
import { spendLedger, usd6, usdTotal, verifyRuns } from '../model.js'
import { renderPanel } from './panel.js'

function budgetLine(budgetUsd) {
  return Number.isFinite(budgetUsd)
    ? `Run budget: ${usd6(budgetUsd)} per run (argus-reviewer.config.ts).`
    : 'No run budget is set in argus-reviewer.config.ts; each lane keeps its own cap.'
}

function tally(spent, limit) {
  const ratio = limit > 0 ? spent / limit : 0
  const tone = ratio > 1 ? 'failed' : ratio >= 0.8 ? 'caution' : 'passed'
  const box = el('div', `tally tone-${tone}`)
  const ticks = el('span', 'ticks')
  ticks.setAttribute('aria-hidden', 'true')
  const on = Math.min(20, Math.round(ratio * 20))
  for (let i = 0; i < 20; i++) ticks.append(el('i', i < on ? 'on' : ''))
  box.append(ticks, el('span', 'data', `latest run spent ${usd6(spent)} of ${usd6(limit)}${ratio > 1 ? ' (exceeded)' : ''}`))
  return box
}

const ledgerRows = (rows) => rows.map((r) => [el('span', 'data', r.key), String(r.calls), usd6(r.costUsd)])

export function renderSpend(box, ctx) {
  const { panel, state } = ctx
  const runs = verifyRuns(state?.workspace ?? {})
  renderPanel(box, panel, {
    label: 'spend',
    retry: ctx.retry,
    empty: (b) =>
      b.append(
        emptyState({
          title: 'No spend recorded yet',
          body: budgetLine(state?.budgetUsd),
        }),
      ),
    ready: (b) => {
      const l = spendLedger(runs)
      const head = el('div', 'spend-head')
      const fig = el('div', 'figure-block')
      fig.append(
        el('span', 'figure', usdTotal(l.total)),
        el('span', 'dim', `across ${l.runs} run${l.runs === 1 ? '' : 's'} and ${l.calls} model call${l.calls === 1 ? '' : 's'}`),
      )
      head.append(fig)
      const side = el('div', 'spend-budget')
      if (Number.isFinite(state?.budgetUsd) && runs[0]) {
        side.append(tally(runs[0].aggregate?.costUsd ?? 0, state.budgetUsd))
      }
      side.append(el('p', 'dim', budgetLine(state?.budgetUsd)))
      head.append(side)
      b.append(head)
      const grid = el('div', 'ledger')
      for (const [title, rows] of [
        ['By model', l.byModel],
        ['By lane', l.byLane],
        ['By day', l.byDay],
      ]) {
        const sec = el('section', 'ledger-part')
        sec.append(el('h3', '', title))
        sec.append(table([title.slice(3).replace(/^./, (c) => c.toUpperCase()), 'Calls', 'Spend'], ledgerRows(rows), { numeric: [1, 2], caption: `Spend ${title.toLowerCase()}` }))
        grid.append(sec)
      }
      b.append(grid)
    },
  })
}
