// Seeded dashboard workspace + stubbed preload bridge, shared by the
// dashboard smoke (tests/e2e/dashboard-smoke.mjs) and the QA capture
// harness (scripts/qa/capture-web.mjs). Nothing here spawns a process or
// talks to a model: `runEval` only records its call.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'

import { deskFile, mimeOf } from '../../electron/desk-files.mjs'

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
  heals: [],
  sources: { gh: { state: 'ok' }, journal: { state: 'ok' } },
  keyPresent: true,
  budgetUsd: 1,
  error: '',
  updatedAt: '2026-09-30T20:05:00.000Z',
}

const EVAL_DOC = [
  '# argus-reviewer eval: 2026-09-30',
  '',
  'Suite: `evals/suite` (3 td-API tasks on tests/fixtures/index.html)',
  'Budget cap: $1.00/run · Target: static fixture via file://',
  '',
  '| Model | Cold pass | Cold calls | Cold cost | Heal events | Warm pass | Warm calls | Warm cost |',
  '| --- | --- | --- | --- | --- | --- | --- | --- |',
  '| `google/gemini-2.5-flash-lite` | 3/3 | 6 | $0.0014 | 0 | 3/3 | 0 | $0.0000 |',
  '| `moonshotai/kimi-k2.5` | 2/3 | 7 | $0.0880 | 0 | 2/3 | 4 | $0.0650 |',
  '',
  '### Failures',
  '',
  '- `moonshotai/kimi-k2.5`: double click sets the marker: model grounded to "", which does not match the instruction',
].join('\n')

// The flow lane of the current run carries a before/after pair; the paths
// are what the collector emits (report/...), served here from brand art.
const withShots = (m) => ({
  ...m,
  lanes: {
    ...m.lanes,
    flow: { ...m.lanes.flow, screenshots: { before: 'brand/export/lockup-64-light.png', after: 'brand/export/lockup-64-dark.png' } },
  },
})

const archived = (runId, status, startedAt, costUsd) => ({
  ...seededManifest,
  runId,
  startedAt,
  finishedAt: startedAt,
  aggregate: { status, ok: status === 'passed', costUsd, calls: 1, tokens: 100 },
})

