// Seeded dashboard workspace + stubbed preload bridge, shared by the
// dashboard smoke (tests/e2e/dashboard-smoke.mjs) and the QA capture
// harness (scripts/qa/capture-web.mjs). Nothing here spawns a process or
// talks to a model: `runEval` only records its call.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ELECTRON_DIR = fileURLToPath(new URL('../../electron/', import.meta.url))

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }

const lane = (id, status, extra = {}) => ({
  lane: id,
  selected: true,
  status,
  startedAt: '2026-09-30T20:00:00.000Z',
  finishedAt: '2026-09-30T20:00:30.000Z',
  reportPath: `reports/${id}-lane.json`,
  model: 'google/gemini-2.5-flash-lite',
  summary: `${id} summary`,
  usage: { provider: 'openrouter', model: 'google/gemini-2.5-flash-lite', calls: 2, tokens: 200, costUsd: 0.001, metered: true },
  budget: { limitUsd: 1, spentUsd: 0.001, exceeded: false, maxDurationMs: 120000, elapsedMs: 30000, maxTasks: undefined, tasks: 0 },
  ...extra,
})

export const seededManifest = {
  schemaVersion: 1,
  runId: 'smoke-run-1',
  startedAt: '2026-09-30T20:00:00.000Z',
  finishedAt: '2026-09-30T20:02:00.000Z',
  identity: { repo: 'o/r', pr: '7', intendedHeadSha: 'abc1234deadbeef', checkoutSha: 'abc1234deadbeef', baseSha: 'base00', runNonce: 'smoke:1' },
  lanes: {
    review: lane('review', 'passed', {
      summary: '2 findings',
      headBinding: { intendedSha: 'abc1234deadbeef', checkoutSha: 'abc1234deadbeef', status: 'match', source: 'github', detail: 'checkout matches the intended PR head' },
    }),
    flow: lane('flow', 'failed', {
      summary: undefined,
      reason: 'landing.test.ts: assertion failed',
      cache: { hits: 2, misses: 1, heals: 1, staleEntries: 0, assertionHits: 1, assertionMisses: 0 },
    }),
    app: lane('app', 'passed', { summary: 'expected state verified' }),
    a0: lane('a0', 'inconclusive', {
      summary: 'delegation returned, self-reported',
      usage: { provider: 'a0', model: undefined, calls: 0, tokens: 0, costUsd: 0, metered: false },
      budget: { limitUsd: undefined, spentUsd: 0, exceeded: false, maxDurationMs: 600000, elapsedMs: 40000, maxTasks: 1, tasks: 1 },
    }),
  },
  aggregate: { status: 'failed', ok: false, costUsd: 0.006, calls: 6, tokens: 600 },
}

const baseState = {
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
  error: '',
  updatedAt: '2026-09-30T20:05:00.000Z',
}

/** Filled: one archived run, one current four-lane run, one corrupt file. */
export const seededState = {
  ...baseState,
  workspace: {
    reportDir: '/tmp/argus-reviewer-report',
    runs: [{ ...seededManifest, runId: 'smoke-run-0', aggregate: { status: 'passed', ok: true, costUsd: 0.001, calls: 1, tokens: 100 } }],
    current: seededManifest,
    corrupt: 1,
    degraded: undefined,
  },
}

/** Empty: a fresh checkout with no verify runs, PRs or journals. */
export const emptyState = {
  ...baseState,
  workspace: { reportDir: '/tmp/argus-reviewer-report', runs: [], current: undefined, corrupt: 0, degraded: undefined },
}

/** Dashboard states the harness captures, by name. */
export const DASHBOARD_STATES = { filled: seededState, empty: emptyState }

// What main.mjs returns from 'eval-plan' (evalPlan + formatted lines).
export const seededPlan = {
  keyPresent: true,
  capLabel: '$4.00',
  lines: [
    'Runs node evals/run.mjs: 3 test case(s) x 2 model(s), 2 runs each (cold, then cached).',
    '  google/gemini-2.5-flash-lite  (last run $0.0014)',
    '  moonshotai/kimi-k2.5  (last run $0.15)',
    'Estimated cost: about $0.15, based on the last recorded run.',
    'Budget cap: $1.00 per run, at most $4.00 in total. This spends real OpenRouter credit.',
  ],
}

/**
 * Install the stubbed `window.argus` preload bridge before any page script
 * runs. `runEval` records its options and never spawns anything.
 */
export async function installBridgeStub(page, state = seededState, plan = seededPlan) {
  await page.addInitScript(({ state, plan }) => {
    const g = globalThis
    g.__evalCalls = []
    g.__planFails = false
    g.argus = {
      collect: async () => state,
      evalPlan: async () => {
        if (g.__planFails) throw new Error('plan read failed')
        return plan
      },
      runEval: async (opts) => {
        g.__evalCalls.push(opts ?? null)
        return { ok: true }
      },
      runLogs: async () => ({ ok: true }),
      onEvalLog: () => {},
      onLiveLog: () => {},
      onRunLog: () => {},
    }
  }, { state, plan })
}

/** Serve electron/ over loopback HTTP. Resolves to `{ url, close }`. */
export async function serveElectron(root = ELECTRON_DIR) {
  const server = createServer(async (req, res) => {
    const path = req.url === '/' ? '/index.html' : (req.url?.split('?')[0] ?? '/')
    const file = join(root, path)
    try {
      const body = await readFile(file)
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
      res.end(body)
    } catch {
      res.writeHead(404); res.end('not found')
    }
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address()
  return { url: `http://127.0.0.1:${port}/`, close: () => new Promise((r) => server.close(r)) }
}
