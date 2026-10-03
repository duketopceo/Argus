// Runs view (home, DESIGN.md 7.4): run list | lane matrix | inspector over
// the run-manifest.json contract the comment and TUI render (R17). Rows keep
// listbox semantics (role=option, aria-selected) with roving tabindex.
import { $, banner, button, copyable, el, emptyState, GLYPHS, loadingRows, statusTag, use } from '../dom.js'
import {
  formatAge,
  formatDuration,
  laneDuration,
  lanesOf,
  middleTruncate,
  runStatus,
  usd6,
  usdTotal,
} from '../model.js'

const VERIFY_CMD = { text: 'argus-reviewer verify' }
const KEY_CMD = { text: 'export OPENROUTER_API_KEY=…', copy: 'export OPENROUTER_API_KEY=' }

const ageOf = (iso, now) => {
  const t = Date.parse(iso ?? '')
  return Number.isFinite(t) ? formatAge(now - t) : ''
}

/** A span whose text app.js refreshes each poll without a re-render. */
export function ageSpan(iso, now, cls = 'age') {
  const s = el('span', cls, ageOf(iso, now))
  if (iso) s.dataset.age = iso
  return s
}

function optionRow(cls, i, selected, label) {
  const row = el('div', cls)
  row.setAttribute('role', 'option')
  row.setAttribute('aria-selected', selected ? 'true' : 'false')
  row.tabIndex = selected ? 0 : -1
  row.dataset.index = String(i)
  if (label) row.setAttribute('aria-label', label)
  return row
}

/** Left pane: runs, or the panel state that stands in for them. */
export function renderRunList(ctx) {
  const { panel, runs, ui, now } = ctx
  const list = $('veruns')
  const note = $('runs-note')
  list.replaceChildren()
  note.replaceChildren()
  list.removeAttribute('aria-busy')
  $('runcount').textContent = runs.all.length ? String(runs.all.length) : ''

  if (panel.status === 'loading') {
    list.setAttribute('aria-busy', 'true')
    list.append(loadingRows('Loading runs'))
    return
  }
  if (panel.status === 'error') {
    note.append(
      banner('failed', 'Could not read the workspace.', {
        body: panel.error,
        action: button('Retry', { icon: 'refresh', onClick: ctx.retry }),
      }),
    )
    return
  }
  const showPartialBanner = panel.status === 'partial' || (panel.status === 'stale' && panel.was === 'partial')
  if (runs.all.length === 0) {
    if (panel.status === 'nokey' || (panel.status === 'stale' && panel.was === 'nokey')) {
      note.append(
        emptyState({
          art: 'no-key',
          title: 'No OpenRouter key set',
          body: 'Verify runs call a vision model. Export a key, then restart the desk.',
          command: KEY_CMD,
        }),
      )
    } else if (showPartialBanner) {
      note.append(
        emptyState({
          art: 'manifest-unreadable',
          title: 'The run manifest is unreadable',
          body: 'No valid run is left to show. Run verify again to regenerate it.',
          command: VERIFY_CMD,
        }),
      )
    } else {
      note.append(
        emptyState({
          art: 'no-runs',
          title: 'No verify runs yet',
          body: 'A verify run writes run-manifest.json, and it shows up here.',
          command: VERIFY_CMD,
        }),
      )
    }
    return
  }
  if (showPartialBanner) {
    const n = panel.corrupt ?? 0
    note.append(
      banner('caution', n === 1 ? '1 manifest file is unreadable.' : `${n} manifest files are unreadable.`, {
        body: panel.detail ? `${panel.detail}.` : 'Showing every run that still reads.',
        command: VERIFY_CMD.text,
      }),
    )
  }
  if (runs.shown.length === 0) {
    list.append(el('p', 'muted pad', `No runs match "${ui.filter}".`))
    return
  }
  runs.shown.forEach((r, i) => {
    const status = runStatus(r)
    const agg = r.aggregate ?? {}
    const row = optionRow('row runrow', i, i === ui.selRun, `${r.runId}, ${status}`)
    row.dataset.key = `run:${r.runId}`
    const id = el('span', 'rid data', middleTruncate(r.runId, 24))
    id.title = r.runId
    const meta = el('span', 'meta data')
    const calls = agg.calls ?? 0
    meta.append(`${calls} call${calls === 1 ? '' : 's'} · ${usdTotal(agg.costUsd)} · `, ageSpan(r.finishedAt ?? r.startedAt, now))
    const top = el('span', 'rowline')
    top.append(statusTag(status), id)
    row.append(top, meta)
    row.addEventListener('click', () => ctx.selectRun(i, { tap: true }))
    list.append(row)
  })
}

