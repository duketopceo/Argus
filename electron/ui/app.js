// Argus desk front end (plan U13, KTD9). Static files plus a data bridge:
// Electron's preload exposes `window.argus` today; a later `desk` command can
// serve these same files with an HTTP bridge. No framework: el() and
// textContent only, under the unchanged CSP.
import { $, announce, banner, button, el } from './dom.js'
import { KEYMAP, keyAction } from './keys.js'
import { formatAge, lanesOf, runStatus, verifyKey, verifyRuns } from './model.js'
import { autoRetryDelay, initialDesk, overallStatus, reduceDesk } from './states.js'
import { renderHeals } from './views/heals.js'
import { lastGoodClock } from './views/panel.js'
import { renderEvals, renderEvalStatus, renderJournals, renderPrs, renderWorkflows, sparkline } from './views/repo.js'
import { renderInspector, renderLanes, renderRunList } from './views/runs.js'
import { renderSpend } from './views/spend.js'

const bridge = window.argus
const POLL_MS = 30_000
const VIEWS = ['runs', 'heals', 'spend', 'repo']

let desk = initialDesk()
const ui = {
  view: 'runs',
  selRun: 0,
  selLane: 0,
  filter: '',
  sheet: false,
  sheetOrigin: undefined,
  keys: {},
  eval: { running: false },
  currentRunId: undefined,
}

const sheetMode = matchMedia('(max-width: 1100px)')
const phoneMode = matchMedia('(max-width: 720px)')

// --- data -------------------------------------------------------------------

const state = () => desk.lastGood
const now = () => Date.now()

function runsModel() {
  const all = verifyRuns(state()?.workspace ?? {})
  const f = ui.filter.trim().toLowerCase()
  const shown = f ? all.filter((r) => `${r.runId} ${runStatus(r)}`.toLowerCase().includes(f)) : all
  return { all, shown }
}

let inflight
let retryAttempt = 0
let retryTimer
function refresh() {
  if (inflight) return inflight
  clearTimeout(retryTimer)
  const btn = $('refresh')
  btn.setAttribute('aria-busy', 'true')
  btn.querySelector('.label').textContent = 'Refreshing…'
  inflight = (async () => {
    try {
      const s = await bridge.collect()
      retryAttempt = 0
      dispatch({ type: 'data', state: s, at: now() })
    } catch (e) {
      dispatch({ type: 'reject', error: e?.message ?? String(e), at: now() })
      // Transient failures retry on their own (1s, 2s, 4s), then wait for
      // Retry or the next poll.
      const wait = autoRetryDelay(retryAttempt++)
      if (wait !== undefined) retryTimer = setTimeout(refresh, wait)
    } finally {
      inflight = undefined
      btn.removeAttribute('aria-busy')
      btn.querySelector('.label').textContent = 'Refresh'
    }
  })()
  return inflight
}

// Loading over a second says how long it has taken (checklist A.3 2).
const started = now()
const loadingClock = setInterval(() => {
  const secs = Math.floor((now() - started) / 1000)
  if (desk.lastGoodAt !== undefined || desk.error !== undefined) return clearInterval(loadingClock)
  for (const n of document.querySelectorAll('.loading .elapsed')) {
    n.textContent = secs >= 1 ? `Reading the workspace and asking gh, ${secs}s so far` : ''
  }
}, 1000)

function retry() {
  retryAttempt = 0
  dispatch({ type: 'retry' })
  return refresh()
}

function dispatch(event) {
  const before = state()?.workspace?.current?.runId
  desk = reduceDesk(desk, event)
  if (event.type === 'data') {
    const after = event.state?.workspace?.current
    if (before !== undefined && after && after.runId !== before) {
      announce(`Run ${after.runId} finished: ${runStatus(after)}.`)
    }
  }
  render()
  // Capture harness and smoke wait on this: the first answer has landed.
  document.documentElement.dataset.desk = 'ready'
}

// --- render -----------------------------------------------------------------

/**
 * Re-render a region only when what it shows changed. Polls that return the
 * same data leave the DOM, focus and scroll untouched, and never replay
 * motion (DESIGN.md 6.5).
 */
function region(name, key, draw) {
  if (ui.keys[name] === key) return
  const focusKey = document.activeElement?.dataset?.key
  draw()
  ui.keys[name] = key
  if (focusKey) {
    const back = document.querySelector(`[data-key="${CSS.escape(focusKey)}"]`)
    if (back && document.activeElement !== back) back.focus({ preventScroll: true })
  }
}

