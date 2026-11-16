#!/usr/bin/env node
/**
 * argus phase eval: the demo-suite run in four phases per (model, replicate).
 *
 *   cold        empty cache; the model grounds every step
 *   warm        same cache, same UI; expected: cache hits, no model call, $0
 *   drift       cache kept, UI swapped to drifted.html; expected: fingerprint
 *               mismatch, the model re-grounds ("heals")
 *   warm-heal   cache kept after healing, drifted UI again; expected: $0 replay
 *
 * Every task-run is appended to <out>.jsonl the moment it finishes, pass or
 * fail, then folded into <out>.json. Nothing is retried or filtered.
 *
 * usage (key arrives via the environment only):
 *   orch node evals/run-phases.mjs --models a,b --reps 3 --cap 3 --out evals/results/<name>
 *   flags: --work <dir> --escalation self|<model id>  --concurrency 2  --tasks 01,02  --budget-run 0.25
 */
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const flag = (n, d) => {
  const i = args.indexOf(`--${n}`)
  return i === -1 ? d : args[i + 1]
}
const models = flag('models', 'google/gemini-2.5-flash').split(',')
const reps = Number(flag('reps', '3'))
const repFrom = Number(flag('rep-from', '1')) // resume a part-finished run: replicates repFrom..reps
const capUsd = Number(flag('cap', '3'))
const concurrency = Number(flag('concurrency', '2'))
const budgetRun = Number(flag('budget-run', '0.25'))
const escalation = flag('escalation', 'self') // 'self' = escalation_model is the model under test (no second model); or a model id
const taskFilter = flag('tasks')?.split(',')
const outBase = resolve(repo, flag('out', 'evals/results/phases'))
const workRoot = join(repo, flag('work', 'evals/work/phases'))
const basePort = Number(flag('port', '4410'))
const PHASES = ['cold', 'warm', 'drift', 'warm-heal']

if (!process.env.OPENROUTER_API_KEY) {
  console.error('OPENROUTER_API_KEY is required')
  process.exit(1)
}
mkdirSync(dirname(outBase), { recursive: true })
mkdirSync(workRoot, { recursive: true })

let spent = 0
let stop = false
const jsonl = `${outBase}.jsonl`

function sh(cmd, argv, opts) {
  return new Promise((res) => {
    const p = spawn(cmd, argv, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (err += d))
    const t = setTimeout(() => p.kill('SIGKILL'), 900_000)
    p.on('close', (code) => {
      clearTimeout(t)
      res({ code, out, err })
    })
  })
}

