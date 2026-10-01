// Shared data collector for `npm run watch` (TUI) and `npm run app` (Electron).
// Reads `gh` CLI + local artifacts only — nothing leaves the machine.
import { execFile } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
export const ROOT = new URL('..', import.meta.url).pathname

async function gh(args, cwd) {
  const { stdout } = await exec('gh', args, { cwd, maxBuffer: 8 * 1024 * 1024 })
  return JSON.parse(stdout)
}

// Sanitize strings from repo/PR/journal data before display — strip control
// chars so a malicious branch name or commit msg can't inject escapes.
export function safe(s) {
  return String(s ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\x1b/g, ' ')
}

// --- run-manifest layer ----------------------------------------------------
// The manifest is the shared evidence contract for every surface (R15–R18):
// the dashboard workspace and the TUI pane render these sanitized records,
// and the comment renderer renders the same fields from the same file.
// A corrupt or half-written manifest degrades to the last valid run —
// never a blank pane; secret-shaped tokens are masked before render.

const LANE_IDS = ['review', 'flow', 'app', 'a0']
const KNOWN_STATUSES = new Set([
  'passed',
  'failed',
  'skipped',
  'blocked',
  'unavailable',
  'inconclusive',
])

// dist viewmodel carries the canonical validators + secret mask — the
// collector mirrors the fallback shape so a stale/missing build still
// collects rather than crashing.
let _vm
async function viewmodel() {
  if (_vm !== undefined) return _vm
  try {
    _vm = await import(new URL('../dist/report/viewmodel.js', import.meta.url).href)
  } catch {
    _vm = null
  }
  return _vm
}

function validManifest(m, vm) {
  if (vm?.isRunManifest !== undefined) return vm.isRunManifest(m)
  if (m === null || typeof m !== 'object') return false
  if (m.schemaVersion !== 1 || typeof m.runId !== 'string') return false
  if (m.aggregate === null || typeof m.aggregate !== 'object') return false
  if (m.lanes === null || typeof m.lanes !== 'object') return false
  return LANE_IDS.every(
    (id) => m.lanes[id] && typeof m.lanes[id] === 'object' && KNOWN_STATUSES.has(m.lanes[id].status),
  )
}

function sanitizeManifest(m, mask) {
  const s = (v) => (typeof v === 'string' ? mask(safe(v)) : v)
  const lanes = {}
  for (const id of LANE_IDS) {
    const l = m.lanes[id]
    if (l === null || typeof l !== 'object') continue
    const lane = {
      lane: s(l.lane),
      selected: l.selected === true,
      status: s(l.status),
      startedAt: s(l.startedAt),
      finishedAt: s(l.finishedAt),
      reportPath: s(l.reportPath),
      model: s(l.model),
      summary: s(l.summary),
      reason: s(l.reason),
      usage: l.usage ?? undefined,
      budget: l.budget ?? undefined,
      cache: l.cache ?? undefined,
      headBinding: l.headBinding ?? undefined,
    }
    if (lane.usage !== undefined && typeof lane.usage === 'object') {
      lane.usage = { ...lane.usage, provider: s(lane.usage.provider), model: s(lane.usage.model) }
    }
    if (lane.headBinding !== undefined && typeof lane.headBinding === 'object') {
      lane.headBinding = {
        ...lane.headBinding,
        intendedSha: s(lane.headBinding.intendedSha),
        checkoutSha: s(lane.headBinding.checkoutSha),
        status: s(lane.headBinding.status),
        source: s(lane.headBinding.source),
        detail: s(lane.headBinding.detail),
      }
    }
    lanes[id] = lane
  }
  const identity =
    m.identity !== null && typeof m.identity === 'object' ? m.identity : {}
  return {
    schemaVersion: m.schemaVersion,
    runId: s(m.runId),
    startedAt: s(m.startedAt),
    finishedAt: s(m.finishedAt),
    identity: {
      repo: s(identity.repo),
      pr: s(identity.pr),
      intendedHeadSha: s(identity.intendedHeadSha),
      checkoutSha: s(identity.checkoutSha),
      baseSha: s(identity.baseSha),
    },
    lanes,
    aggregate: {
      status: s(m.aggregate.status),
      ok: m.aggregate.ok === true,
      costUsd: m.aggregate.costUsd ?? 0,
      calls: m.aggregate.calls ?? 0,
      tokens: m.aggregate.tokens ?? 0,
    },
  }
}

// Config's reportDir comes from the same loader the CLI uses — a custom
// reportDir must not orphan the workspace view on the default path.
async function resolveReportDir(root) {
  try {
    const { loadConfig } = await import(new URL('../dist/config.js', import.meta.url).href)
    const cfg = await loadConfig(root, { trust: 'trusted' })
    return cfg.reportDir ? resolve(root, cfg.reportDir) : join(root, 'argus-reviewer-report')
  } catch {
    return join(root, 'argus-reviewer-report')
  }
}

async function readManifest(path, vm) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    return validManifest(parsed, vm) ? parsed : undefined
  } catch {
    return undefined
  }
}

