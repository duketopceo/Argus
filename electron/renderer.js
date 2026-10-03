const $ = (id) => document.getElementById(id)
const el = (tag, cls, text) => {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}
const esc = (s) => String(s ?? '')

const ICON = { SUCCESS: ['✓','ok'], FAILURE: ['✗','bad'], fail: ['✗','bad'], PENDING: ['…','warn'], pending: ['…','warn'] }
const icon = (st, bucket) => {
  const [g, c] = ICON[st] || ICON[bucket] || ['·','dim']
  return el('span', c, g)
}

function renderPrs(s) {
  const d = $('prs'); d.replaceChildren()
  if (!s.prs.length) { d.append(el('div', 'dim', 'none open')); return }
  for (const p of s.prs) {
    const r = el('div', 'row')
    r.append(el('span', 'num', `#${p.number}`))
    r.append(el('span', 't', esc(p.title)))
    const v = p.reviewDecision === 'APPROVED' ? el('span','ok','approved')
      : p.reviewDecision === 'CHANGES_REQUESTED' ? el('span','bad','changes')
      : el('span','dim', esc(p.mergeStateStatus).toLowerCase())
    r.append(el('span', 'm')); r.lastChild.append(v, ' ', el('span','dim',esc(p.headRefName)))
    d.append(r)
    const checks = (s.prChecks[p.number] || []).slice(0, 6)
    if (checks.length) {
      const c = el('div', 'checks')
      for (const ck of checks) {
        const cr = el('div', 'row')
        cr.append(icon(ck.state, ck.bucket), el('span', 't', esc(ck.name)))
        c.append(cr)
      }
      d.append(c)
    }
  }
}

function renderRuns(s) {
  const d = $('runs'); d.replaceChildren()
  for (const r of s.runs) {
    const row = el('div', 'row')
    const ic = r.conclusion === 'success' ? el('span','ok','✓')
      : r.conclusion === 'failure' ? el('span','bad','✗')
      : ['in_progress','queued'].includes(r.status) ? el('span','warn','…') : el('span','dim','·')
    const age = Math.max(0, Math.round((Date.now() - new Date(r.createdAt).getTime()) / 60000))
    row.append(ic, el('span','t',esc(r.displayTitle)),
      el('span','m', `${esc(r.workflowName)} · ${esc(r.headBranch)} · ${age}m`))
    if (r.databaseId) {
      const btn = el('button', 'logs-btn', 'logs')
      btn.onclick = async () => {
        const res = await window.argus.runLogs(r.databaseId)
        if (!res.ok) liveAppend({ level: 'warn', source: 'gh', msg: res.msg })
      }
      row.append(btn)
    }
    d.append(row)
  }
  if (!s.runs.length) d.append(el('div','dim','no runs'))
}

function renderJournals(s) {
  const d = $('jhist'); d.replaceChildren()
  const js = s.journals || []
  if (!js.length) { d.append(el('div','dim','no journal entries')); return }
  for (const j of js.slice(-8)) {
    const r = el('div','row')
    r.append(el('span', j.ok ? 'ok' : 'bad', j.ok ? '✓' : '✗'),
      el('span','t', esc(j.runId)),
      el('span','m', `${j.steps} steps · $${(j.costUsd||0).toFixed(4)} · ${j.errors} err`))
    d.append(r)
  }
  // cost sparkline
  const cv = $('spark'), ctx = cv.getContext('2d')
  ctx.clearRect(0, 0, cv.width, cv.height)
  const costs = js.map(j => j.costUsd || 0)
  const max = Math.max(...costs, 1e-6)
  const w = cv.width / Math.max(costs.length - 1, 1)
  ctx.strokeStyle = '#39c5cf'; ctx.lineWidth = 1.5; ctx.beginPath()
  costs.forEach((c, i) => {
    const x = i * w, y = cv.height - 6 - (c / max) * (cv.height - 12)
    if (i) ctx.lineTo(x, y)
    else ctx.moveTo(x, y)
    ctx.fillStyle = js[i].ok ? '#3fb950' : '#f85149'
    ctx.fillRect(x - 2, y - 2, 4, 4)
  })
  ctx.stroke()
}

function renderJournal(s) {
  const d = $('journal'); d.replaceChildren()
  $('jfile').textContent = s.journalFile ? `(${s.journalFile})` : ''
  const j = s.journal
  if (!j) { d.append(el('div','dim','no journal entries')); return }
  const r = el('div','row')
  r.append(el('span','t', `run ${esc(j.runId)}`),
    el('span','m', `ok=${j.ok} · $${(j.costUsd||0).toFixed(4)}`))
  d.append(r)
  for (const e of (j.errors || []).slice(-6)) {
    const er = el('div','row')
    er.append(el('span','bad','err'), el('span','t', `${esc(e.phase)} ${esc(e.message ?? e)}`))
    d.append(er)
  }
}