const panelKey = (p) => JSON.stringify([p.status, p.was, p.reason, p.detail, p.error, p.retrying])

function render() {
  renderTopbar()
  const s = state()
  const runs = runsModel()
  const ws = s?.workspace
  ui.selRun = Math.min(ui.selRun, Math.max(0, runs.shown.length - 1))
  const run = runs.shown[ui.selRun]
  const lanes = run ? lanesOf(run) : []
  ui.selLane = Math.min(ui.selLane, Math.max(0, lanes.length - 1))
  const lane = lanes[ui.selLane]
  const ctx = { state: s, now: now(), retry, ui }
  const runsKey = `${panelKey(desk.panels.runs)}|${verifyKey(ws)}|${ui.filter}|${ui.selRun}`
  region('runlist', runsKey, () => {
    renderRunList({ ...ctx, panel: desk.panels.runs, runs, selectRun })
    $('view-runs').classList.toggle('no-runs', runs.all.length === 0 && desk.panels.runs.status !== 'loading')
  })
  region('lanes', `${runsKey}|${ui.selLane}`, () => {
    renderLanes({ ...ctx, run, selectLane })
    renderInspector({ ...ctx, lane })
  })
  region('heals', panelKey(desk.panels.heals) + JSON.stringify(s?.heals ?? null), () =>
    renderHeals($('heals'), { ...ctx, panel: desk.panels.heals }),
  )
  region('spend', `${panelKey(desk.panels.spend)}|${verifyKey(ws)}|${s?.budgetUsd}`, () =>
    renderSpend($('spend'), { ...ctx, panel: desk.panels.spend }),
  )
  region('prs', panelKey(desk.panels.prs) + JSON.stringify([s?.prs ?? null, s?.prChecks ?? null]), () =>
    renderPrs($('prs'), { ...ctx, panel: desk.panels.prs }),
  )
  region('workflows', panelKey(desk.panels.workflows) + JSON.stringify(s?.runs ?? null), () =>
    renderWorkflows($('workflows'), { ...ctx, panel: desk.panels.workflows, runLogs }),
  )
  region('evals', panelKey(desk.panels.evals) + (s?.evalFile ?? '') + (s?.evalDoc ?? ''), () => {
    $('evalfile').textContent = s?.evalFile ?? ''
    renderEvals($('evals'), { ...ctx, panel: desk.panels.evals, openEvalConfirm })
  })
  region('journals', JSON.stringify([s?.journals ?? null, s?.journal?.runId ?? null, s?.journalFile ?? null]), () => {
    $('jfile').textContent = s?.journalFile ?? ''
    renderJournals($('journals'), ctx)
  })
  renderEvalState()
  updateAges()
}

function renderTopbar() {
  const status = overallStatus(desk)
  const updated = $('updated')
  const b = $('banner')
  const stale = status === 'stale'
  const at = desk.lastGoodAt
  updated.textContent = at === undefined ? 'Loading' : stale ? `Last good ${lastGoodClock(at)}` : `Updated ${lastGoodClock(at)}`
  updated.dataset.tone = stale ? 'caution' : ''
  for (const tag of document.querySelectorAll('[data-asof]')) {
    tag.textContent = stale && at !== undefined ? `as of ${lastGoodClock(at)}` : ''
    tag.dataset.tone = stale ? 'caution' : ''
  }
  const key = `${status}|${desk.error}|${at}|${desk.panels.runs.retrying}`
  if (ui.keys.banner === key) return
  ui.keys.banner = key
  b.replaceChildren()
  if (stale) {
    b.append(
      banner('caution', `Refresh failed. Showing data from ${lastGoodClock(at)} (${formatAge(now() - at)} ago).`, {
        body: desk.error,
        action: button(desk.panels.runs.retrying ? 'Retrying' : 'Retry', { icon: 'refresh', onClick: retry }),
      }),
    )
    b.hidden = false
  } else b.hidden = true
}

/** Relative ages tick on each poll without re-rendering rows. */
function updateAges() {
  const t = now()
  for (const s of document.querySelectorAll('[data-age]')) {
    const ms = Date.parse(s.dataset.age)
    if (Number.isFinite(ms)) {
      const v = formatAge(t - ms)
      if (s.textContent !== v) s.textContent = v
    }
  }
}

// --- selection, panes and the inspector sheet -------------------------------

function focusRow(listId, i) {
  const rows = $(listId).querySelectorAll('[role="option"]')
  rows[Math.min(i, rows.length - 1)]?.focus()
}

