// Eval spend plan — what `node evals/run.mjs` will do and roughly what it
// will cost, shown before the TUI (`e`) or dashboard ("run eval") spends
// real OpenRouter money. No network: the estimate comes from the most recent
// evals/results/*.json that covered each model.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

// Single source for evals/run.mjs defaults so the confirm text cannot drift
// from what the runner actually does.
export const DEFAULT_EVAL_MODELS = ['google/gemini-2.5-flash-lite', 'moonshotai/kimi-k2.5']
export const DEFAULT_EVAL_BUDGET_USD = 1
// run.mjs runs the suite twice per model: cold (vision calls) then warm
// (cache replay, expected $0). Each run carries its own budget cap.
export const RUNS_PER_MODEL = 2

// Readable reason for the confirm text — no raw errno strings.
const errMsg = (e) =>
  e?.code === 'ENOENT' ? 'not found' : e instanceof Error ? e.message : String(e)

function countSuiteCases(root) {
  const dir = join(root, 'evals/suite')
  const files = readdirSync(dir).filter((f) => f.endsWith('.test.ts'))
  let cases = 0
  for (const f of files) {
    const src = readFileSync(join(dir, f), 'utf8')
    cases += (src.match(/^\s*test\(/gm) ?? []).length
  }
  return { files: files.length, cases }
}

// model -> { costUsd, at } from the newest results file that ran it.
function lastCosts(root) {
  const dir = join(root, 'evals/results')
  const out = new Map()
  if (!existsSync(dir)) return out
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .reverse()
  for (const f of files) {
    let doc
    try {
      doc = JSON.parse(readFileSync(join(dir, f), 'utf8'))
    } catch {
      continue // a corrupt results file only loses its own data point
    }
    for (const r of doc?.results ?? []) {
      if (typeof r?.model !== 'string' || out.has(r.model)) continue
      const cold = Number(r.cold?.visionCostUsd)
      const warm = Number(r.warm?.visionCostUsd ?? 0)
      if (!Number.isFinite(cold) || !Number.isFinite(warm)) continue
      out.set(r.model, { costUsd: cold + warm, at: doc.generatedAt ?? f.replace(/\.json$/, '') })
    }
  }
  return out
}

/**
 * Build the plan. Never throws: a failure to read the suite or past results
 * comes back as `error`/`null` fields so the confirm step can still render
 * and be cancelled.
 */
export function evalPlan(root, { env = process.env } = {}) {
  const models = [...DEFAULT_EVAL_MODELS]
  const budgetUsd = DEFAULT_EVAL_BUDGET_USD
  const plan = {
    command: 'node evals/run.mjs',
    models: models.map((model) => ({ model, lastCostUsd: null, lastRunAt: null })),
    budgetUsd,
    capUsd: budgetUsd * RUNS_PER_MODEL * models.length,
    runsPerModel: RUNS_PER_MODEL,
    cases: null,
    estimateUsd: null,
    estimatePartial: false,
    keyPresent: Boolean(env.OPENROUTER_API_KEY),
    error: undefined,
  }
  const problems = []
  try {
    plan.cases = countSuiteCases(root).cases
  } catch (e) {
    problems.push(`could not read the eval suite in evals/suite (${errMsg(e)})`)
  }
  try {
    const costs = lastCosts(root)
    for (const m of plan.models) {
      const c = costs.get(m.model)
      if (c) {
        m.lastCostUsd = c.costUsd
        m.lastRunAt = c.at
      }
    }
    const known = plan.models.filter((m) => m.lastCostUsd !== null)
    if (known.length > 0) {
      plan.estimateUsd = known.reduce((n, m) => n + m.lastCostUsd, 0)
      plan.estimatePartial = known.length < plan.models.length
    }
  } catch (e) {
    problems.push(`could not read past eval results (${errMsg(e)})`)
  }
  if (problems.length > 0) plan.error = problems.join('; ')
  return plan
}

export const fmtUsd = (n) => `$${n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2)}`

/** Plain-text lines describing the plan; shared by TUI and dashboard. */
export function formatEvalPlan(plan) {
  const lines = []
  const cases = plan.cases === null ? 'unknown number of' : String(plan.cases)
  lines.push(
    `Runs ${plan.command}: ${cases} test case(s) x ${plan.models.length} model(s), ` +
      `${plan.runsPerModel} runs each (cold, then cached).`,
  )
  for (const m of plan.models) {
    const last =
      m.lastCostUsd === null ? 'no past cost on record' : `last run ${fmtUsd(m.lastCostUsd)}`
    lines.push(`  ${m.model}  (${last})`)
  }
  if (plan.estimateUsd === null) {
    lines.push('Estimated cost: unknown (no past eval results to go on).')
  } else {
    lines.push(
      `Estimated cost: about ${fmtUsd(plan.estimateUsd)}, based on the last recorded run` +
        `${plan.estimatePartial ? ' (some models have no past cost, so this is low)' : ''}.`,
    )
  }
  lines.push(
    `Budget cap: ${fmtUsd(plan.budgetUsd)} per run, at most ${fmtUsd(plan.capUsd)} in total. ` +
      'This spends real OpenRouter credit.',
  )
  if (plan.error) lines.push(`Note: ${plan.error}.`)
  if (!plan.keyPresent) lines.push('OPENROUTER_API_KEY is not set, so the eval cannot start.')
  return lines
}

/**
 * Map a raw TUI keypress to a confirm decision. Only an explicit `y`/`Y`
 * spends; Esc, n, Enter-by-default and everything else cancel or wait.
 */
export function confirmKey(key) {
  if (key === 'y' || key === 'Y') return 'confirm'
  if (key === 'n' || key === 'N' || key === '\x1b' || key === '\r' || key === '\n') return 'cancel'
  return 'ignore'
}

/**
 * Spend recorded so far by an eval that started at `sinceMs`: the sum of
 * `totals.visionCostUsd` in evals/work/<model>/report/run.json files written
 * since then. run.mjs overwrites each report with the cached warm run, so
 * this is a floor, not an exact figure. Returns null when nothing was
 * recorded (the eval failed before any model finished a run).
 */
export function evalSpendSince(root, sinceMs) {
  const work = join(root, 'evals/work')
  let total = null
  let dirs
  try {
    dirs = readdirSync(work)
  } catch {
    return null
  }
  for (const d of dirs) {
    const p = join(work, d, 'report/run.json')
    try {
      if (statSync(p).mtimeMs < sinceMs) continue
      const cost = Number(JSON.parse(readFileSync(p, 'utf8'))?.totals?.visionCostUsd)
      if (Number.isFinite(cost)) total = (total ?? 0) + cost
    } catch {
      // missing or half-written report: no data point
    }
  }
  return total
}
