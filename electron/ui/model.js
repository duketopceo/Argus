// Desk view-model: pure, DOM-free helpers over the collector state
// (scripts/collect.mjs). Tested in tests/unit/dashboard-view-model.test.ts.
// Formats follow DESIGN.md 6.2: ages `3m`, durations `4m 05s`, money with 6
// decimals per lane and 4 for totals above a cent. No em-dash in copy.

export const LANE_ORDER = ['review', 'flow', 'app', 'a0']
export const STATUSES = ['passed', 'failed', 'skipped', 'blocked', 'unavailable', 'inconclusive']

// Tone drives color only; the glyph shape and the word carry the meaning.
const TONE = {
  passed: 'passed',
  failed: 'failed',
  inconclusive: 'caution',
  blocked: 'ink',
  unavailable: 'muted',
  skipped: 'muted',
  running: 'accent',
}

/** Glyph id (sprite symbol), word and color tone for a status. */
export function statusDisplay(status) {
  const s = String(status ?? '')
  if (s === 'running') return { glyph: 'running', word: 'running', tone: TONE.running }
  if (STATUSES.includes(s)) return { glyph: `status-${s}`, word: s, tone: TONE[s] }
  return { glyph: 'status-unavailable', word: s || 'unknown', tone: 'muted' }
}

/** Relative age: `12s`, `3m`, `2h`, `5d`. Never `1366m`. */
export function formatAge(ms) {
  const s = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

/** Duration: `450ms`, `12.3s`, `4m 05s`, `2h 14m`. */
export function formatDuration(ms) {
  if (ms === undefined || ms === null || !Number.isFinite(ms)) return 'n/a'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const s = Math.floor(ms / 1000)
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`
}

const num = (n) => (Number.isFinite(n) ? n : 0)
/** Per-call and per-lane money: 6 decimals. */
export const usd6 = (n) => `$${num(n).toFixed(6)}`
/** Totals: 4 decimals above a cent, else 6 so small spend stays visible. */
export const usdTotal = (n) => (num(n) >= 0.01 ? `$${num(n).toFixed(4)}` : usd6(n))

/** Keep the head and the distinguishing tail: `run-2026…21-abcd`. */
export function middleTruncate(s, max) {
  const str = String(s ?? '')
  if (str.length <= max) return str
  const keep = max - 1
  const tail = Math.ceil(keep / 2)
  return `${str.slice(0, keep - tail)}…${str.slice(str.length - tail)}`
}

/** Runs for the workspace: current first, then archived history newest first. */
export function verifyRuns(ws) {
  const seen = new Set()
  const runs = []
  if (ws?.current) {
    seen.add(ws.current.runId)
    runs.push(ws.current)
  }
  for (const r of [...(ws?.runs ?? [])].reverse()) {
    if (r && !seen.has(r.runId)) {
      seen.add(r.runId)
      runs.push(r)
    }
  }
  return runs
}

/**
 * Lanes in canonical order. The collector's RunView projection is preferred;
 * the raw manifest record is the stale-build fallback.
 */
export function lanesOf(run) {
  if (run?.view?.lanes !== undefined) return run.view.lanes
  return LANE_ORDER.map((id) => run?.lanes?.[id]).filter(Boolean)
}

export function laneDuration(l) {
  if (l?.durationMs !== undefined) return l.durationMs
  if (!l?.startedAt || !l?.finishedAt) return undefined
  const ms = Date.parse(l.finishedAt) - Date.parse(l.startedAt)
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined
}

export function runStatus(run) {
  return run?.view?.status ?? run?.aggregate?.status ?? 'unavailable'
}

/**
 * Fingerprint the workspace so a poll only rebuilds the Runs DOM when the
 * rendered data changed. A blind rebuild would destroy keyboard focus and
 * replay motion on every tick (DESIGN.md 6.5).
 */
export function verifyKey(ws) {
  const parts = [ws?.corrupt ?? 0, ws?.degraded ?? '']
  for (const r of verifyRuns(ws ?? { runs: [] })) {
    const a = r.aggregate ?? {}
    parts.push(r.runId ?? '', r.startedAt ?? '', r.finishedAt ?? '', a.status ?? '', a.calls ?? 0, a.costUsd ?? 0, a.tokens ?? 0)
    for (const l of lanesOf(r)) {
      parts.push(
        l.status,
        l.durationMs ?? 0,
        l.selected ? 1 : 0,
        l.summary ?? '',
        l.reason ?? '',
        l.model ?? '',
        l.reportPath ?? '',
        JSON.stringify(l.headBinding ?? null),
        JSON.stringify(l.usage ?? null),
        JSON.stringify(l.budget ?? null),
        JSON.stringify(l.cache ?? null),
        JSON.stringify(l.screenshots ?? null),
      )
    }
  }
  return parts.join('|')
}

function addTo(map, key, cost, calls) {
  const row = map.get(key) ?? { key, costUsd: 0, calls: 0 }
  row.costUsd += cost
  row.calls += calls
  map.set(key, row)
}

const byCost = (a, b) => b.costUsd - a.costUsd || b.calls - a.calls || a.key.localeCompare(b.key)

/** Spend ledger by model, lane and day (newest day first) over manifest runs. */
export function spendLedger(runs) {
  const model = new Map()
  const lane = new Map()
  const day = new Map()
  let total = 0
  let calls = 0
  for (const r of runs ?? []) {
    const d = String(r?.startedAt ?? '').slice(0, 10) || 'unknown'
    for (const l of lanesOf(r)) {
      if (!l?.selected) continue
      const u = l.usage ?? {}
      const cost = u.metered === false ? 0 : num(u.costUsd)
      const n = num(u.calls)
      total += cost
      calls += n
      addTo(model, u.metered === false ? 'unmetered' : (l.model ?? u.model ?? 'unknown'), cost, n)
      addTo(lane, l.lane, cost, n)
      addTo(day, d, cost, n)
    }
  }
  return {
    total,
    calls,
    runs: (runs ?? []).length,
    byModel: [...model.values()].sort(byCost),
    byLane: [...lane.values()].sort(
      (a, b) => byCost(a, b) || LANE_ORDER.indexOf(a.key) - LANE_ORDER.indexOf(b.key),
    ),
    byDay: [...day.values()].sort((a, b) => b.key.localeCompare(a.key)),
  }
}

const cell = (s) => s.trim().replace(/`/g, '')

/**
 * Markdown eval report into blocks the desk renders as real tables (7.4).
 * Only the shapes evals/run.mjs writes: headings, paragraphs, pipe tables
 * and dash lists. Text is never interpreted as HTML.
 */
export function parseEvalDoc(md) {
  const blocks = []
  const lines = String(md ?? '').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) continue
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      blocks.push({ type: 'heading', level: h[1].length, text: cell(h[2]) })
      continue
    }
    if (line.trim().startsWith('|')) {
      const rows = []
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        rows.push(lines[i].trim().replace(/^\||\|$/g, '').split('|').map(cell))
        i++
      }
      i--
      const body = rows.filter((r, n) => !(n === 1 && r.every((c) => /^:?-+:?$/.test(c))))
      blocks.push({ type: 'table', head: body[0] ?? [], rows: body.slice(1) })
      continue
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items = []
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(cell(lines[i].replace(/^\s*[-*]\s+/, '')))
        i++
      }
      i--
      blocks.push({ type: 'list', items })
      continue
    }
    const prev = blocks[blocks.length - 1]
    if (prev?.type === 'text' && lines[i - 1]?.trim()) prev.text += ` ${cell(line)}`
    else blocks.push({ type: 'text', text: cell(line) })
  }
  return blocks
}