// A click or tap only drills in where panes stack (phone); Enter always opens.
function selectRun(i, { open = false, tap = false, focus = true } = {}) {
  if (tap) open = phoneMode.matches
  const changed = i !== ui.selRun
  ui.selRun = i
  if (changed) ui.selLane = 0
  render()
  if (open && phoneMode.matches) return showPane('lanes')
  if (open) return focusRow('velanes', ui.selLane)
  if (focus) focusRow('veruns', i)
}

function selectLane(i, { open = false, tap = false, focus = true } = {}) {
  if (tap) open = sheetMode.matches
  ui.selLane = i
  render()
  if (focus) focusRow('velanes', i)
  if (open) openInspector()
}

function showPane(name) {
  $('view-runs').dataset.stack = name
  const heading = name === 'lanes' ? 'lanes-h' : 'runs-h'
  $(heading).focus()
}

const BACKGROUND = ['.skip', '.topbar', '#banner', '#pane-runs', '#pane-lanes', '#drawer', '.kbdbar']

function openInspector() {
  if (!sheetMode.matches) {
    $('insp-h').focus()
    return
  }
  ui.sheet = true
  ui.sheetOrigin = document.activeElement?.dataset?.key
  $('inspector').classList.add('open')
  $('inspector').setAttribute('role', 'dialog')
  $('inspector').setAttribute('aria-modal', 'true')
  for (const sel of BACKGROUND) document.querySelector(sel)?.setAttribute('inert', '')
  $('insp-h').focus()
}

function closeInspector({ restore = true } = {}) {
  if (!ui.sheet) return
  ui.sheet = false
  $('inspector').classList.remove('open')
  $('inspector').removeAttribute('role')
  $('inspector').removeAttribute('aria-modal')
  for (const sel of BACKGROUND) document.querySelector(sel)?.removeAttribute('inert')
  if (restore && ui.sheetOrigin) {
    document.querySelector(`[data-key="${CSS.escape(ui.sheetOrigin)}"]`)?.focus()
  }
}

// Tab stays inside the open sheet (the rest of the page is also inert).
$('inspector').addEventListener('keydown', (e) => {
  if (!ui.sheet || e.key !== 'Tab') return
  const items = [...$('inspector').querySelectorAll('a[href], button, input, [tabindex]:not([tabindex="-1"])')].filter(
    (n) => !n.disabled && n.offsetParent !== null,
  )
  if (items.length === 0) return
  const first = items[0]
  const last = items[items.length - 1]
  if (e.shiftKey && document.activeElement === first) {
    last.focus()
    e.preventDefault()
  } else if (!e.shiftKey && document.activeElement === last) {
    first.focus()
    e.preventDefault()
  }
})
$('inspector-close').addEventListener('click', () => closeInspector())
$('inspector-x').addEventListener('click', () => closeInspector())
for (const b of document.querySelectorAll('[data-back]')) {
  b.addEventListener('click', () => showPane(b.dataset.back))
}
sheetMode.addEventListener('change', () => {
  if (!sheetMode.matches) closeInspector({ restore: false })
})
phoneMode.addEventListener('change', () => {
  if (!phoneMode.matches) $('view-runs').dataset.stack = 'runs'
})

// Listbox rows: arrows move within the list, Enter/Space select.
function listKeys(listId, select) {
  $(listId).addEventListener('keydown', (e) => {
    const row = e.target.closest?.('[role="option"]')
    if (!row) return
    const i = Number(row.dataset.index)
    const n = $(listId).querySelectorAll('[role="option"]').length
    let next
    if (e.key === 'ArrowDown') next = Math.min(n - 1, i + 1)
    else if (e.key === 'ArrowUp') next = Math.max(0, i - 1)
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = n - 1
    else if (e.key === ' ') next = i
    if (next === undefined) return
    e.preventDefault()
    select(next)
  })
}
listKeys('veruns', (i) => selectRun(i))
listKeys('velanes', (i) => selectLane(i))

// --- views ------------------------------------------------------------------

function switchView(name, { focus = true } = {}) {
  if (!VIEWS.includes(name)) return
  ui.view = name
  for (const v of VIEWS) $(`view-${v}`).hidden = v !== name
  for (const t of document.querySelectorAll('.tab')) {
    if (t.dataset.view === name) t.setAttribute('aria-current', 'page')
    else t.removeAttribute('aria-current')
  }
  if (name !== 'runs') closeInspector({ restore: false })
  if (focus) $(`${name}-h`)?.focus()
  render()
  // A canvas drawn while hidden has no width; redraw it on show.
  const spark = document.querySelector('#journals canvas')
  if (name === 'repo' && spark) sparkline(spark, state()?.journals ?? [])
}
for (const t of document.querySelectorAll('.tab')) {
  t.addEventListener('click', () => switchView(t.dataset.view, { focus: false }))
}

