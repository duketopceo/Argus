#!/usr/bin/env node
// OpenRouter Batch bake-off. Replays Argus's real per-chunk code-review prompt
// (buildPatchChunks + buildCodeReviewMessages from dist/cli.js) for both fixtures as ONE batch
// per model, then scores findings exactly like the realtime path (validateFindings from dist).
// Differences vs realtime (caveats): json_object instead of the strict json_schema, no synthesis
// call, no secrets-scan / triage lanes. Cost is usage.cost as reported by the batch.
//   node evals/reviewer-bakeoff/batch.mjs [--work <dir>] [--models a,b] [--cap 4]
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
const OUT = join(ROOT, 'evals/reviewer-bakeoff/results.json')
const RT = join(ROOT, 'evals/reviewer-bakeoff/results.json')
const MODELS = (arg('models', 'google/gemini-2.5-flash-lite,z-ai/glm-5.3,z-ai/glm-5.3-flash,deepseek/deepseek-v4.1-flash,openai/gpt-oss-120b')).split(',')
const { buildPatchChunks, buildCodeReviewMessages, filesFromUnifiedDiff } = await import(join(ROOT, 'dist/cli.js'))
const { validateFindings } = await import(join(ROOT, 'dist/review/validate.js'))

mkdirSync(WORK, { recursive: true })
const repos = { demo: materializeDemo(ROOT, WORK), ocellus: materializeOcellus(ROOT, WORK) }
const fixtures = {}
for (const [name, repo] of Object.entries(repos)) {
  const diff = spawnSync('git', ['-C', repo, 'diff', 'argus-fixture-base..HEAD'], { encoding: 'utf8', maxBuffer: 1 << 28 }).stdout
  const files = filesFromUnifiedDiff(diff)
  const chunks = buildPatchChunks(files, {})
  fixtures[name] = { files, messages: chunks.map((c, i) => buildCodeReviewMessages(name, '0', c, i, chunks.length)) }
}

const key = spawnSync(join(homedir(), 'bin/orch'), ['bash', '-c', 'printf %s "$OPENROUTER_API_KEY"'], { encoding: 'utf8' }).stdout.trim()
const H = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }
const results = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : { realtime: [], batch: [] }
const rtSpent = () => (existsSync(RT) ? JSON.parse(readFileSync(RT, 'utf8')).realtime : []).reduce((s, r) => s + (r.totalCostUsd ?? 0), 0)
const spent = () => rtSpent() + results.batch.reduce((s, r) => s + (r.costUsd ?? 0), 0)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

if (spent() >= CAP) { console.error('cap reached'); process.exit(2) }
await Promise.all(MODELS.map(async (model) => {
  if (results.batch.some((b) => b.model === model && !b.error)) return
  const requests = []
  for (const [name, fx] of Object.entries(fixtures)) fx.messages.forEach((m, i) => requests.push({
    custom_id: `${name}:${i}`,
    body: { model, messages: m, response_format: { type: 'json_object' }, max_tokens: 6000 },
  }))
  const t0 = Date.now()
  const create = await fetch('https://openrouter.ai/api/v1/batches', { method: 'POST', headers: H, body: JSON.stringify({ endpoint: '/v1/chat/completions', model, requests }) })
  const b = await create.json()
  if (!b.id) { results.batch.push({ model, mode: 'batch', error: JSON.stringify(b).slice(0, 300) }); return }
  let j = b
  while (!['completed', 'failed', 'expired', 'cancelled'].includes(j.status)) {
    await sleep(15_000)
    j = await (await fetch(`https://openrouter.ai/api/v1/batches/${b.id}`, { headers: H })).json()
  }
  const latencyS = (Date.now() - t0) / 1000
  const lines = Array.isArray(j.results) ? j.results : typeof j.results === 'string'
    ? (await (await fetch(j.results, { headers: H })).text()).split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
  const per = { demo: [], ocellus: [] }
  let errors = 0
  for (const l of lines) {
    const [name] = String(l.custom_id).split(':')
    const resp = l.response?.body ?? l.response ?? l.body
    const content = resp?.choices?.[0]?.message?.content
    try { per[name].push(...(JSON.parse(String(content).replace(/^```json\s*|```$/g, '')).findings ?? [])) } catch { errors++ }
  }
  const norm = (arr, fx) => {
    const v = validateFindings(arr, fx.files, new Set())
    return { kept: v.kept, dropped: v.dropped.length }
  }
  const d = norm(per.demo, fixtures.demo), o = norm(per.ocellus, fixtures.ocellus)
  results.batch = results.batch.filter((x) => x.model !== model)
  results.batch.push({
    model, mode: 'batch', batchId: b.id, status: j.status, latencyS, parseErrors: errors,
    costUsd: j.usage?.cost ?? j.usage?.total_cost ?? null, usage: j.usage, requestCounts: j.request_counts,
    demo: { ...scoreDemo(d.kept), preFilter: per.demo.length, dropped: d.dropped },
    ocellus: scoreNoise(o.kept.map((f) => ({ severity: f.severity, file: f.file })), o.dropped),
    findings: { demo: d.kept, ocellus: o.kept },
  })
  writeFileSync(OUT, JSON.stringify(results, null, 2))
  console.log(model, 'batch', j.status, `${latencyS.toFixed(0)}s`, 'cost', results.batch.at(-1).costUsd, '| cumulative', spent().toFixed(4))
}))