/** Filled: archived history, one current four-lane run, one corrupt file. */
export const seededState = {
  ...baseState,
  prs: [
    { number: 112, title: 'feat(desk): Ocellus desk reskin', reviewDecision: '', mergeStateStatus: 'BLOCKED', headRefName: 'feat/ocellus-u13-desk' },
    { number: 109, title: 'fix(collect): name unreadable journals', reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN', headRefName: 'fix/journal-state' },
  ],
  prChecks: {
    112: [
      { name: 'ci / test (22)', state: 'SUCCESS', bucket: 'pass' },
      { name: 'ci / test (24)', state: 'PENDING', bucket: 'pending' },
      { name: 'argus-reviewer', state: 'FAILURE', bucket: 'fail' },
    ],
  },
  runs: [
    { displayTitle: 'feat(desk): Ocellus desk reskin', status: 'in_progress', conclusion: '', workflowName: 'ci', createdAt: '2026-09-30T20:04:00.000Z', headBranch: 'feat/ocellus-u13-desk', databaseId: 11 },
    { displayTitle: 'fix(collect): name unreadable journals', status: 'completed', conclusion: 'success', workflowName: 'ci', createdAt: '2026-09-30T18:00:00.000Z', headBranch: 'fix/journal-state', databaseId: 10 },
    { displayTitle: 'argus-reviewer on #112', status: 'completed', conclusion: 'failure', workflowName: 'argus-reviewer', createdAt: '2026-09-30T17:40:00.000Z', headBranch: 'feat/ocellus-u13-desk', databaseId: 9 },
  ],
  evalDoc: EVAL_DOC,
  evalFile: '2026-09-30.md',
  journals: [
    { runId: 'j-0926', ok: true, costUsd: 0.0012, steps: 9, errors: 0 },
    { runId: 'j-0927', ok: true, costUsd: 0.0031, steps: 11, errors: 0 },
    { runId: 'j-0928', ok: false, costUsd: 0.0054, steps: 12, errors: 2 },
    { runId: 'j-0929', ok: true, costUsd: 0.0009, steps: 9, errors: 0 },
    { runId: 'j-0930', ok: true, costUsd: 0.0021, steps: 10, errors: 1 },
  ],
  journal: { runId: 'j-0930', ok: true, costUsd: 0.0021, errors: [{ phase: 'locate', message: 'cache miss on "Sign in", re-grounded' }] },
  journalFile: '2026-09-30T20-00-00.json',
  heals: [
    { runId: 'j-0930', at: '2026-09-30T20:00:00.000Z', test: 'landing loads', file: 'e2e/landing.test.ts', instruction: 'click the "Sign in" button', action: 'click', model: 'google/gemini-2.5-flash-lite', ok: true },
    { runId: 'j-0928', at: '2026-09-28T12:00:00.000Z', test: 'checkout totals', file: 'e2e/checkout.test.ts', instruction: 'type 2 into the quantity field', action: 'fill', model: 'google/gemini-2.5-flash-lite', ok: true },
  ],
  workspace: {
    reportDir: '/tmp/argus-reviewer-report',
    runs: [
      archived('run-0925-skipped', 'skipped', '2026-09-25T10:00:00.000Z', 0),
      archived('run-0926-unavailable', 'unavailable', '2026-09-26T10:00:00.000Z', 0),
      archived('run-0927-blocked', 'blocked', '2026-09-27T10:00:00.000Z', 0.0004),
      archived('run-0928-inconclusive', 'inconclusive', '2026-09-28T10:00:00.000Z', 0.0021),
      archived('smoke-run-0', 'passed', '2026-09-29T10:00:00.000Z', 0.001),
    ],
    current: withShots(seededManifest),
    corrupt: 1,
    degraded: undefined,
  },
}

/** Empty: a fresh checkout with no verify runs, PRs or journals. */
export const emptyState = {
  ...baseState,
  workspace: { reportDir: '/tmp/argus-reviewer-report', runs: [], current: undefined, corrupt: 0, degraded: undefined },
}

const clean = { ...seededState, workspace: { ...seededState.workspace, corrupt: 0 } }

/** Partial: gh missing, the newest manifest unreadable, one journal corrupt. */
export const partialState = {
  ...clean,
  prs: [],
  prChecks: {},
  runs: [],
  sources: { gh: { state: 'missing' }, journal: { state: 'error', detail: '2026-10-01T09-12-00.json' } },
  workspace: {
    ...clean.workspace,
    current: clean.workspace.runs[clean.workspace.runs.length - 1],
    corrupt: 1,
    degraded: 'run-manifest.json unreadable, showing the last valid run',
  },
}

/**
 * Dashboard states the harness captures, by name. `data` drives the stub
 * bridge (`state`, or `reject` to make collect fail, after `failAfter`
 * successes); `view` picks the tab; `setup` runs after load.
 */
export const DASHBOARD_STATES = {
  filled: { data: { state: clean } },
  inspector: {
    data: { state: clean },
    setup: async (page, { width }) => {
      // Phone panes drill down: open the run first, then the lane.
      if (width <= 720) {
        await page.locator('#veruns .runrow').first().focus()
        await page.keyboard.press('Enter')
      }
      await page.locator('#velanes .lanerow').nth(1).focus()
      await page.keyboard.press('Enter')
    },
  },
  empty: { data: { state: emptyState } },
  nokey: { data: { state: { ...emptyState, keyPresent: false } } },
  partial: { data: { state: partialState } },
  error: { data: { reject: 'collect failed: EACCES reading argus-reviewer-report' } },
  stale: {
    data: { state: clean, reject: 'gh timed out after 15s', failAfter: 1 },
    setup: async (page) => {
      await page.keyboard.press('r')
      await page.waitForSelector('#banner:not([hidden])')
    },
  },
  heals: { data: { state: clean }, view: 'heals' },
  'heals-partial': { data: { state: partialState }, view: 'heals' },
  'heals-empty': { data: { state: emptyState }, view: 'heals' },
  spend: { data: { state: clean }, view: 'spend' },
  'spend-empty': { data: { state: emptyState }, view: 'spend' },
  repo: { data: { state: clean }, view: 'repo' },
  'repo-partial': { data: { state: partialState }, view: 'repo' },
  'repo-empty': { data: { state: emptyState }, view: 'repo' },
  confirm: {
    data: { state: clean },
    setup: async (page) => {
      await page.click('#eval')
      await page.waitForFunction(() => !document.getElementById('ecrun').disabled)
    },
  },
  help: {
    data: { state: clean },
    setup: async (page) => {
      await page.keyboard.press('?')
      await page.waitForSelector('#help[open]')
    },
  },
}

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
 * runs. `runEval` records its options and never spawns anything. `spec` is
 * a collector state, or `{ state, reject, failAfter }` to make collect fail.
 */
export async function installBridgeStub(page, spec = seededState, plan = seededPlan) {
  const data = spec && ('state' in spec || 'reject' in spec) ? spec : { state: spec }
  await page.addInitScript(({ data, plan }) => {
    const g = globalThis
    g.__evalCalls = []
    g.__planFails = false
    g.__collectCalls = 0
    g.__collectFails = undefined
    g.__evalLog = undefined
    g.argus = {
      collect: async () => {
        g.__collectCalls++
        // __collectFails: a message forces a failure, null forces success.
        const scripted = data.reject !== undefined && g.__collectCalls > (data.failAfter ?? 0) ? data.reject : undefined
        const fail = g.__collectFails === undefined ? scripted : (g.__collectFails ?? undefined)
        if (fail !== undefined) throw new Error(fail)
        return structuredClone(data.state)
      },
      evalPlan: async () => {
        if (g.__planFails) throw new Error('plan read failed')
        return plan
      },
      runEval: async (opts) => {
        g.__evalCalls.push(opts ?? null)
        return { ok: true }
      },
      runLogs: async () => ({ ok: true }),
      onEvalLog: (cb) => {
        g.__evalLog = cb
      },
      onLiveLog: () => {},
      onRunLog: () => {},
    }
  }, { data, plan })
}

/**
 * Serve the desk front end over loopback HTTP with the same path map the
 * Electron app scheme uses (electron/desk-files.mjs). Resolves to
 * `{ url, close }`.
 */
export async function serveElectron() {
  const server = createServer(async (req, res) => {
    const file = deskFile(req.url ?? '/')
    try {
      if (file === undefined) throw new Error('not found')
      const body = await readFile(file)
      res.writeHead(200, { 'content-type': mimeOf(file) })
      res.end(body)
    } catch {
      res.writeHead(404)
      res.end('not found')
    }
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address()
  return { url: `http://127.0.0.1:${port}/`, close: () => new Promise((r) => server.close(r)) }
}
