#!/usr/bin/env node
// Realtime bake-off harness. Runs the real `argus-reviewer code-review --fixture` path with
// ARGUS_CODE_MODEL overridden, under `orch` (dedicated capped eval key). Resumable; hard spend cap.
//   node evals/reviewer-bakeoff/run.mjs [--work <dir>] [--cap 4] [--models a,b] [--demo-runs 2]
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { materializeDemo, materializeOcellus } from './materialize.mjs'
import { scoreDemo, scoreNoise } from './score.mjs'

const ROOT = resolve(new URL('../..', import.meta.url).pathname)
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d }
const WORK = resolve(arg('work', join(process.env.TMPDIR ?? '/tmp', 'argus-bakeoff-work')))
const CAP = Number(arg('cap', '4'))
const DEMO_RUNS = Number(arg('demo-runs', '5'))
const OCELLUS_RUNS = Number(arg('ocellus-runs', '2'))
const OUT = join(ROOT, 'evals/reviewer-bakeoff/results.json')
const MODELS = (arg('models', '') || [
  'google/gemini-2.5-flash-lite', 'deepseek/deepseek-v4.1-flash', 'deepseek/deepseek-v4-flash', 'z-ai/glm-5.3',
  'z-ai/glm-5.3-flash', 'qwen/qwen3-coder', 'openai/gpt-oss-120b',
].join(',')).split(',')

mkdirSync(WORK, { recursive: true })
writeFileSync(join(WORK, 'argus-reviewer.config.ts'), `export default { model: 'google/gemini-2.5-flash-lite', budgetUsd: 1, codeReviewBudgetUsd: 0.6, target: { command: '', url: 'file:///dev/null', readyTimeoutMs: 0 }, cacheDir: '.cache', sandbox: { enabled: false } }\n`)
const repos = { demo: materializeDemo(ROOT, WORK), ocellus: materializeOcellus(ROOT, WORK) }
const results = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : { realtime: [], batch: [] }
const spent = () => results.realtime.reduce((s, r) => s + (r.totalCostUsd ?? 0), 0) + results.batch.reduce((s, r) => s + (r.costUsd ?? 0), 0)

function runOne(model, fixture, rep) {
  const reportDir = join(WORK, 'reports', model.replace('/', '__'), `${fixture}-${rep}`)
  mkdirSync(reportDir, { recursive: true })
  const t0 = Date.now()
  const p = spawnSync(join(homedir(), 'bin/orch'), ['node', join(ROOT, 'dist/cli.js'), 'code-review', '--fixture', repos[fixture], '--report-dir', reportDir], {
    cwd: WORK, env: { ...process.env, ARGUS_CODE_MODEL: model, ARGUS_BUDGET_USD: '0.5' }, encoding: 'utf8', timeout: 900_000,
  })
  const latencyS = (Date.now() - t0) / 1000
  const rp = join(reportDir, 'code-review.json')
  if (!existsSync(rp)) return { model, fixture, rep, error: `${p.stdout ?? ''}${p.stderr ?? ''}`.split('\n').filter((l) => /fail|error|timeout|abort|Error/i.test(l) && !/^\s+argus-reviewer/.test(l)).join(' ').slice(0, 300) || 'no report', latencyS, totalCostUsd: 0 }
  const r = JSON.parse(readFileSync(rp, 'utf8'))
  const codeCalls = (r.calls ?? []).filter((c) => c.kind === 'code')
  const row = {
    model, fixture, rep, mode: 'realtime', latencyS, verdict: r.verdict, skipped: !!r.skipped,
    totalCostUsd: r.visionCostUsd ?? 0, codeCostUsd: codeCalls.reduce((s, c) => s + (c.costUsd ?? 0), 0), codeCalls: codeCalls.length,
    tokens: r.tokens, summary: (r.summary ?? '').slice(0, 200),
    findings: (r.findings ?? []).map((f) => ({ file: f.file, line: f.line, severity: f.severity, message: String(f.message).slice(0, 160) })),
  }
  row.score = fixture === 'demo' ? scoreDemo(row.findings) : scoreNoise(row.findings, r.validation?.dropped ?? 0)
  if (r.validation) row.validation = { dropped: r.validation.dropped, byReason: r.validation.byReason }
  return row
}

for (const model of MODELS) {
  for (const [fixture, reps] of [['demo', DEMO_RUNS], ['ocellus', OCELLUS_RUNS]]) {
    for (let rep = 0; rep < reps; rep++) {
      if (results.realtime.some((r) => r.model === model && r.fixture === fixture && r.rep === rep && !r.error)) continue
      if (fixture === 'ocellus' && results.realtime.filter((r) => r.model === model && r.fixture === 'demo').every((r) => r.error)) continue // unusable model
      if (fixture === 'ocellus' && rep > 0 && results.realtime.some((r) => r.model === model && r.fixture === 'ocellus' && r.rep === 0 && r.error)) continue // timed out on rep 0: do not burn another 2+ minutes
      if (spent() >= CAP) { console.error(`cap ${CAP} reached ($${spent().toFixed(4)}); stopping`); process.exit(2) }
      const row = runOne(model, fixture, rep)
      results.realtime = results.realtime.filter((r) => !(r.model === model && r.fixture === fixture && r.rep === rep))
      results.realtime.push(row)
      writeFileSync(OUT, JSON.stringify(results, null, 2))
      console.log(`${model} ${fixture}#${rep} ${row.error ? 'ERROR ' + row.error : `findings=${row.findings.length} cost=$${row.totalCostUsd.toFixed(5)} ${row.latencyS.toFixed(0)}s`} | cumulative $${spent().toFixed(4)}`)
    }
  }
}