async function collectManifests(root) {
  const vm = await viewmodel()
  const mask = vm?.maskSecrets ?? ((v) => v)
  const reportDir = await resolveReportDir(root)
  const workspace = {
    reportDir,
    runs: [],
    current: undefined,
    corrupt: 0,
    // The live run-manifest.json failed to read — the pane shows the last
    // valid archived run instead of pretending nothing exists.
    degraded: undefined,
  }

  const archived = []
  const historyDir = join(reportDir, 'manifests')
  if (existsSync(historyDir)) {
    let files
    try {
      files = (await readdir(historyDir)).filter((f) => f.endsWith('.json')).sort()
    } catch {
      files = []
    }
    for (const f of files.slice(-50)) {
      const m = await readManifest(join(historyDir, f), vm)
      if (m === undefined) workspace.corrupt += 1
      else archived.push(sanitizeManifest(m, mask))
    }
  }
  workspace.runs = archived

  const currentPath = join(reportDir, 'run-manifest.json')
  const currentRaw = await readManifest(currentPath, vm)
  if (currentRaw !== undefined) {
    workspace.current = sanitizeManifest(currentRaw, mask)
  } else if (existsSync(currentPath)) {
    workspace.corrupt += 1
    // Retain the last valid manifest rather than going blank mid-write.
    workspace.current = archived[archived.length - 1]
    workspace.degraded =
      workspace.current === undefined
        ? 'run-manifest.json is unreadable'
        : 'run-manifest.json unreadable — showing last valid run'
  } else {
    workspace.current = archived[archived.length - 1]
  }
  return workspace
}

export async function collect(root = ROOT) {
  const state = {
    prs: [],
    prChecks: {},
    runs: [],
    evalDoc: '',
    evalFile: '',
    journal: undefined,
    journals: [],
    journalFiles: 0,
    live: [],
    review: undefined,
    workspace: {
      reportDir: '',
      runs: [],
      current: undefined,
      corrupt: 0,
      degraded: undefined,
    },
    error: '',
    updatedAt: new Date().toISOString(),
  }

  try {
    const [prs, runs] = await Promise.all([
      gh(['pr', 'list', '--json', 'number,title,mergeStateStatus,reviewDecision,headRefName,state,author', '--limit', '12'], root),
      gh(['run', 'list', '--limit', '8', '--json', 'displayTitle,status,conclusion,workflowName,createdAt,headBranch,databaseId'], root),
    ])
    state.prs = prs.map((p) => ({ ...p, title: safe(p.title), headRefName: safe(p.headRefName) }))
    state.runs = runs.map((r) => ({ ...r, displayTitle: safe(r.displayTitle), headBranch: safe(r.headBranch) }))
    const checks = await Promise.all(
      prs.slice(0, 6).map((p) =>
        gh(['pr', 'checks', String(p.number), '--json', 'name,state,bucket'], root)
          .then((c) => [p.number, c.map((x) => ({ ...x, name: safe(x.name) }))])
          .catch(() => [p.number, []]),
      ),
    )
    state.prChecks = Object.fromEntries(checks)
  } catch (e) {
    state.error = `gh: ${safe(e.message).split('\n')[0]}`
  }

  const evalsDir = join(root, 'docs/evals')
  if (existsSync(evalsDir)) {
    const files = (await readdir(evalsDir)).filter((f) => f.endsWith('.md')).sort()
    const last = files[files.length - 1]
    if (last) {
      state.evalFile = last
      state.evalDoc = safe(await readFile(join(evalsDir, last), 'utf8'))
    }
  }

  const journalDir = join(root, '.argus-reviewer-cache/journal')
  if (existsSync(journalDir)) {
    const files = (await readdir(journalDir)).filter((f) => f.endsWith('.json')).sort()
    state.journalFiles = files.length
    const recent = files.slice(-20)
    for (const f of recent) {
      try {
        const j = JSON.parse(await readFile(join(journalDir, f), 'utf8'))
        state.journals.push({
          runId: safe(j.runId ?? f.replace(/\.json$/, '')),
          ok: !!j.ok,
          costUsd: j.costUsd ?? 0,
          steps: Array.isArray(j.steps) ? j.steps.length : 0,
          errors: (j.errors ?? []).length,
        })
      } catch { /* partial write */ }
    }
    state.journal = state.journals.length
      ? JSON.parse(await readFile(join(journalDir, recent[recent.length - 1]), 'utf8'))
      : undefined
    state.journalFile = recent[recent.length - 1]
  }

  // Recent live.ndjson lines — argus processes (code-review, run, debug)
  // append NDJSON here; the TUI shows the tail between refreshes.
  const livePath = join(root, '.argus-reviewer-cache/live.ndjson')
  if (existsSync(livePath)) {
    try {
      const lines = (await readFile(livePath, 'utf8')).split('\n').filter(Boolean)
      state.live = lines.slice(-20).map((l) => {
        try {
          const e = JSON.parse(l)
          return { ts: e.ts ?? 0, source: safe(e.source), level: safe(e.level), msg: safe(e.msg) }
        } catch {
          return { ts: 0, source: '?', level: 'info', msg: safe(l.slice(0, 200)) }
        }
      })
    } catch { /* partial write */ }
  }

  state.workspace = await collectManifests(root)
  const reportDir = state.workspace.reportDir

  // Latest code-review.json summary — verdict/cost/counts for the pane.
  const reviewPath = join(reportDir, 'code-review.json')
  if (existsSync(reviewPath)) {
    try {
      const r = JSON.parse(await readFile(reviewPath, 'utf8'))
      state.review = {
        skipped: !!r.skipped,
        verdict: safe(r.verdict),
        findings: Array.isArray(r.findings) ? r.findings.length : 0,
        costUsd: r.visionCostUsd ?? 0,
        tokens: r.tokens ?? 0,
        model: safe(r.model),
        budgetExceeded: !!r.budgetExceeded,
      }
    } catch { /* partial write */ }
  }
  return state
}