$('filter').addEventListener('input', () => {
  ui.filter = $('filter').value
  ui.selRun = 0
  ui.selLane = 0
  render()
})

// --- keyboard ---------------------------------------------------------------

function toggleHelp() {
  const d = $('help')
  if (d.open) d.close()
  else d.showModal()
}

function buildHelp() {
  const dl = $('helpkeys')
  for (const k of KEYMAP) {
    const dt = el('dt')
    for (const key of k.keys) dt.append(el('kbd', '', key))
    dl.append(dt, el('dd', '', k.label))
  }
}

document.addEventListener('keydown', (e) => {
  const t = e.target
  const inField = Boolean(t?.matches?.('input, textarea, select, [contenteditable="true"]'))
  const dialogOpen = $('evalconfirm').open || $('help').open
  const action = keyAction(e, { inField, overlay: dialogOpen || ui.sheet })
  if (action === undefined) return
  if (dialogOpen) {
    // Native dialogs own Esc; `?` only toggles the help sheet itself.
    if (action === 'help' && $('help').open) {
      $('help').close()
      e.preventDefault()
    }
    return
  }
  const runsView = ui.view === 'runs'
  switch (action) {
    case 'close':
      if (ui.sheet) closeInspector()
      else if (inField && t.id === 'filter') {
        if (t.value) {
          t.value = ''
          ui.filter = ''
          render()
        } else focusRow('veruns', ui.selRun)
      } else if (phoneMode.matches && $('view-runs').dataset.stack === 'lanes') showPane('runs')
      else return
      break
    case 'help':
      toggleHelp()
      break
    case 'refresh':
      refresh()
      break
    case 'filter':
      if (!runsView) switchView('runs', { focus: false })
      if (phoneMode.matches) $('view-runs').dataset.stack = 'runs'
      $('filter').focus()
      break
    case 'next-run':
    case 'prev-run': {
      if (!runsView) return
      const n = runsModel().shown.length
      if (n === 0) return
      const i = Math.max(0, Math.min(n - 1, ui.selRun + (action === 'next-run' ? 1 : -1)))
      selectRun(i)
      break
    }
    case 'next-lane':
    case 'prev-lane': {
      if (!runsView) return
      const run = runsModel().shown[ui.selRun]
      const n = run ? lanesOf(run).length : 0
      if (n === 0) return
      if (phoneMode.matches) $('view-runs').dataset.stack = 'lanes'
      selectLane(Math.max(0, Math.min(n - 1, ui.selLane + (action === 'next-lane' ? 1 : -1))))
      break
    }
    case 'open': {
      const row = t?.closest?.('[role="option"]')
      if (!row) return
      if (row.classList.contains('runrow')) selectRun(Number(row.dataset.index), { open: true })
      else selectLane(Number(row.dataset.index), { open: true })
      break
    }
    default:
      return
  }
  e.preventDefault()
})

// --- spend confirm (PR #111) ------------------------------------------------
// "Run eval" spends real OpenRouter credit, so it opens a confirm showing
// what will run, the estimated cost and the budget cap. Only the Run button
// starts the eval; Cancel, Esc and closing the dialog never do.

