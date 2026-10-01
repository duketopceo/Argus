// Shared data collector for `npm run watch` (TUI) and `npm run app` (Electron).
// Reads `gh` CLI + local artifacts only — nothing leaves the machine.
import { execFile } from 'node:child_process'
import { readdir, readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
export const ROOT = new URL('..', import.meta.url).pathname

async function gh(args, cwd) {
  const { stdout } = await exec('gh', args, {
    cwd,
    maxBuffer: 8 * 1024 * 1024,
    // A hung gh must not stack up collects — the pollers re-fire regardless.
    timeout: 15_000,
  })
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

// Fallback mask for the stale-build path — the same patterns viewmodel
// exports; masking must not silently disable when dist/ is behind.
const FALLBACK_SECRET_PATTERNS = [
  /sk-or-[A-Za-z0-9_-]{4,}/g,
  /sk-[A-Za-z0-9_-]{8,}/g,
  /gh[pousr]_[A-Za-z0-9_]{8,}/g,
  /github_pat_[A-Za-z0-9_]{8,}/g,
  /xox[baprs]-[A-Za-z0-9-]{8,}/g,
  /AKIA[A-Z0-9]{16}/g,
  /npm_[A-Za-z0-9]{8,}/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{10,}/gi,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,
  /:\/\/[^/\s:@]{1,64}:[^/\s:@]{6,}@/g,
]
const fallbackMask = (v) =>
  FALLBACK_SECRET_PATTERNS.reduce((s, re) => s.replace(re, '•••'), v)

export function validManifest(m, vm) {
  if (vm?.isRunManifest !== undefined) return vm.isRunManifest(m)
  // Keep lockstep with isRunManifest (viewmodel.ts) — this fallback guards
  // the stale-dist path and must certify no less than the primary does.
  const num = (n) => typeof n === 'number' && Number.isFinite(n)
  if (m === null || typeof m !== 'object' || Array.isArray(m)) return false
  if (m.schemaVersion !== 1 || typeof m.runId !== 'string') return false
  if (typeof m.startedAt !== 'string') return false
  if (m.identity === null || typeof m.identity !== 'object' || Array.isArray(m.identity)) {
    return false
  }
  for (const v of [
    m.identity.repo,
    m.identity.pr,
    m.identity.intendedHeadSha,
    m.identity.checkoutSha,
    m.identity.baseSha,
    m.identity.runNonce,
  ]) {
    if (v !== undefined && typeof v !== 'string') return false
  }
  if (m.aggregate === null || typeof m.aggregate !== 'object') return false
  if (!KNOWN_STATUSES.has(m.aggregate.status)) return false
  if (m.aggregate.ok !== true && m.aggregate.ok !== false) return false
  if (!num(m.aggregate.calls) || !num(m.aggregate.tokens) || !num(m.aggregate.costUsd)) {
    return false
  }
  if (m.lanes === null || typeof m.lanes !== 'object') return false
  return LANE_IDS.every((id) => {
    const lane = m.lanes[id]
    return (
      lane !== null &&
      typeof lane === 'object' &&
      lane.lane === id &&
      typeof lane.selected === 'boolean' &&
      KNOWN_STATUSES.has(lane.status) &&
      lane.usage !== null &&
      typeof lane.usage === 'object' &&
      num(lane.usage.calls) &&
      num(lane.usage.tokens) &&
      num(lane.usage.costUsd) &&
      lane.budget !== null &&
      typeof lane.budget === 'object'
    )
  })
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
      runNonce: s(identity.runNonce),
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
// Memoized on the config files' mtimes: the .ts path transpiles and imports
// a fresh temp module per call, so reloading on every poll would leak
// module-cache entries in the long-lived watcher.
const CONFIG_CANDIDATES = [
  'argus-reviewer.config.ts',
  'argus-reviewer.config.json',
  'vision-e2e.config.ts',
  'vision-e2e.config.json',
]
const _reportDir = new Map()

async function configFingerprint(root) {
  let key = ''
  for (const name of CONFIG_CANDIDATES) {
    try {
      key += `${name}:${(await stat(join(root, name))).mtimeMs};`
    } catch {
      // absent candidate
    }
  }
  return key
}

async function resolveReportDir(root) {
  const key = await configFingerprint(root)
  const cached = _reportDir.get(root)
  if (cached !== undefined && cached.key === key) return cached.dir
  let dir
  try {
    const { loadConfig } = await import(new URL('../dist/config.js', import.meta.url).href)
    const cfg = await loadConfig(root, { trust: 'trusted' })
    dir = cfg.reportDir ? resolve(root, cfg.reportDir) : join(root, 'argus-reviewer-report')
  } catch {
    dir = join(root, 'argus-reviewer-report')
  }
  _reportDir.set(root, { key, dir })
  return dir
}

async function readManifest(path, vm) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    return validManifest(parsed, vm) ? parsed : undefined
  } catch {
    return undefined
  }
}

// When the view-model is importable the collector projects each manifest to
// the shared RunView — the TUI and dashboard then render view.lanes/
// view.statusIcon directly instead of re-deriving the contract (R15/R17).
// Absent on a stale build; both surfaces keep a raw-record fallback.
function withView(manifest, vm) {
  if (vm?.manifestToRunView === undefined) return manifest
  try {
    return { ...manifest, view: vm.manifestToRunView(manifest) }
  } catch {
    return manifest
  }
}

// Archived manifests are immutable once written — cache sanitized results
// by mtime+size so a poll re-reads only the current run-manifest.json.
const _archiveCache = new Map()

async function readArchivedManifest(path, vm, mask) {
  let st
  try {
    st = await stat(path)
  } catch {
    return undefined
  }
  const hit = _archiveCache.get(path)
  if (hit !== undefined && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
    return hit.run
  }
  const raw = await readManifest(path, vm)
  const run = raw === undefined ? undefined : withView(sanitizeManifest(raw, mask), vm)
  _archiveCache.set(path, { mtimeMs: st.mtimeMs, size: st.size, run })
  return run
}

async function collectManifests(root) {
  const vm = await viewmodel()
  const mask = vm?.maskSecrets ?? fallbackMask
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
  let files
  try {
    files = (await readdir(historyDir)).filter((f) => f.endsWith('.json')).sort()
  } catch {
    files = []
  }
  // Evict cache entries for archives that no longer exist (deleted by
  // retention or by hand) so a long-lived watcher can't grow it forever.
  const livePaths = new Set(files.slice(-50).map((f) => join(historyDir, f)))
  for (const cached of _archiveCache.keys()) {
    if (cached.startsWith(historyDir) && !livePaths.has(cached)) {
      _archiveCache.delete(cached)
    }
  }
  const archivedRuns = await Promise.all(
    files.slice(-50).map((f) => readArchivedManifest(join(historyDir, f), vm, mask)),
  )
  for (const run of archivedRuns) {
    if (run === undefined) workspace.corrupt += 1
    else archived.push(run)
  }
  workspace.runs = archived

  const currentPath = join(reportDir, 'run-manifest.json')
  const currentRaw = await readManifest(currentPath, vm)
  if (currentRaw !== undefined) {
    workspace.current = withView(sanitizeManifest(currentRaw, mask), vm)
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

// Overlapping polls share one in-flight collect — a slow gh or a big
// manifest archive must not stack concurrent sweeps. Keyed per root so
// concurrent collects of different roots stay independent.
const _collecting = new Map()

export function collect(root = ROOT) {
  const inflight = _collecting.get(root)
  if (inflight !== undefined) return inflight
  const next = collectNow(root).finally(() => {
    _collecting.delete(root)
  })
  _collecting.set(root, next)
  return next
}

async function collectNow(root) {
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

  const ghSection = async () => {
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
            .catch((e) => {
              // `gh pr checks` exits nonzero on pending/failing checks but
              // still writes the JSON — a red PR must not render as zero rows.
              try {
                const c = JSON.parse(e.stdout)
                return [p.number, c.map((x) => ({ ...x, name: safe(x.name) }))]
              } catch {
                return [p.number, []]
              }
            }),
        ),
      )
      state.prChecks = Object.fromEntries(checks)
    } catch (e) {
      state.error = `gh: ${safe(e.message).split('\n')[0]}`
    }
  }

  const fileSections = async () => {
    const evalsDir = join(root, 'docs/evals')
    try {
      const files = (await readdir(evalsDir)).filter((f) => f.endsWith('.md')).sort()
      const last = files[files.length - 1]
      if (last) {
        state.evalFile = last
        state.evalDoc = safe(await readFile(join(evalsDir, last), 'utf8'))
      }
    } catch { /* no evals dir, or a raced delete */ }

    const journalDir = join(root, '.argus-reviewer-cache/journal')
    try {
      const files = (await readdir(journalDir)).filter((f) => f.endsWith('.json')).sort()
      state.journalFiles = files.length
      const recent = files.slice(-20)
      let lastParsed
      for (const f of recent) {
        try {
          const j = JSON.parse(await readFile(join(journalDir, f), 'utf8'))
          lastParsed = j
          state.journals.push({
            runId: safe(j.runId ?? f.replace(/\.json$/, '')),
            ok: !!j.ok,
            costUsd: j.costUsd ?? 0,
            steps: Array.isArray(j.steps) ? j.steps.length : 0,
            errors: (j.errors ?? []).length,
          })
        } catch { /* partial write */ }
      }
      state.journalFile = recent[recent.length - 1]
      // Reuse the loop's last parse — and sanitize the rendered fields like
      // every other repo-controlled string.
      if (lastParsed !== undefined) {
        state.journal = {
          ...lastParsed,
          runId: safe(lastParsed.runId),
          errors: Array.isArray(lastParsed.errors)
            ? lastParsed.errors.map((e) =>
                e !== null && typeof e === 'object'
                  ? { ...e, phase: safe(e.phase), message: safe(e.message) }
                  : safe(e),
              )
            : [],
        }
      }
    } catch { /* no journal dir, or a raced delete */ }

    // Recent live.ndjson lines — argus processes (code-review, run, debug)
    // append NDJSON here; the TUI shows the tail between refreshes.
    try {
      const lines = (
        await readFile(join(root, '.argus-reviewer-cache/live.ndjson'), 'utf8')
      )
        .split('\n')
        .filter(Boolean)
      state.live = lines.slice(-20).map((l) => {
        try {
          const e = JSON.parse(l)
          return { ts: e.ts ?? 0, source: safe(e.source), level: safe(e.level), msg: safe(e.msg) }
        } catch {
          return { ts: 0, source: '?', level: 'info', msg: safe(l.slice(0, 200)) }
        }
      })
    } catch { /* no live file yet */ }
  }

  const workspaceP = collectManifests(root)
  const reviewSection = async () => {
    // Latest code-review.json summary — verdict/cost/counts for the pane.
    const reportDir = (await workspaceP).reportDir
    try {
      const r = JSON.parse(await readFile(join(reportDir, 'code-review.json'), 'utf8'))
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

  await Promise.all([ghSection(), fileSections(), reviewSection()])
  state.workspace = await workspaceP
  return state
}
