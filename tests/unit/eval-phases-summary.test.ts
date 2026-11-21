import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// evals/summarize-phases.mjs folds raw run-phases rows into the numbers the eval doc quotes.
let dir = ''
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'argus-phases-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const row = (o: Record<string, unknown>) => ({
  model: 'm/a',
  rep: 1,
  task: 't1',
  ok: true,
  failureMessage: null,
  visionCalls: 0,
  costUsd: 0,
  durationMs: 100,
  healEvents: 0,
  cache: { hits: 1, misses: 0, heals: 0 },
  ...o,
})

async function summarize(runs: unknown[], extra: string[] = []) {
  const file = join(dir, 'raw.json')
  await writeFile(file, JSON.stringify({ spentUsd: 0.5, runs }))
  const r = spawnSync('node', ['evals/summarize-phases.mjs', file, ...extra], { encoding: 'utf8' })
  expect(r.status).toBe(0)
  return JSON.parse(r.stdout)
}

describe('summarize-phases', () => {
  it('counts every row, classifies failures and scores heals against cold passes', async () => {
    const out = await summarize([
      row({ phase: 'cold', visionCalls: 2, costUsd: 0.01 }),
      row({ phase: 'warm' }),
      row({
        phase: 'drift',
        visionCalls: 1,
        costUsd: 0.004,
        healEvents: 1,
        steps: [{ healed: true, ok: true }],
        cache: { hits: 0, misses: 1, heals: 1 },
      }),
      row({ phase: 'warm-heal' }),
      row({
        task: 't2',
        phase: 'cold',
        ok: false,
        failureMessage:
          'td.find("x") failed: model grounded to "y", which does not match the instruction',
      }),
      row({
        task: 't2',
        phase: 'warm',
        ok: false,
        failureMessage:
          'OpenRouter completion failed for all candidate models: OpenRouter request failed: 400 ',
      }),
    ])
    const m = out.models['m/a']
    expect(m.phases.cold).toMatchObject({ k: 1, n: 2, failureKinds: { 'wrong-element': 1 } })
    expect(m.phases.warm).toMatchObject({ k: 1, n: 2, failureKinds: { 'api-error': 1 } })
    expect(m.phases.cold.costPerSuiteRun).toBeCloseTo(0.01)
    expect(m.heal).toMatchObject({
      eligible: 1,
      attempted: 1,
      succeeded: 1,
      taskRunsWithHeal: 1,
      taskRunsWithHealPassed: 1,
      healSteps: 1,
      healStepsAccepted: 1,
    })
    expect(m.warmGivenColdPass).toBe('1/1')
  })

  it('--exclude drops a task from the headline only', async () => {
    const out = await summarize(
      [
        row({ phase: 'cold' }),
        row({ task: 'bad', phase: 'cold', ok: false, failureMessage: 'assert("q") failed: no' }),
      ],
      ['--exclude', 'bad'],
    )
    expect(out.models['m/a'].phases.cold).toMatchObject({ k: 1, n: 1 })
    expect(out.excluded).toEqual(['bad'])
  })
})