// --- Verify workspace -------------------------------------------------------
// Run list + lane matrix + evidence inspector over the same
// run-manifest.json contract the comment and TUI render (R17). All rows are
// keyboard-selectable (arrows move, Enter/Space selects), focus is visible,
// and statuses render as text — never color alone.

// Lanes render from the collector's RunView projection (canonical order,
// statusIcon, durationMs, headBinding) — the raw manifest record is the
// stale-build fallback, kept so a missing dist/ still renders.
const LANE_ORDER = ['review', 'flow', 'app', 'a0']
const STATUS_CLS = {
  passed: 'ok', failed: 'bad', skipped: 'dim',
  blocked: 'warn', unavailable: 'warn', inconclusive: 'warn',
}
const STATUS_ICON = {
  passed: '✓', failed: '✗', skipped: '—',
  blocked: '⛔', unavailable: '⚠', inconclusive: '~',
}

let selRun = 0
let selLane = 0
let lastState
let lastVerifyKey = ''

const fmt$ = (n) => `$${(n ?? 0).toFixed(6)}`
const fmtMs = (ms) => (ms === undefined || !Number.isFinite(ms) ? '—' : ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`)

function lanesOf(run) {
  if (run?.view?.lanes !== undefined) return run.view.lanes
  return LANE_ORDER.map((id) => run.lanes?.[id]).filter(Boolean)
}

function laneIcon(l) {
  return l.statusIcon ?? STATUS_ICON[l.status] ?? '·'
}

function laneDuration(l) {
  if (l.durationMs !== undefined) return l.durationMs
  if (!l.startedAt || !l.finishedAt) return undefined
  const ms = Date.parse(l.finishedAt) - Date.parse(l.startedAt)
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined
}

/** Runs for the workspace — archived history newest-first, current merged in. */
function verifyRuns(ws) {
  const seen = new Set()
  const runs = []
  if (ws.current) { seen.add(ws.current.runId); runs.push(ws.current) }
  for (const r of [...(ws.runs || [])].reverse()) {
    if (r && !seen.has(r.runId)) { seen.add(r.runId); runs.push(r) }
  }
  return runs
}

function selectRun(i) {
  selRun = i
  selLane = 0
  renderVerify(lastState)
  const rows = $('veruns').querySelectorAll('.runrow')
  rows[Math.min(i, rows.length - 1)]?.focus()
}

function selectLane(i) {
  selLane = i
  renderVerify(lastState)
  const rows = $('velanes').querySelectorAll('.lanerow')
  rows[Math.min(i, rows.length - 1)]?.focus()
}

function rowKeys(row, i, count, select) {
  row.onkeydown = (e) => {
    if (e.key === 'ArrowDown' && i + 1 < count) { select(i + 1); e.preventDefault() }
    else if (e.key === 'ArrowUp' && i > 0) { select(i - 1); e.preventDefault() }
    else if (e.key === 'Enter' || e.key === ' ') { select(i); e.preventDefault() }
  }
}

function renderInspector(lane) {
  const d = $('vedetail')
  d.replaceChildren()
  if (!lane) { d.append(el('div', 'dim', 'select a lane')); return }
  const kv = (k, v) => {
    const r = el('div', 'row')
    r.append(el('span', 'k', k), el('span', 't', esc(v)))
    d.append(r)
  }
  kv('lane', lane.lane)
  kv('status', `${laneIcon(lane)} ${lane.status}`)
  if (lane.summary) kv('summary', lane.summary)
  if (lane.reason) kv('reason', lane.reason)
  const u = lane.usage || {}
  kv('usage', `${u.calls ?? 0} call(s) · ${u.metered === true ? fmt$(u.costUsd) : 'unmetered'} · ${u.tokens ?? 0}tok${u.provider ? ` · ${u.provider}` : ''}`)
  if (lane.model || u.model) kv('model', lane.model ?? u.model)
  kv('elapsed', fmtMs(laneDuration(lane) ?? lane.budget?.elapsedMs))
  const b = lane.budget
  if (b && (b.limitUsd !== undefined || b.maxDurationMs !== undefined || b.maxTasks !== undefined)) {
    const bits = []
    if (b.limitUsd !== undefined) bits.push(`limit ${fmt$(b.limitUsd)} / spent ${fmt$(b.spentUsd)}`)
    if (b.maxDurationMs !== undefined) bits.push(`clock ${fmtMs(b.elapsedMs)} / ${fmtMs(b.maxDurationMs)}`)
    if (b.maxTasks !== undefined) bits.push(`tasks ${b.tasks ?? 0} / ${b.maxTasks}`)
    kv('budget', `${bits.join(' · ')}${b.exceeded ? ' — EXCEEDED' : ''}`)
  }
  if (lane.cache) {
    const c = lane.cache
    kv('cache', `${c.hits ?? 0} hit · ${c.misses ?? 0} miss · ${c.heals ?? 0} heal · ${c.staleEntries ?? 0} stale`)
  }
  if (lane.headBinding) {
    kv('head', `${lane.headBinding.status} — ${lane.headBinding.detail ?? ''}`)
  }
  if (lane.reportPath) kv('evidence', lane.reportPath)
}

function renderVerify(s) {
  const ws = s.workspace || { runs: [] }
  $('wenote').textContent = ws.degraded
    ? `— ${ws.degraded}`
    : ws.corrupt > 0 ? `— ${ws.corrupt} manifest file(s) unreadable` : ''
  const runs = verifyRuns(ws)
  selRun = Math.min(selRun, Math.max(0, runs.length - 1))
  const rl = $('veruns')
  rl.replaceChildren()
  if (runs.length === 0) {
    rl.append(el('div', 'dim', 'no verify runs yet — argus-reviewer verify writes run-manifest.json'))
    $('velanes').replaceChildren()
    $('vedetail').replaceChildren()
    return
  }
  runs.forEach((r, i) => {
    const agg = r.aggregate || {}
    const row = el('div', 'runrow')
    row.setAttribute('role', 'option')
    row.setAttribute('aria-selected', i === selRun ? 'true' : 'false')
    row.tabIndex = 0
    row.append(
      el('span', STATUS_CLS[agg.status] || 'dim', `${r.view?.statusIcon ?? STATUS_ICON[agg.status] ?? '·'} ${esc(agg.status)}`),
      el('span', 'rid', esc(r.runId)),
      el('span', 'm', `${agg.calls ?? 0}c ${fmt$(agg.costUsd)}`),
    )
    row.onclick = () => selectRun(i)
    rowKeys(row, i, runs.length, selectRun)
    rl.append(row)
  })

  const run = runs[selRun]
  const lanesEl = $('velanes')
  lanesEl.replaceChildren()
  const lanes = lanesOf(run)
  const selected = lanes.filter((l) => l.selected)
  const skipped = lanes.filter((l) => !l.selected)
  selLane = Math.min(selLane, Math.max(0, selected.length - 1))
  selected.forEach((l, i) => {
    const row = el('div', 'lanerow')
    row.setAttribute('role', 'option')
    row.setAttribute('aria-selected', i === selLane ? 'true' : 'false')
    row.tabIndex = 0
    const u = l.usage || {}
    row.append(
      el('span', 'lid', l.lane),
      el('span', STATUS_CLS[l.status] || 'dim', `${laneIcon(l)} ${esc(l.status)}`),
      el('span', 't', esc(l.reason ?? l.summary ?? '')),
      el('span', 'm', `${u.calls ?? 0}c ${u.metered === true ? fmt$(u.costUsd) : 'unmetered'}`),
    )
    row.onclick = () => selectLane(i)
    rowKeys(row, i, selected.length, selectLane)
    lanesEl.append(row)
  })
  if (skipped.length) {
    lanesEl.append(el('div', 'dim', `skipped: ${skipped.map((l) => l.lane).join(', ')}`))
  }
  renderInspector(selected[selLane])
}

// Fingerprint the workspace so the 30s poll only rebuilds the verify DOM
// when the rendered data actually changed — a blind rebuild would destroy
// keyboard focus and wipe scroll positions every tick.
function verifyKey(ws) {
  const parts = [ws?.corrupt ?? 0, ws?.degraded ?? '']
  for (const r of verifyRuns(ws ?? { runs: [] })) {
    const a = r.aggregate ?? {}
    // Everything the pane renders must change the key: a same-runId manifest
    // rewrite that only moves cost/summary/headBinding must still repaint.
    parts.push(
      r.runId ?? '',
      r.finishedAt ?? '',
      a.status ?? '',
      a.calls ?? 0,
      a.costUsd ?? 0,
      a.tokens ?? 0,
    )
    for (const l of lanesOf(r)) {
      parts.push(
        l.status,
        l.durationMs ?? 0,
        l.selected ? 1 : 0,
        l.summary ?? '',
        l.reason ?? '',
        l.model ?? '',
        l.reportPath ?? '',
        l.headBinding ?? '',
        JSON.stringify(l.usage ?? null),
        JSON.stringify(l.budget ?? null),
        JSON.stringify(l.cache ?? null),
      )
    }
  }
  return parts.join('|')
}

async function refresh() {
  const s = await window.argus.collect()
  lastState = s
  $('updated').textContent = 'updated ' + new Date(s.updatedAt).toLocaleTimeString()
  $('err').textContent = s.error || ''
  renderPrs(s); renderRuns(s); renderJournals(s); renderJournal(s)
  const key = verifyKey(s.workspace)
  if (key !== lastVerifyKey) {
    // Mark only after a successful render — a render throw must not pin the
    // key and strand the pane on stale data.
    renderVerify(s)
    lastVerifyKey = key
  }
  $('evalfile').textContent = s.evalFile ? `(${s.evalFile})` : ''
  $('evaldoc').textContent = s.evalDoc || 'no docs/evals/*.md yet — run eval'
}

$('refresh').onclick = refresh
// "run eval" spends real OpenRouter credit, so it opens a confirm showing
// what will run, the estimated cost and the budget cap. Only the Run button
// starts the eval; Cancel, Esc and closing the dialog never do.
const evalLogNote = (cls, msg) => {
  $('evalcard').hidden = false
  $('evallog').append(el('div', cls, esc(msg)))
}
let confirmSeq = 0
async function openEvalConfirm() {
  const dlg = $('evalconfirm')
  const body = $('ecbody')
  const run = $('ecrun')
  const seq = ++confirmSeq
  run.disabled = true
  run.textContent = 'Run eval'
  body.replaceChildren(el('div', 'dim', 'Working out what will run...'))
  if (!dlg.open) dlg.showModal()
  $('eccancel').focus()
  let plan
  try {
    plan = await window.argus.evalPlan()
  } catch (e) {
    if (seq !== confirmSeq || !dlg.open) return
    body.replaceChildren(
      el('div', 'warn', `Could not work out the eval plan or its cost (${esc(e?.message ?? e)}).`),
      el('div', 'dim', 'The eval was not started. Close this and try again.'),
    )
    return
  }
  if (seq !== confirmSeq || !dlg.open) return
  body.replaceChildren(...plan.lines.map((l) =>
    el('div', /not set|^Note:|unknown/.test(l) ? 'warn' : '', esc(l))))
  if (plan.keyPresent) {
    run.disabled = false
    run.textContent = `Run eval (cap ${esc(plan.capLabel)})`
  }
}
function closeEvalConfirm() {
  confirmSeq++
  if ($('evalconfirm').open) $('evalconfirm').close()
  $('eval').focus()
}
$('eval').onclick = openEvalConfirm
$('eccancel').onclick = () => {
  closeEvalConfirm()
  evalLogNote('dim', 'eval cancelled, nothing was run')
}
// Esc fires 'cancel' on a modal dialog — same path as the Cancel button.
$('evalconfirm').addEventListener('cancel', (e) => {
  e.preventDefault()
  $('eccancel').click()
})
$('ecrun').onclick = async () => {
  if ($('ecrun').disabled) return
  closeEvalConfirm()
  $('evalcard').hidden = false
  $('evallog').replaceChildren()
  try {
    const res = await window.argus.runEval({ confirmed: true })
    if (!res?.ok) evalLogNote('warn', res?.msg ?? 'Eval did not start.')
  } catch (e) {
    evalLogNote('bad', `Eval did not start: ${esc(e?.message ?? e)}`)
  }
}
window.argus.onEvalLog(({ stream, line }) => {
  $('evalcard').hidden = false
  const d = $('evallog')
  d.append(el('div', stream === 'err' ? 'bad' : stream === 'done' ? 'warn' : '', esc(line)))
  while (d.childElementCount > 400) d.firstChild.remove()
  d.scrollTop = d.scrollHeight
  if (stream === 'done') refresh()
})

const LVL_CLS = { debug: 'dim', info: '', warn: 'warn', error: 'bad' }
function liveAppend(m) {
  const d = $('livelog')
  const t = new Date(m.ts ?? Date.now()).toLocaleTimeString()
  const row = el('div', 'row')
  row.append(
    el('span', 'm', t),
    el('span', 'lv', esc(m.source)),
    el('span', LVL_CLS[m.level] ?? '', `[${esc(m.level)}]`),
    el('span', 't', esc(m.msg ?? m.line)),
  )
  d.append(row)
  while (d.childElementCount > 400) d.firstChild.remove()
  d.scrollTop = d.scrollHeight
}
window.argus.onLiveLog(liveAppend)
window.argus.onRunLog(({ stream, line }) => {
  liveAppend({ ts: Date.now(), source: 'gh', level: stream === 'err' ? 'error' : stream === 'done' ? 'warn' : 'info', msg: line })
})

refresh()
setInterval(refresh, 30000)
