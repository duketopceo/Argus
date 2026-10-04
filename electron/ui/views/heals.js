// Heals view (DESIGN.md 7.4): the review queue of steps the fingerprint
// cache re-located. First pass is read-only; accept/reject is the ceiling.
import { banner, el, emptyState, table } from '../dom.js'
import { ageSpan } from './runs.js'
import { renderPanel } from './panel.js'

export function renderHeals(box, ctx) {
  const { panel, state, now } = ctx
  const heals = state?.heals ?? []
  const ready = (b) => {
    const rows = heals.map((h) => [
      el('span', 'strong', h.test || 'unnamed test'),
      el('span', '', h.instruction),
      el('span', 'data', h.action || 'n/a'),
      el('span', 'data', h.model || 'n/a'),
      el('span', 'data', h.runId),
      ageSpan(h.at, now),
    ])
    b.append(table(['Test', 'Step', 'Action', 'Model', 'Run', 'Age'], rows, { caption: 'Healed steps, newest first' }))
  }
  renderPanel(box, panel, {
    label: 'heals',
    retry: ctx.retry,
    ready,
    empty: (b) =>
      b.append(
        emptyState({
          art: 'nothing-to-heal',
          title: 'No heals waiting',
          body: 'When a cached step stops matching the page and Argus re-locates it, the step lands here for review.',
        }),
      ),
    partial: (b) => {
      b.append(
        banner('caution', `Journal ${panel.detail ?? ''} is unreadable.`, {
          body: 'Its heals are missing below. The next run writes a fresh journal.',
        }),
      )
      if (heals.length) ready(b)
    },
  })
}