async function job(model, rep, port) {
  const slug = model.replace(/[^a-z0-9]+/gi, '-')
  const ws = join(workRoot, `${slug}-r${rep}`)
  rmSync(ws, { recursive: true, force: true })
  mkdirSync(join(ws, 'tests'), { recursive: true })
  mkdirSync(join(ws, 'home'), { recursive: true })
  cpSync(join(repo, 'evals/demo-suite'), join(ws, 'tests'), {
    recursive: true,
    filter: (src) =>
      !taskFilter || !src.endsWith('.test.ts') || taskFilter.some((t) => src.includes(`/${t}`)),
  })
  writeFileSync(
    join(ws, 'argus-reviewer.config.json'),
    JSON.stringify({
      model,
      escalation_model: escalation === 'self' ? model : escalation,
      budgetUsd: budgetRun,
      target: { url: `http://127.0.0.1:${port}/` },
      testsDir: 'tests',
      cacheDir: '.cache',
      reportDir: 'report',
    }),
  )
  const server = spawn('node', [join(repo, 'evals/demo-app/serve.mjs'), String(port), ws], {
    stdio: 'ignore',
  })
  let up = false
  for (let i = 0; i < 40 && !up; i++) {
    await new Promise((r) => setTimeout(r, 150))
    up = await fetch(`http://127.0.0.1:${port}/`).then(
      (r) => r.ok,
      () => false,
    )
  }
  if (!up) throw new Error(`demo server did not come up on ${port} (port in use?)`)
  try {
    for (const phase of PHASES) {
      if (stop) return
      writeFileSync(
        join(ws, 'active'),
        phase === 'drift' || phase === 'warm-heal' ? 'drifted.html' : 'index.html',
      )
      rmSync(join(ws, 'report'), { recursive: true, force: true })
      const t0 = Date.now()
      const r = await sh('nice', ['node', join(repo, 'dist/cli.js'), 'run'], {
        cwd: ws,
        env: {
          ...process.env,
          HOME: join(ws, 'home'),
          PLAYWRIGHT_BROWSERS_PATH: join(homedir(), '.cache/ms-playwright'),
          NO_COLOR: '1',
          CI: '',
        },
      })
      const wallMs = Date.now() - t0
      let report
      try {
        report = JSON.parse(readFileSync(join(ws, 'report/run.json'), 'utf8'))
      } catch {
        report = undefined
      }
      mkdirSync(join(ws, 'snap', phase), { recursive: true })
      if (report) writeFileSync(join(ws, 'snap', phase, 'run.json'), JSON.stringify(report))
      if (existsSync(join(ws, '.cache')))
        cpSync(join(ws, '.cache'), join(ws, 'snap', phase, 'cache'), {
          recursive: true,
          filter: (src) => !src.includes('/journal') && !src.endsWith('.ndjson'),
        })
      if (!report) {
        appendFileSync(
          jsonl,
          JSON.stringify({
            model,
            rep,
            phase,
            task: '*',
            ok: false,
            noReport: true,
            exitCode: r.code,
            stderrTail: r.err.split('\n').slice(-4),
            wallMs,
          }) + '\n',
        )
        continue
      }
      for (const t of report.tests) {
        const rec = {
          model,
          rep,
          phase,
          task: t.file ? t.file.split('/').pop().replace('.test.ts', '') : t.name,
          testName: t.name,
          ok: t.ok,
          failureMessage: t.failureMessage ?? null,
          visionCalls: t.visionCalls,
          costUsd: t.visionCostUsd,
          durationMs: t.durationMs,
          healEvents: t.healEvents.length,
          cache: t.cache,
          calls: t.calls.map((c) => ({ kind: c.kind, tokens: c.tokens, costUsd: c.costUsd })),
          steps: t.steps.map((s) => ({
            instruction: s.instruction,
            action: s.action,
            ok: s.ok,
            healed: s.healed,
          })),
          asserts: t.asserts.map((a) => ({
            question: a.question,
            verdict: a.verdict,
            cached: a.cached,
          })),
          exitCode: r.code,
        }
        appendFileSync(jsonl, JSON.stringify(rec) + '\n')
      }
      spent += report.totals.visionCostUsd
      console.log(
        `${model} r${rep} ${phase}: ${report.totals.passed}/${report.totals.tests} calls=${report.totals.visionCalls} $${report.totals.visionCostUsd.toFixed(4)} total=$${spent.toFixed(4)}`,
      )
      if (spent > capUsd * 0.95) {
        stop = true
        console.error('spend cap reached; stopping')
      }
    }
  } finally {
    server.kill('SIGTERM')
  }
}

const queue = []
for (const model of models) for (let rep = repFrom; rep <= reps; rep++) queue.push([model, rep])
const workers = Array.from({ length: concurrency }, async (_, i) => {
  while (queue.length && !stop) {
    const [model, rep] = queue.shift()
    await job(model, rep, basePort + i)
  }
})
await Promise.all(workers)
const rows = existsSync(jsonl)
  ? readFileSync(jsonl, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
  : []
writeFileSync(
  `${outBase}.json`,
  `${JSON.stringify({ generatedAt: new Date().toISOString(), suite: 'evals/demo-suite', phases: PHASES, models, reps, capUsd, spentUsd: spent, stoppedEarly: stop, runs: rows }, null, 2)}\n`,
)
console.log(`done: ${rows.length} task-runs, spent $${spent.toFixed(4)}`)
