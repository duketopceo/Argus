#!/usr/bin/env node
// LLM-judge pass for the Ocellus subset (no planted ground truth). Each distinct finding is shown to a
// cheap judge model with the changed file's diff plus head-file context and rated valid/invalid/unclear.
// "valid" = a concrete defect or risk actually supported by the code shown (not hallucinated, not
// already handled, not a pure style/preference). The judge is itself a model: treat as a noisy proxy.
//   orch node evals/reviewer-bakeoff/judge.mjs --work <dir with ocellus/ repo> [--judge deepseek/deepseek-v4-pro]
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const dir = new URL('.', import.meta.url).pathname
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d }
const WORK = resolve(arg('work'))
const JUDGE = arg('judge', 'deepseek/deepseek-v4-pro')
const repo = join(WORK, 'ocellus')
const rt = JSON.parse(readFileSync(dir + 'results.json', 'utf8')).realtime.filter((r) => r.fixture === 'ocellus' && !r.error)
const bt = existsSync(dir + 'results-batch.json') ? JSON.parse(readFileSync(dir + 'results-batch.json', 'utf8')).batch : []
const items = new Map()
const add = (f) => { const k = `${f.file}:${f.line}:${f.message}`; if (!items.has(k)) items.set(k, f) }
for (const r of rt) r.findings.forEach(add)
for (const b of bt) (b.findings?.ocellus ?? []).forEach(add)
const OUT = dir + 'judged.json'
const judged = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : { judge: JUDGE, verdicts: {}, costUsd: 0 }
const key = process.env.OPENROUTER_API_KEY
const ctx = (f) => {
  const diff = spawnSync('git', ['-C', repo, 'diff', 'argus-fixture-base..HEAD', '--', f.file], { encoding: 'utf8', maxBuffer: 1 << 26 }).stdout
  const head = spawnSync('git', ['-C', repo, 'show', `HEAD:${f.file}`], { encoding: 'utf8', maxBuffer: 1 << 26 })
  const lines = head.status === 0 ? head.stdout.split('\n') : []
  const n = Number(f.line) || 1
  const snippet = lines.slice(Math.max(0, n - 25), n + 25).map((l, i) => `${Math.max(0, n - 25) + i + 1}: ${l}`).join('\n')
  return { diff: diff.slice(0, 14000), snippet, exists: lines.length > 0, total: lines.length }
}
let done = 0
await Promise.all([...items.entries()].map(async ([k, f]) => {
  if (judged.verdicts[k]) return
  const c = ctx(f)
  const prompt = `You are auditing an automated code-review finding for correctness. Decide whether the finding is a REAL, concrete defect or risk in the code under review.\n\nFinding (${f.severity}) at ${f.file}:${f.line}\n${f.message}\n\nHead-file context around that line:\n${c.snippet}\n\nDiff of the file in this PR (base..head):\n${c.diff}\n\nRules: "valid" = the problem genuinely exists in the code shown and a maintainer would want it fixed; "invalid" = hallucinated, misreads the code, already handled, contradicted by the context, or about code not in the diff; "unclear" = plausible but cannot be confirmed from what is shown; style/preference-only claims are "invalid" unless severity is nit/q.\nReply with ONLY JSON: {"verdict":"valid"|"invalid"|"unclear","reason":"<=25 words"}`
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: JUDGE, messages: [{ role: 'user', content: prompt }], response_format: { type: 'json_object' }, max_tokens: 1500 }),
  })
  const j = await res.json()
  try {
    const v = JSON.parse(String(j.choices[0].message.content).replace(/^```json\s*|```$/g, ''))
    judged.verdicts[k] = { verdict: v.verdict, reason: v.reason }
    judged.costUsd += j.usage?.cost ?? 0
  } catch { judged.verdicts[k] = { verdict: 'error', reason: JSON.stringify(j).slice(0, 120) } }
  if (++done % 10 === 0) writeFileSync(OUT, JSON.stringify(judged, null, 2))
}))
writeFileSync(OUT, JSON.stringify(judged, null, 2))
console.log('judged', Object.keys(judged.verdicts).length, 'distinct findings; judge cost $' + judged.costUsd.toFixed(4))
