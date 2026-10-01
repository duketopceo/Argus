#!/usr/bin/env node
// Judge scoring for ce-optimize/review-finding-quality.
//
// Reads evals/review-quality/results/<label>.json (+ .diffs.json), samples
// findings stratified by severity, batches them to an OpenRouter judge
// model with the rubric + the diff hunk each finding cites, and writes
// <label>.judge.json with per-finding scores and aggregates.
//
// Usage: node evals/review-quality/judge.mjs --label <name>
// Env:   OPENROUTER_API_KEY (required), JUDGE_MODEL (default
//        google/gemini-2.5-flash-lite)
// Stdout: aggregate JSON {mean_finding_score, fp_rate, severity_accuracy,
//        judge_cost_usd, judged, sampled}

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const RESULTS = join(ROOT, 'evals/review-quality/results')
const RUBRIC_PATH = join(ROOT, 'evals/review-quality/JUDGE_RUBRIC.md')

const SAMPLE = { high: 40, low: 20 } // bug|risk / nit|q
const BATCH = 5
const SEED = 42
// gemini-2.5-flash-lite published pricing ($/token) — estimate only; the
// authoritative number is the OpenRouter generation record.
const PRICE = { in: 0.10e-6, out: 0.40e-6 }

function arg(name) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

// Deterministic seeded PRNG (mulberry32) for reproducible sampling.
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function shuffle(arr, rand) {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

function fileDiff(diff, file) {
  // Extract the `diff --git` section for one file from a unified diff.
  const sections = diff.split(/(?=^diff --git )/m)
  const hit = sections.find((s) => s.startsWith(`diff --git a/${file} b/${file}`))
  if (hit) return hit.slice(0, 12000)
  // Fallback: loose match on the b-side path
  const loose = sections.find((s) => s.includes(` b/${file}`))
  return loose ? loose.slice(0, 12000) : '(file diff not found)'
}

async function judgeBatch(batch, rubric, model) {
  const findings = batch
    .map(
      (f) => `### Finding ${f.id} (corpus item \`${f.item}\`)
\`\`\`
severity: ${f.severity}   category: ${f.category ?? 'n/a'}   ${f.file}:${f.line ?? '?'}
message: ${f.message}
${f.suggestion ? `suggestion: ${f.suggestion}` : ''}
\`\`\`
Diff for \`${f.file}\`:
\`\`\`diff
${f.diff}
\`\`\``,
    )
    .join('\n\n')

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: rubric },
        {
          role: 'user',
          content:
            'Score each finding below. Judge ONLY against the supplied diff — ' +
            'treat code outside the diff as unknown but plausibly correct. ' +
            'Return JSON: {"findings":[{"id","score","tags","reason"}]} ' +
            'with every id shown.\n\n' + findings,
        },
      ],
    }),
  })
  if (!res.ok) throw new Error(`judge call failed: ${res.status} ${(await res.text()).slice(0, 200)}`)
  const data = await res.json()
  const usage = data.usage ?? {}
  const cost = (usage.prompt_tokens ?? 0) * PRICE.in + (usage.completion_tokens ?? 0) * PRICE.out
  let parsed
  try {
    parsed = JSON.parse(data.choices[0].message.content)
  } catch {
    throw new Error('judge returned non-JSON content')
  }
  return { findings: parsed.findings ?? [], cost }
}

async function main() {
  const label = arg('label')
  if (!label) {
    console.error('usage: node evals/review-quality/judge.mjs --label <name>')
    process.exit(2)
  }
  if (!process.env.OPENROUTER_API_KEY) {
    console.error('OPENROUTER_API_KEY is required (judge calls).')
    process.exit(2)
  }
  const model = process.env.JUDGE_MODEL ?? 'google/gemini-2.5-flash-lite'
  const rubric = readFileSync(RUBRIC_PATH, 'utf8')
  const results = JSON.parse(readFileSync(join(RESULTS, `${label}.json`), 'utf8'))
  const diffs = existsSync(join(RESULTS, `${label}.diffs.json`))
    ? JSON.parse(readFileSync(join(RESULTS, `${label}.diffs.json`), 'utf8')).diffs
    : {}

  // Flatten findings with stable ids.
  let seq = 0
  const all = []
  for (const item of results.items) {
    for (const f of item.findings) {
      all.push({
        id: `f${++seq}`,
        item: item.name,
        ...f,
        diff: fileDiff(diffs[item.name] ?? '', f.file),
      })
    }
  }

  const rand = rng(SEED)
  // Ground-truth items are small and are where FP signal lives — judge every
  // finding they produced. Noisy precisionOnly items (real-PR snapshots that
  // flood nits) get a stratified sample.
  const precisionOnlyItems = new Set(
    results.items.filter((i) => i.precisionOnly).map((i) => i.name),
  )
  const guaranteed = all.filter((f) => !precisionOnlyItems.has(f.item))
  const pool = all.filter((f) => precisionOnlyItems.has(f.item))
  const high = pool.filter((f) => ['bug', 'risk'].includes(f.severity))
  const low = pool.filter((f) => !['bug', 'risk'].includes(f.severity))
  const sampled = [
    ...guaranteed,
    ...shuffle(high, rand).slice(0, SAMPLE.high),
    ...shuffle(low, rand).slice(0, SAMPLE.low),
  ]

  const batches = []
  for (let i = 0; i < sampled.length; i += BATCH) batches.push(sampled.slice(i, i + BATCH))

  const judged = []
  let judgeCost = 0
  for (const [i, batch] of batches.entries()) {
    console.error(`[judge] batch ${i + 1}/${batches.length} (${batch.map((f) => f.id).join(',')})`)
    const r = await judgeBatch(batch, rubric, model)
    judgeCost += r.cost
    for (const jf of r.findings) {
      const src = batch.find((f) => f.id === jf.id)
      judged.push({ ...(src ?? {}), score: jf.score, tags: jf.tags ?? [], reason: jf.reason ?? '' })
    }
  }

  const scored = judged.filter((j) => typeof j.score === 'number')
  const realEnough = scored.filter((j) => j.score >= 3)
  const aggregate = {
    mean_finding_score: scored.length
      ? +(scored.reduce((s, j) => s + j.score, 0) / scored.length).toFixed(4)
      : 0,
    fp_rate: scored.length
      ? +(scored.filter((j) => j.score <= 2).length / scored.length).toFixed(4)
      : 0,
    severity_accuracy: realEnough.length
      ? +(realEnough.filter((j) => !j.tags.includes('wrong_severity')).length / realEnough.length).toFixed(4)
      : null,
    judge_cost_usd: +judgeCost.toFixed(4),
    judged: scored.length,
    sampled: sampled.length,
    total_findings: all.length,
    sample_seed: SEED,
    judge_model: model,
  }

  writeFileSync(
    join(RESULTS, `${label}.judge.json`),
    JSON.stringify({ label, at: new Date().toISOString(), aggregate, findings: judged }, null, 2),
  )
  console.log(JSON.stringify(aggregate, null, 2))
}

await main()