function laneLabel(l) {
  const box = el('span', 'lane-id')
  box.append(use(GLYPHS, `lane-${l.lane}`, 'glyph lane-glyph'), el('span', 'data', l.lane))
  return box
}

/** Center pane: run header plus the lane matrix. */
export function renderLanes(ctx) {
  const { run, ui, now } = ctx
  const list = $('velanes')
  const head = $('runhead')
  list.replaceChildren()
  head.replaceChildren()
  if (!run) {
    $('lanes-h').textContent = 'Lanes'
    // While the first answer is pending the run list carries the loading state.
    if (!ctx.loading) head.append(el('p', 'muted pad', 'Select a run to see its lanes.'))
    return
  }
  $('lanes-h').textContent = 'Lanes'
  const agg = run.aggregate ?? {}
  const idn = run.identity ?? {}
  const title = el('div', 'runhead-title')
  const rid = el('span', 'data strong', middleTruncate(run.runId, 40))
  rid.title = run.runId
  title.append(statusTag(runStatus(run)), rid)
  const facts = el('dl', 'facts')
  const fact = (k, v) => {
    const d = el('div')
    const dd = el('dd', 'data')
    if (v instanceof Node) dd.append(v)
    else dd.textContent = v
    d.append(el('dt', '', k), dd)
    facts.append(d)
  }
  if (idn.repo || idn.pr) fact('PR', `${idn.repo ?? ''}${idn.pr ? ` #${idn.pr}` : ''}`)
  if (idn.intendedHeadSha) fact('Head', String(idn.intendedHeadSha).slice(0, 7))
  fact('Spend', usdTotal(agg.costUsd))
  fact('Calls', String(agg.calls ?? 0))
  fact('Finished', ageSpan(run.finishedAt, now))
  head.append(title, facts)

  const lanes = lanesOf(run)
  lanes.forEach((l, i) => {
    const u = l.usage ?? {}
    const row = optionRow(`row lanerow${l.selected ? '' : ' unselected'}`, i, i === ui.selLane, `${l.lane} lane, ${l.status}`)
    row.dataset.key = `lane:${run.runId}:${l.lane}`
    const why = el('span', 'why', String(l.reason ?? l.summary ?? (l.selected ? '' : 'not selected for this run')))
    const meta = el(
      'span',
      'meta data',
      `${formatDuration(laneDuration(l))} · ${u.metered === false ? 'unmetered' : usd6(u.costUsd)}`,
    )
    row.append(laneLabel(l), statusTag(l.status), why, meta)
    row.addEventListener('click', () => ctx.selectLane(i, { tap: true }))
    list.append(row)
  })
}

function tally(spent, limit) {
  const ratio = limit > 0 ? spent / limit : 0
  const tone = ratio > 1 ? 'failed' : ratio >= 0.8 ? 'caution' : 'passed'
  const box = el('span', `tally tone-${tone}`)
  const ticks = el('span', 'ticks')
  ticks.setAttribute('aria-hidden', 'true')
  const on = Math.min(20, Math.round(ratio * 20))
  for (let i = 0; i < 20; i++) ticks.append(el('i', i < on ? 'on' : ''))
  box.append(ticks, el('span', 'data', `spent ${usd6(spent)} of ${usd6(limit)}${ratio > 1 ? ' (exceeded)' : ''}`))
  return box
}

/** Right pane: grouped key/value evidence for the selected lane. */
export function renderInspector(ctx) {
  const { lane } = ctx
  const d = $('vedetail')
  d.replaceChildren()
  $('insp-h').textContent = lane ? `Lane: ${lane.lane}` : 'Inspector'
  if (!lane) {
    if (!ctx.loading) d.append(el('p', 'muted pad', 'Select a lane to inspect its evidence.'))
    return
  }
  const group = (title) => {
    const g = el('section', 'kv-group')
    g.append(el('h3', '', title))
    const dl = el('dl', 'kv')
    g.append(dl)
    d.append(g)
    return (k, v) => {
      const row = el('div', 'kv-row')
      const dd = el('dd')
      if (v instanceof Node) dd.append(v)
      else dd.textContent = String(v ?? '')
      row.append(el('dt', '', k), dd)
      dl.append(row)
    }
  }
  const result = group('Result')
  result('lane', el('span', 'data', lane.lane))
  result('status', statusTag(lane.status))
  if (lane.summary) result('summary', lane.summary)
  if (lane.reason) result('reason', lane.reason)
  result('elapsed', el('span', 'data', formatDuration(laneDuration(lane) ?? lane.budget?.elapsedMs)))
  if (lane.model ?? lane.usage?.model) result('model', el('span', 'data', lane.model ?? lane.usage?.model))

  const u = lane.usage ?? {}
  const usage = group('Usage')
  usage('usage', el('span', 'data', `${u.calls ?? 0} calls · ${u.metered === false ? 'unmetered' : usd6(u.costUsd)} · ${u.tokens ?? 0} tokens`))
  if (u.provider) usage('provider', el('span', 'data', u.provider))

  const b = lane.budget
  if (b && (b.limitUsd !== undefined || b.maxDurationMs !== undefined || b.maxTasks !== undefined)) {
    const budget = group('Budget')
    if (b.limitUsd !== undefined) budget('budget', tally(b.spentUsd ?? 0, b.limitUsd))
    if (b.maxDurationMs !== undefined) budget('clock', el('span', 'data', `${formatDuration(b.elapsedMs)} of ${formatDuration(b.maxDurationMs)}`))
    if (b.maxTasks !== undefined) budget('tasks', el('span', 'data', `${b.tasks ?? 0} of ${b.maxTasks}`))
    if (b.exceeded) budget('limit', statusTag('failed', 'exceeded'))
  }
  if (lane.cache) {
    const c = lane.cache
    group('Cache')('cache', el('span', 'data', `${c.hits ?? 0} hit · ${c.misses ?? 0} miss · ${c.heals ?? 0} heal · ${c.staleEntries ?? 0} stale`))
  }
  if (lane.headBinding) {
    const h = lane.headBinding
    const tone = h.status === 'match' ? 'passed' : h.status === 'mismatch' ? 'caution' : 'muted'
    const badge = el('span', `head tone-${tone}`)
    badge.append(el('span', 'data strong', h.status), h.detail ? `: ${h.detail}` : '')
    group('Head')('head', badge)
  }
  const ev = group('Evidence')
  if (lane.reportPath) ev('evidence', copyable(lane.reportPath))
  else ev('evidence', el('span', 'muted', 'no report file for this lane'))
  const shots = lane.screenshots
  if (shots?.before && shots?.after) {
    const pair = el('div', 'shots')
    for (const [label, src] of [['before', shots.before], ['after', shots.after]]) {
      const fig = el('figure', 'shot')
      const img = el('img')
      img.src = src
      img.alt = `${lane.lane} lane screenshot, ${label}`
      img.loading = 'lazy'
      img.decoding = 'async'
      img.width = 320
      img.height = 200
      fig.append(img, el('figcaption', 'dim', label))
      pair.append(fig)
    }
    d.append(pair)
  }
}

