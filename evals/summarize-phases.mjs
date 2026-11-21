#!/usr/bin/env node
/**
 * Fold an evals/run-phases.mjs results file into the numbers the eval doc quotes.
 * Prints a JSON summary to stdout (or writes it with --out). Pure arithmetic on the
 * raw rows: nothing is dropped, every pass and fail row is counted.
 *
 *   node evals/summarize-phases.mjs a.json [b.json ...] [--exclude task,task] [--out summary.json]
 *
 * Several files are merged row-for-row (a later run of an added task, for example).
 * --exclude drops tasks from the headline numbers only; the raw files keep every row.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const optIdx = argv.findIndex((a) => a.startsWith('--'))
const files = optIdx === -1 ? argv : argv.slice(0, optIdx)
const rest = optIdx === -1 ? [] : argv.slice(optIdx)
const outIdx = rest.indexOf('--out')
const exIdx = rest.indexOf('--exclude')
const exclude = exIdx === -1 ? [] : rest[exIdx + 1].split(',')
const docs = files.map((f) => JSON.parse(readFileSync(f, 'utf8')))
const rows = docs.flatMap((d) => d.runs).filter((r) => !exclude.includes(r.task))
const doc = { spentUsd: docs.reduce((n, d) => n + (d.spentUsd ?? 0), 0) }
const file = files.join(' + ')
const PHASES = ['cold', 'warm', 'drift', 'warm-heal']

const median = (a) => {
  if (a.length === 0) return null
  const s = [...a].sort((x, y) => x - y)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const sum = (a) => a.reduce((n, x) => n + x, 0)

export function classify(msg) {
  if (msg === null || msg === undefined) return 'none'
  if (/OpenRouter .*(4\d\d|5\d\d)|request failed/i.test(msg)) return 'api-error'
  if (/model grounded to/.test(msg)) return 'wrong-element'
  if (/without coordinates/.test(msg)) return 'no-coordinates'
  if (/^assert\(/.test(msg)) return 'assert-failed'
  if (/timeout|timed out/i.test(msg)) return 'timeout'
  if (/budget/i.test(msg)) return 'budget'
  return 'other'
}

const models = [...new Set(rows.map((r) => r.model))]
const out = { source: file, excluded: exclude, spentUsd: doc.spentUsd, models: {} }
for (const model of models) {
  const mr = rows.filter((r) => r.model === model)
  const reps = [...new Set(mr.map((r) => r.rep))].sort((a, b) => a - b)
  const m = { reps: reps.length, phases: {} }
  for (const phase of PHASES) {
    const pr = mr.filter((r) => r.phase === phase)
    const ok = pr.filter((r) => r.ok)
    const perRep = reps.map((rep) => {
      const x = pr.filter((r) => r.rep === rep)
      return { calls: sum(x.map((r) => r.visionCalls)), cost: sum(x.map((r) => r.costUsd)) }
    })
    const failed = pr.filter((r) => !r.ok)
    const tax = {}
    for (const f of failed)
      tax[classify(f.failureMessage)] = (tax[classify(f.failureMessage)] ?? 0) + 1
    m.phases[phase] = {
      k: ok.length,
      n: pr.length,
      callsPerSuiteRun: sum(perRep.map((x) => x.calls)) / Math.max(1, perRep.length),
      costPerSuiteRun: sum(perRep.map((x) => x.cost)) / Math.max(1, perRep.length),
      costTotal: sum(pr.map((r) => r.costUsd)),
      callsTotal: sum(pr.map((r) => r.visionCalls)),
      medianTaskMs: median(pr.map((r) => r.durationMs)),
      medianPassedTaskMs: median(ok.map((r) => r.durationMs)),
      failureKinds: tax,
    }
  }
  // heal: drift-phase task-runs that had a cached recording (the cold run passed) and re-grounded
  const coldOk = new Set(
    mr.filter((r) => r.phase === 'cold' && r.ok).map((r) => `${r.rep}/${r.task}`),
  )
  const drift = mr.filter((r) => r.phase === 'drift')
  const eligible = drift.filter((r) => coldOk.has(`${r.rep}/${r.task}`))
  const healed = eligible.filter((r) => r.healEvents > 0 || r.cache?.heals > 0)
  const driftNoHeal = eligible.filter((r) => !(r.healEvents > 0 || r.cache?.heals > 0))
  m.heal = {
    eligible: eligible.length,
    attempted: healed.length,
    succeeded: healed.filter((r) => r.ok).length,
    replayedWithoutHeal: driftNoHeal.length,
    replayedWithoutHealPassed: driftNoHeal.filter((r) => r.ok).length,
    driftPassGivenColdPass: `${eligible.filter((r) => r.ok).length}/${eligible.length}`,
    // Every drift task-run where at least one heal fired, whatever the cold outcome.
    // A heal step is "accepted" when the grounded element passed the step check; the task
    // only passes if the action also took effect (the following assertion).
    taskRunsWithHeal: drift.filter((r) => r.healEvents > 0).length,
    taskRunsWithHealPassed: drift.filter((r) => r.healEvents > 0 && r.ok).length,
    healSteps: drift.reduce((n, r) => n + r.healEvents, 0),
    healStepsAccepted: drift.reduce(
      (n, r) => n + (r.steps ?? []).filter((s) => s.healed && s.ok).length,
      0,
    ),
  }
  // cached replay conditional on a cold pass
  const warm = mr.filter((r) => r.phase === 'warm')
  const warmEligible = warm.filter((r) => coldOk.has(`${r.rep}/${r.task}`))
  m.warmGivenColdPass = `${warmEligible.filter((r) => r.ok).length}/${warmEligible.length}`
  m.warmEligibleZeroCall = `${warmEligible.filter((r) => r.visionCalls === 0).length}/${warmEligible.length}`
  const wh = mr.filter((r) => r.phase === 'warm-heal')
  const whEligible = wh.filter((r) =>
    drift.some((d) => d.rep === r.rep && d.task === r.task && d.ok),
  )
  m.warmHealGivenDriftPass = `${whEligible.filter((r) => r.ok).length}/${whEligible.length}`
  m.warmHealEligibleZeroCall = `${whEligible.filter((r) => r.visionCalls === 0).length}/${whEligible.length}`
  // per-task pass table
  m.perTask = {}
  for (const task of [...new Set(mr.map((r) => r.task))].sort()) {
    m.perTask[task] = Object.fromEntries(
      PHASES.map((p) => {
        const x = mr.filter((r) => r.task === task && r.phase === p)
        return [p, `${x.filter((r) => r.ok).length}/${x.length}`]
      }),
    )
  }
  // failure examples (first distinct per kind)
  m.examples = {}
  for (const r of mr.filter((x) => !x.ok)) {
    const k = classify(r.failureMessage)
    if (!m.examples[k])
      m.examples[k] = {
        task: r.task,
        phase: r.phase,
        message: String(r.failureMessage ?? r.stderrTail ?? '')
          .replace(/\s+/g, ' ')
          .slice(0, 220),
      }
  }
  out.models[model] = m
}
const text = `${JSON.stringify(out, null, 2)}\n`
if (outIdx !== -1) writeFileSync(rest[outIdx + 1], text)
else process.stdout.write(text)