const evalLogNote = (cls, msg) => {
  $('evallog').append(el('div', `logline ${cls}`, String(msg)))
}
let confirmSeq = 0
let confirmReturn
async function openEvalConfirm() {
  const dlg = $('evalconfirm')
  const body = $('ecbody')
  const run = $('ecrun')
  const seq = ++confirmSeq
  confirmReturn = document.activeElement
  run.disabled = true
  run.textContent = 'Run eval'
  body.replaceChildren(el('div', 'dim', 'Working out what will run…'))
  if (!dlg.open) dlg.showModal()
  $('eccancel').focus()
  let plan
  try {
    plan = await bridge.evalPlan()
  } catch (e) {
    if (seq !== confirmSeq || !dlg.open) return
    body.replaceChildren(
      el('div', 'tone-caution', `Could not work out the eval plan or its cost (${e?.message ?? e}).`),
      el('div', 'dim', 'The eval was not started. Close this and try again.'),
    )
    return
  }
  if (seq !== confirmSeq || !dlg.open) return
  body.replaceChildren(...plan.lines.map((l) => el('div', /not set|^Note:|unknown/.test(l) ? 'tone-caution' : '', l)))
  if (plan.keyPresent) {
    run.disabled = false
    run.textContent = `Run eval (cap ${plan.capLabel})`
  }
}
function closeEvalConfirm() {
  confirmSeq++
  if ($('evalconfirm').open) $('evalconfirm').close()
  const back = confirmReturn?.isConnected ? confirmReturn : $('eval')
  back.focus()
}
$('eval').addEventListener('click', openEvalConfirm)
$('eccancel').addEventListener('click', () => {
  closeEvalConfirm()
  evalLogNote('dim', 'eval cancelled, nothing was run')
})
// Esc fires 'cancel' on a modal dialog: same path as the Cancel button.
$('evalconfirm').addEventListener('cancel', (e) => {
  e.preventDefault()
  $('eccancel').click()
})
$('ecrun').addEventListener('click', async () => {
  if ($('ecrun').disabled) return
  closeEvalConfirm()
  $('evallog').replaceChildren()
  ui.eval = { running: true }
  renderEvalState()
  try {
    const res = await bridge.runEval({ confirmed: true })
    if (!res?.ok) {
      ui.eval = { running: false, failed: true, note: res?.msg ?? 'Eval did not start.' }
      evalLogNote('tone-caution', ui.eval.note)
    }
  } catch (e) {
    ui.eval = { running: false, failed: true, note: `Eval did not start: ${e?.message ?? e}` }
    evalLogNote('tone-failed', ui.eval.note)
  }
  renderEvalState()
})

function renderEvalState() {
  const key = JSON.stringify(ui.eval)
  if (ui.keys.evalstate === key) return
  ui.keys.evalstate = key
  renderEvalStatus($('evalstatus'), ui.eval, openEvalConfirm)
}

bridge.onEvalLog(({ stream, line }) => {
  const d = $('evallog')
  d.append(el('div', `logline${stream === 'err' ? ' tone-failed' : stream === 'done' ? ' tone-caution' : ''}`, String(line)))
  while (d.childElementCount > 400) d.firstChild.remove()
  d.scrollTop = d.scrollHeight
  if (stream === 'err') ui.eval.lastErr = String(line)
  if (stream === 'done') {
    const m = /exited (\S+)/.exec(String(line))
    const exit = m?.[1]
    ui.eval =
      exit === '0'
        ? { running: false }
        : { running: false, failed: true, exit, lastErr: ui.eval.lastErr, note: exit === undefined ? String(line) : undefined }
    renderEvalState()
    refresh()
  }
})

// --- live log drawer --------------------------------------------------------

const LVL_CLS = { debug: 'dim', info: '', warn: 'tone-caution', error: 'tone-failed' }
let liveCount = 0
function liveAppend(m) {
  const d = $('livelog')
  const t = new Date(m.ts ?? Date.now()).toLocaleTimeString()
  const row = el('div', 'logline fresh')
  row.append(
    el('span', 'ts', t),
    el('span', 'src', String(m.source ?? '')),
    el('span', LVL_CLS[m.level] ?? '', String(m.level ?? 'info')),
    el('span', 'msg', String(m.msg ?? m.line ?? '')),
  )
  const stick = d.scrollTop + d.clientHeight >= d.scrollHeight - 8
  d.append(row)
  while (d.childElementCount > 400) d.firstChild.remove()
  // Pause-on-scroll: only follow the tail when the reader is at the bottom.
  if (stick) d.scrollTop = d.scrollHeight
  liveCount++
  $('livecount').textContent = `${liveCount} line${liveCount === 1 ? '' : 's'}`
}

async function runLogs(id) {
  const res = await bridge.runLogs(id)
  $('drawer').open = true
  if (!res?.ok) liveAppend({ level: 'warn', source: 'gh', msg: res?.msg ?? 'logs unavailable' })
}

bridge.onLiveLog(liveAppend)
bridge.onRunLog(({ stream, line }) => {
  liveAppend({ ts: Date.now(), source: 'gh', level: stream === 'err' ? 'error' : stream === 'done' ? 'warn' : 'info', msg: line })
})

// --- start ------------------------------------------------------------------

$('refresh').addEventListener('click', () => refresh())
$('helpbtn').addEventListener('click', toggleHelp)
$('helpclose').addEventListener('click', () => $('help').close())
buildHelp()
render()
refresh()
setInterval(refresh, POLL_MS)
