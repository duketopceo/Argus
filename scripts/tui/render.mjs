// Pure frame rendering for `npm run watch` (DESIGN.md 7.5, plan U12/R17).
// renderFrame(model, opts) returns the frame as an array of lines that never
// exceed `cols` cells and never exceed `rows` lines, with the key footer on
// the last row. No I/O here: watch.mjs owns collecting, keys and the screen.

import { LANE_STATUS_LABEL } from '../../dist/report/viewmodel.js'
import { formatEvalPlan } from '../eval-plan.mjs'

export const MIN_COLS = 72

const LANE_IDS = ['review', 'flow', 'app', 'a0']
const ANSI = /\x1b\[[0-9;]*m/g
const ANSI_AT = /^\x1b\[[0-9;]*m/

// --- formats (DESIGN.md 6.2) ------------------------------------------------

/** Relative age: `12s`, `3m`, `2h`, `5d`. Never `1366m`. */
export function formatAge(ms) {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

/** Duration: `450ms`, `12.3s`, `4m 05s`, `2h 14m`. */
export function formatDuration(ms) {
  if (ms === undefined || ms === null || !Number.isFinite(ms)) return ''
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const s = Math.floor(ms / 1000)
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`
}

const usd = (n) => `$${(Number.isFinite(n) ? n : 0).toFixed(6)}`
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

// --- cell width ---------------------------------------------------------------

// East Asian wide/fullwidth and emoji presentation take two cells. The
// Ocellus glyphs (Geometric Shapes, Math Operators) are single-cell.
const WIDE =
  /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{1F300}-\u{1F64F}\u{1F900}-\u{1F9FF}\u{20000}-\u{3FFFD}]/u
// Combining marks, zero-width spaces/joiners and variation selectors.
const isZeroWidth = (cp) =>
  (cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0xfe00 && cp <= 0xfe0f)

const cellWidth = (ch) => (isZeroWidth(ch.codePointAt(0)) ? 0 : WIDE.test(ch) ? 2 : 1)

/** Terminal cells a string occupies, ignoring SGR codes. */
export function visibleWidth(s) {
  let w = 0
  for (const ch of s.replace(ANSI, '')) w += cellWidth(ch)
  return w
}

/** Truncate to `cols` cells with an ellipsis, keeping SGR codes intact. */
export function fitLine(s, cols) {
  if (visibleWidth(s) <= cols) return s
  let out = ''
  let w = 0
  let styled = false
  let rest = s
  while (rest.length > 0) {
    const code = ANSI_AT.exec(rest)
    if (code) {
      out += code[0]
      styled = true
      rest = rest.slice(code[0].length)
      continue
    }
    const ch = String.fromCodePoint(rest.codePointAt(0))
    const cw = cellWidth(ch)
    if (w + cw > cols - 1) break
    out += ch
    w += cw
    rest = rest.slice(ch.length)
  }
  return `${out}…${styled ? '\x1b[0m' : ''}`
}

/** Word-wrap plain text to `width` cells, indenting every line. */
function wrap(text, width, indent = '  ') {
  const room = Math.max(10, width - visibleWidth(indent))
  const lines = []
  let line = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line === '') line = word
    else if (visibleWidth(line) + 1 + visibleWidth(word) <= room) line += ` ${word}`
    else {
      lines.push(indent + line)
      line = word
    }
  }
  if (line !== '') lines.push(indent + line)
  return lines
}

const padCells = (s, n) => s + ' '.repeat(Math.max(0, n - visibleWidth(s)))

/** `left` and `right` on one line, `right` flush to the right edge when it fits. */
function spread(left, right, cols) {
  const gap = cols - visibleWidth(left) - visibleWidth(right)
  return gap >= 2 ? `${left}${' '.repeat(gap)}${right}` : `${left}  ${right}`
}

// --- status words --------------------------------------------------------------

const statusLabel = (st, status, word = LANE_STATUS_LABEL[status] ?? status) =>
  `${st.glyph(status)} ${st.status(status, word)}`

function checkStatus(c) {
  if (c.state === 'SUCCESS' || c.bucket === 'pass') return ['passed', 'passed']
  if (c.state === 'FAILURE' || c.bucket === 'fail') return ['failed', 'failed']
  if (c.state === 'PENDING' || c.bucket === 'pending') return ['inconclusive', 'pending']
  return ['skipped', 'skipped']
}

function runStatus(r) {
  if (r.conclusion === 'success') return ['passed', 'passed']
  if (r.conclusion === 'failure' || r.conclusion === 'timed_out') return ['failed', 'failed']
  if (r.status === 'in_progress' || r.status === 'queued') return ['inconclusive', 'running']
  return ['skipped', r.conclusion || r.status || 'unknown']
}

const VERDICT = {
  needs_changes: ['failed', 'needs changes'],
  approve: ['passed', 'approve'],
  pass: ['passed', 'clean'],
}

// --- sections ------------------------------------------------------------------

const heading = (st, title, note = '') => `${st.bold(title)}${note ? st.dim(`  ${note}`) : ''}`

function laneRows(cur) {
  const viewLanes = cur.view?.lanes
  if (Array.isArray(viewLanes)) return viewLanes
  return LANE_IDS.map((id) => cur.lanes?.[id])
    .filter(Boolean)
    .map((l) => {
      const ms = Date.parse(l.finishedAt) - Date.parse(l.startedAt)
      return { ...l, durationMs: Number.isFinite(ms) && ms >= 0 ? ms : undefined }
    })
}

function verifySection(data, st, cols, now) {
  const ws = data?.workspace ?? { runs: [], corrupt: 0 }
  const cur = ws.current
  const out = []
  if (!cur) {
    out.push(heading(st, 'Verify'))
    out.push(st.dim('  No runs yet. argus-reviewer verify writes run-manifest.json here.'))
  } else {
    const id = cur.identity ?? {}
    const where = id.repo ? `${id.repo}${id.pr ? `#${id.pr}` : ''}` : ''
    const sha = (id.checkoutSha ?? id.intendedHeadSha ?? '').slice(0, 7)
    const when = Date.parse(cur.finishedAt ?? cur.startedAt)
    const note = [cur.runId, where, sha, Number.isFinite(when) ? `${formatAge(now - when)} ago` : '']
      .filter(Boolean)
      .join(' · ')
    out.push(heading(st, 'Verify', note))
    const row = (status, word, lane, calls, cost, dur, rest) =>
      `  ${padCells(statusLabel(st, status, word), 14)}  ${padCells(lane, 6)}  ` +
      `${padCells(calls, 8)}  ${padCells(cost, 9)}  ${padCells(dur, 6)}${rest ? `  ${rest}` : ''}`.trimEnd()
    const agg = cur.aggregate ?? {}
    const aggStatus = agg.status ?? 'inconclusive'
    out.push(row(aggStatus, undefined, st.bold('total'), plural(agg.calls ?? 0, 'call'), usd(agg.costUsd), '', ''))
    for (const lane of laneRows(cur)) {
      if (!lane.selected) {
        out.push(row('skipped', undefined, lane.lane, '', '', '', st.dim('not selected')))
        continue
      }
      const u = lane.usage ?? {}
      const cost = u.metered === true ? usd(u.costUsd) : 'unmetered'
      const hb = lane.headBinding
      const head = hb ? (hb.status === 'match' ? st.dim('head match') : st.role('caution', `head ${hb.status}`)) : ''
      const detail = lane.reason ?? lane.summary ?? ''
      // Below 100 columns a failure reason would be truncated away at the
      // row's end, so it gets its own line under the lane.
      const ownLine = cols < 100 && lane.reason && lane.status !== 'passed'
      const rest = [ownLine ? '' : detail, head, st.dim(lane.model ?? '')].filter(Boolean).join('  ')
      out.push(row(lane.status, undefined, lane.lane, plural(u.calls ?? 0, 'call'), cost, formatDuration(lane.durationMs), rest))
      if (ownLine) out.push(...wrap(lane.reason, cols, ' '.repeat(18)).slice(0, 2))
    }
    if (ws.runs?.length > 1) out.push(st.dim(`  ${ws.runs.length} runs in history`))
  }
  if (ws.degraded) out.push(st.role('caution', `  ${ws.degraded}`))
  else if (ws.corrupt > 0) out.push(st.role('caution', `  ${plural(ws.corrupt, 'manifest file')} unreadable, skipped`))
  return out
}

function reviewSection(data, st) {
  const rv = data?.review
  const out = [heading(st, 'Code review')]
  if (!rv) {
    out.push(st.dim('  No code review yet. argus-reviewer code-review writes code-review.json.'))
    return out
  }
  if (rv.skipped) {
    out.push(`  ${statusLabel(st, 'skipped')}`)
    return out
  }
  const [status, word] = VERDICT[rv.verdict] ?? ['inconclusive', rv.verdict || 'unknown']
  const parts = [
    statusLabel(st, status, word),
    plural(rv.findings ?? 0, 'finding'),
    usd(rv.costUsd),
    `${(rv.tokens ?? 0).toLocaleString('en-US')} tokens`,
  ]
  if (rv.budgetExceeded) parts.push(st.role('caution', 'budget exceeded'))
  if (rv.model) parts.push(st.dim(rv.model))
  out.push(`  ${parts.join('  ')}`)
  return out
}

const GH_MESSAGE = {
  missing: 'GitHub CLI not found. Install gh, then run gh auth login.',
  unauthenticated: 'GitHub CLI is not signed in. Run gh auth login.',
}

function githubSection(data, st, cols, now, maxPrs, maxRuns) {
  const out = [heading(st, 'Pull requests')]
  const gh = data?.sources?.gh ?? { state: 'ok' }
  if (gh.state !== 'ok') {
    const msg = GH_MESSAGE[gh.state] ?? `gh failed: ${gh.detail ?? 'unknown error'}. Retrying on the next refresh.`
    out.push(...wrap(msg, cols).map((l) => st.role('caution', l)))
    return out
  }
  const prs = data?.prs ?? []
  if (prs.length === 0) out.push(st.dim('  No open pull requests.'))
  for (const p of prs.slice(0, maxPrs)) {
    const counts = new Map()
    for (const c of data.prChecks?.[p.number] ?? []) {
      const [status, word] = checkStatus(c)
      const k = `${status}|${word}`
      counts.set(k, (counts.get(k) ?? 0) + 1)
    }
    const checks = [...counts]
      .map(([k, n]) => {
        const [status, word] = k.split('|')
        return `${st.glyph(status)} ${st.status(status, `${n} ${word}`)}`
      })
      .join('  ')
    const decision =
      p.reviewDecision === 'CHANGES_REQUESTED' ? st.role('failed', 'changes requested')
      : p.reviewDecision === 'APPROVED' ? st.role('passed', 'approved')
      : st.dim(String(p.mergeStateStatus ?? '').toLowerCase())
    const right = [checks, decision].filter((s) => visibleWidth(s) > 0).join('  ')
    const num = st.role('accent', `#${p.number}`)
    const room = cols - 2 - visibleWidth(num) - 2 - visibleWidth(right) - 2
    const title = room >= 12 ? fitLine(String(p.title ?? ''), room) : ''
    out.push(spread(`  ${num}  ${title}`, right, cols))
  }
  if (prs.length > maxPrs) out.push(st.dim(`  ${prs.length - maxPrs} more open`))

  out.push('', heading(st, 'Workflow runs'))
  const runs = data?.runs ?? []
  if (runs.length === 0) out.push(st.dim('  No workflow runs yet.'))
  for (const r of runs.slice(0, maxRuns)) {
    const [status, word] = runStatus(r)
    const age = Number.isFinite(Date.parse(r.createdAt)) ? `${formatAge(now - Date.parse(r.createdAt))} ago` : ''
    const meta = st.dim([r.workflowName, r.headBranch, age].filter(Boolean).join(' · '))
    out.push(`  ${padCells(statusLabel(st, status, word), 11)}  ${r.displayTitle ?? ''}  ${meta}`)
  }
  return out
}

function liveSection(model, st, now, max) {
  const out = [heading(st, 'Live')]
  const live = model.live ?? []
  if (live.length === 0) {
    out.push(st.dim('  Nothing yet. Argus commands stream progress here while they run.'))
  }
  for (const e of live.slice(-max)) {
    const age = padCells(formatAge(now - (Number(e.ts) || now)), 4)
    const name = padCells(String(e.source ?? ''), 11)
    const src = e.level === 'error' ? st.role('failed', name) : st.role('accent', name)
    out.push(`  ${st.dim(age)}  ${src}  ${e.msg}`)
  }
  const j = model.data?.journal
  if (j) {
    const status = j.ok ? 'passed' : 'failed'
    out.push(`  ${st.dim('last local run')}  ${statusLabel(st, status)}  ${j.runId ?? ''}  ${usd(j.costUsd)}`)
  }
  return out
}

/** Eval pane. `active` is true while running or after a result, so it moves up. */
function evalSection(model, st, cols, now) {
  const ev = model.eval ?? {}
  const out = [heading(st, 'Eval')]
  if (ev.running) {
    const since = ev.startedAt ? `started ${formatAge(now - ev.startedAt)} ago` : ''
    out.push(`  ${statusLabel(st, 'inconclusive', 'running')}  ${st.dim(since)}`)
    for (const l of (ev.log ?? []).slice(-6)) out.push(st.dim(`    ${l}`))
  } else if (ev.exit) {
    const x = ev.exit
    const spend =
      x.spendUsd === null || x.spendUsd === undefined
        ? 'spend so far unknown (none recorded; check OpenRouter)'
        : `spend so far ${usd(x.spendUsd)}`
    if (x.code === 0) {
      out.push(`  ${statusLabel(st, 'passed', 'finished')}  ${spend.replace(' so far', '')}`)
    } else {
      const how = x.code === null || x.code === undefined ? (x.signal ? `killed by ${x.signal}` : 'did not start') : `exited ${x.code}`
      out.push(`  ${statusLabel(st, 'failed')}  ${how}  ${spend}`)
      if (x.lastStderr) out.push(...wrap(`last error: ${x.lastStderr}`, cols))
      out.push(st.dim('  Press e to retry (it asks to confirm the spend again).'))
    }
  } else if (model.data?.evalFile) {
    out.push(`  ${st.dim('latest results')}  docs/evals/${model.data.evalFile}`)
    out.push(st.dim('  Press e to run the eval suite (it asks to confirm the spend first).'))
  } else {
    out.push(st.dim('  No eval results yet. Press e to run (it asks to confirm the spend first).'))
  }
  if (ev.note) out.push(...wrap(ev.note, cols).map((l) => st.dim(l)))
  return out
}

function confirmSection(plan, st, cols) {
  const out = []
  if (plan.keyPresent) {
    out.push(st.role('caution', st.bold(`Run eval against OpenRouter? budget $${plan.budgetUsd.toFixed(2)} per run [y/N]`)))
  } else {
    out.push(st.role('caution', st.bold('Eval cannot start: OPENROUTER_API_KEY is not set.')))
  }
  for (const l of formatEvalPlan(plan)) {
    const indent = l.startsWith('  ') ? '    ' : '  '
    out.push(...wrap(l, cols, indent))
  }
  out.push(st.role('caution', plan.keyPresent ? '  Press y to run the eval. n, Esc or Enter cancels.' : '  Press n or Esc to close.'))
  return out
}

function helpSection(st) {
  return [
    heading(st, 'Keys'),
    `  ${st.bold('r')}    refresh now`,
    `  ${st.bold('e')}    run the eval suite (shows the plan and estimate, runs only on y)`,
    `  ${st.bold('?')}    show or close this help`,
    `  ${st.bold('q')}    quit (Ctrl-C also quits)`,
    '',
    st.dim('  Refreshes every 30s. Respects NO_COLOR and FORCE_COLOR.'),
    st.dim('  Any key closes this help.'),
  ]
}

function footerLine(model, st) {
  const key = (k, label) => `${st.bold(k)} ${st.dim(label)}`
  if (model.overlay === 'help') return st.dim('any key closes help')
  if (model.eval?.confirm) {
    return model.eval.confirm.keyPresent
      ? [key('y', 'run eval'), key('n', 'cancel'), key('q', 'quit')].join('  ')
      : [key('n', 'close'), key('q', 'quit')].join('  ')
  }
  return [key('r', 'refresh'), key('e', 'eval…'), key('?', 'help'), key('q', 'quit')].join('  ')
}

function headerLine(model, st, cols, now) {
  const title = st.bold('argus watch')
  let status
  if (model.failure) {
    const retry = `retrying in ${formatAge(model.failure.retryInMs ?? 0)}`
    status = st.role(
      'caution',
      model.lastOkAt !== undefined ? `updated ${formatAge(now - model.lastOkAt)} ago, ${retry}` : `collect failed, ${retry}`,
    )
  } else if (model.lastOkAt !== undefined) {
    status = st.dim(`updated ${formatAge(now - model.lastOkAt)} ago`)
  } else {
    status = st.dim('loading')
  }
  return spread(title, status, cols)
}

// --- frame -----------------------------------------------------------------------

function bodyLines(model, st, cols, now, avail) {
  // Before the first collect, empty-state copy would claim "no runs" falsely.
  if (model.data === undefined && !model.failure) return [st.dim('  Reading local reports and gh...')]
  const top = []
  if (model.failure) top.push(...wrap(model.failure.error, cols).map((l) => st.role('caution', l)), '')
  if (model.eval?.confirm) top.push(...confirmSection(model.eval.confirm, st, cols), '')
  const evalActive = Boolean(model.eval?.running || model.eval?.exit || model.eval?.note)
  if (evalActive) top.push(...evalSection(model, st, cols, now), '')

  const rest = [
    ...verifySection(model.data, st, cols, now),
    '',
    ...reviewSection(model.data, st),
    '',
    ...githubSection(model.data, st, cols, now, 6, 4),
    '',
  ]
  const tail = evalActive ? [] : ['', ...evalSection(model, st, cols, now)]
  // Live takes whatever height is left (at least two entries).
  const used = top.length + rest.length + tail.length + 1
  const liveMax = Math.max(2, Math.min(12, avail - used - (model.data?.journal ? 1 : 0)))
  return [...top, ...rest, ...liveSection(model, st, now, liveMax), ...tail]
}

/**
 * One frame. `opts`: `{ cols, rows, style, now }`. Below MIN_COLS the frame
 * is a single line asking for a wider terminal.
 */
export function renderFrame(model, { cols, rows, style: st, now }) {
  if (cols < MIN_COLS) {
    return [fitLine(st.role('caution', `Terminal is ${cols} columns: widen to ${MIN_COLS} columns.`), cols)]
  }
  const rule = st.dim('─'.repeat(cols))
  const header = [headerLine(model, st, cols, now), rule]
  const footer = [rule, footerLine(model, st)]
  const avail = Math.max(1, rows - header.length - footer.length)
  let body = model.overlay === 'help' ? helpSection(st) : bodyLines(model, st, cols, now, avail)
  if (body.length > avail) {
    const hidden = body.length - avail + 1
    body = [...body.slice(0, avail - 1), st.dim(`  ${hidden} more lines below: make the terminal taller`)]
  }
  while (body.length < avail) body.push('')
  return [...header, ...body, ...footer].map((l) => fitLine(l, cols))
}

/** Non-TTY output: one plain snapshot, no footer, no height limit. */
export function renderSnapshot(model, { cols, style: st, now }) {
  const width = Math.max(cols, MIN_COLS)
  const lines = [headerLine(model, st, width, now), ...bodyLines(model, st, width, now, 1000)]
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return `${lines.map((l) => fitLine(l, width)).join('\n')}\n`
}
