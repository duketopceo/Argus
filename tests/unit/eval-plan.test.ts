import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  DEFAULT_EVAL_MODELS,
  confirmKey,
  evalPlan,
  formatEvalPlan,
} from '../../scripts/eval-plan.mjs'

let dir = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'argus-eval-plan-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function seedSuite(cases: number): Promise<void> {
  await mkdir(join(dir, 'evals/suite'), { recursive: true })
  for (let i = 0; i < cases; i++) {
    await writeFile(join(dir, `evals/suite/c${i}.test.ts`), `test('case ${i}', async (td) => {})\n`)
  }
}

async function seedResult(name: string, results: unknown[]): Promise<void> {
  await mkdir(join(dir, 'evals/results'), { recursive: true })
  await writeFile(
    join(dir, 'evals/results', name),
    JSON.stringify({ generatedAt: name.replace('.json', ''), results }),
  )
}

const withKey = { env: { OPENROUTER_API_KEY: 'sk-test' } }

describe('evalPlan', () => {
  it('reports models, case count, cap and an estimate from the newest results', async () => {
    await seedSuite(3)
    await seedResult('2026-01-01.json', [
      { model: DEFAULT_EVAL_MODELS[0], cold: { visionCostUsd: 9 }, warm: { visionCostUsd: 0 } },
    ])
    await seedResult('2026-02-01.json', [
      { model: DEFAULT_EVAL_MODELS[0], cold: { visionCostUsd: 0.002 }, warm: { visionCostUsd: 0 } },
      {
        model: DEFAULT_EVAL_MODELS[1],
        cold: { visionCostUsd: 0.1 },
        warm: { visionCostUsd: 0.05 },
      },
    ])
    const plan = evalPlan(dir, withKey)
    expect(plan.cases).toBe(3)
    expect(plan.models.map((m) => m.model)).toEqual(DEFAULT_EVAL_MODELS)
    expect(plan.estimateUsd).toBeCloseTo(0.152)
    expect(plan.estimatePartial).toBe(false)
    expect(plan.capUsd).toBe(plan.budgetUsd * 2 * DEFAULT_EVAL_MODELS.length)
    expect(plan.keyPresent).toBe(true)
    expect(plan.error).toBeUndefined()
  })

  it('marks the estimate partial when a model has no past cost', async () => {
    await seedSuite(1)
    await seedResult('2026-02-01.json', [
      { model: DEFAULT_EVAL_MODELS[0], cold: { visionCostUsd: 0.01 }, warm: { visionCostUsd: 0 } },
    ])
    const plan = evalPlan(dir, withKey)
    expect(plan.estimatePartial).toBe(true)
    expect(formatEvalPlan(plan).join('\n')).toContain('no past cost on record')
  })

  it('never throws: a missing suite and corrupt results still yield a cancellable plan', async () => {
    await mkdir(join(dir, 'evals/results'), { recursive: true })
    await writeFile(join(dir, 'evals/results/bad.json'), '{not json')
    const plan = evalPlan(dir, { env: {} })
    expect(plan.cases).toBeNull()
    expect(plan.estimateUsd).toBeNull()
    expect(plan.error).toContain('could not read the eval suite')
    const text = formatEvalPlan(plan).join('\n')
    expect(text).toContain('Estimated cost: unknown')
    expect(text).toContain('OPENROUTER_API_KEY is not set')
    // Readable sentences, not raw error codes.
    expect(text).not.toMatch(/ENOENT/)
  })

  it('states the budget cap and that it spends real credit', async () => {
    await seedSuite(2)
    const text = formatEvalPlan(evalPlan(dir, withKey)).join('\n')
    expect(text).toContain('Budget cap: $1.00 per run, at most $4.00 in total')
    expect(text).toContain('spends real OpenRouter credit')
    expect(text).toContain('2 test case(s) x 2 model(s)')
  })
})

describe('confirmKey', () => {
  it('only an explicit y confirms', () => {
    expect(confirmKey('y')).toBe('confirm')
    expect(confirmKey('Y')).toBe('confirm')
  })

  it('Esc, n and Enter cancel — Enter never defaults to spending', () => {
    for (const k of ['n', 'N', '\x1b', '\r', '\n']) expect(confirmKey(k)).toBe('cancel')
  })

  it('other keys (including e pressed again) are ignored', () => {
    for (const k of ['e', 'r', ' ', 'yes']) expect(confirmKey(k)).toBe('ignore')
  })
})
