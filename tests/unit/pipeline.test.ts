import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { main } from '../../src/cli.js'
import {
  addA0Task,
  addProviderCalls,
  budgetCanSpend,
  createBudget,
} from '../../src/pipeline/budget.js'
import {
  defaultLaneSelection,
  selectedLanes,
  selectionFromFlags,
} from '../../src/pipeline/contracts.js'
import { runVerify } from '../../src/pipeline/verify.js'
import type { CallCost } from '../../src/vision/cost.js'

function call(costUsd: number, model = 'test/model'): CallCost {
  return { provider: 'stub', model, tokens: 10, costUsd, kind: 'code' }
}

describe('lane selection', () => {
  it('defaults to review only and preserves explicit deep-lane choices', () => {
    expect(defaultLaneSelection()).toEqual({ review: true, flow: false, app: false, a0: false })
    expect(selectedLanes(selectionFromFlags({ review: false, flow: true, a0: true }))).toEqual([
      'flow',
      'a0',
    ])
  })
})

describe('lane budgets', () => {
  it('tracks provider spend and stops at the configured cap', () => {
    let budget = createBudget('review', { limitUsd: 0.002 })
    budget = addProviderCalls(budget, [call(0.001), call(0.001)])
    expect(budget.spentUsd).toBeCloseTo(0.002)
    expect(budget.exceeded).toBe(false)
    expect(budgetCanSpend(budget, 0.001)).toBe(false)
    budget = addProviderCalls(budget, [call(0.001)])
    expect(budget.exceeded).toBe(true)
  })

  it('does not trip the cap when float error puts spend exactly on the limit', () => {
    // 0.1 + 0.2 is 0.30000000000000004 in IEEE-754, so a bare `sum > limit`
    // marks a lane exceeded while it is exactly at — not over — its cap.
    let budget = createBudget('review', { limitUsd: 0.3 })
    budget = addProviderCalls(budget, [call(0.1), call(0.2)])
    expect(budget.exceeded).toBe(false)
    expect(budgetCanSpend(budget, 0)).toBe(true)

    // Genuinely over the cap must still stop.
    budget = addProviderCalls(budget, [call(0.0001)])
    expect(budget.exceeded).toBe(true)
    expect(budgetCanSpend(budget, 0)).toBe(false)
  })

  it('tracks A0 task and wall-clock boundaries without inventing USD', () => {
    let budget = createBudget('a0', { maxTasks: 1, maxDurationMs: 100 })
    budget = addA0Task(budget, 50, false)
    expect(budget.tasks).toBe(1)
    expect(budget.exceeded).toBe(false)
    budget = addA0Task(budget, 60, false)
    expect(budget.exceeded).toBe(true)
    expect(budget.spentUsd).toBe(0)
  })
})

describe('runVerify', () => {
  it('aggregates review and flow reports into one manifest', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'argus-verify-'))
    const reportDir = join(cwd, 'reports')
    await mkdir(reportDir, { recursive: true })
    await writeFile(
      join(reportDir, 'code-review.json'),
      JSON.stringify({
        ok: true,
        model: 'test/model',
        summary: 'review passed',
        calls: [call(0.002)],
        headBinding: {
          intendedSha: 'abc',
          checkoutSha: 'abc',
          status: 'match',
          source: 'github',
          detail: 'match',
        },
      }),
    )
    await writeFile(
      join(reportDir, 'run.json'),
      JSON.stringify({
        ok: true,
        totals: { visionCalls: 0, visionCostUsd: 0 },
        tests: [],
      }),
    )
    const result = await runVerify({
      cwd,
      runId: 'run-1',
      reportDir,
      identity: {
        repo: 'o/r',
        pr: '1',
        intendedHeadSha: 'abc',
        checkoutSha: 'abc',
        baseSha: 'def',
      },
      selection: { review: true, flow: true, app: false, a0: false },
      flowUrl: 'http://localhost:3000',
      runners: {
        review: async () => 0,
        flow: async () => 0,
      },
      budgets: { review: { limitUsd: 0.01 } },
    })
    expect(result.exitCode).toBe(0)
    expect(result.manifest.aggregate).toMatchObject({ status: 'passed', ok: true, costUsd: 0.002 })
    expect(result.manifest.lanes.review.status).toBe('passed')
    expect(result.manifest.lanes.flow.status).toBe('passed')
    expect(result.manifest.lanes.app.status).toBe('skipped')
    expect(result.manifest.lanes.review.reportPath).toBe('reports/code-review.json')
  })

  it('marks an unavailable deep lane and a missing flow target without spending', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'argus-verify-'))
    const reportDir = join(cwd, 'reports')
    await mkdir(reportDir, { recursive: true })
    const result = await runVerify({
      cwd,
      runId: 'run-2',
      reportDir,
      identity: {
        repo: undefined,
        pr: undefined,
        intendedHeadSha: undefined,
        checkoutSha: undefined,
        baseSha: undefined,
      },
      selection: { review: false, flow: true, app: true, a0: false },
      runners: { review: async () => 0, flow: async () => 0 },
    })
    expect(result.exitCode).toBe(1)
    expect(result.manifest.lanes.flow.status).toBe('blocked')
    expect(result.manifest.lanes.app.status).toBe('unavailable')
    expect(result.manifest.aggregate.status).toBe('failed')
  })

  it('fails when the selected review lane produces no report', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'argus-verify-'))
    const reportDir = join(cwd, 'reports')
    await mkdir(reportDir, { recursive: true })
    const result = await runVerify({
      cwd,
      runId: 'run-missing-review',
      reportDir,
      identity: {
        repo: 'o/r',
        pr: '1',
        intendedHeadSha: 'head',
        checkoutSha: 'head',
        baseSha: 'def',
      },
      selection: { review: true, flow: false, app: false, a0: false },
      runners: { review: async () => 0 },
    })
    expect(result.exitCode).toBe(1)
    expect(result.manifest.lanes.review.status).toBe('failed')
  })

  it.each(['mismatch', 'unknown'] as const)(
    'marks a %s head binding as inconclusive rather than a clean pass',
    async (bindingStatus) => {
      const cwd = await mkdtemp(join(tmpdir(), 'argus-verify-'))
      const reportDir = join(cwd, 'reports')
      await mkdir(reportDir, { recursive: true })
      await writeFile(
        join(reportDir, 'code-review.json'),
        JSON.stringify({
          ok: true,
          summary: 'Head binding inconclusive',
          model: 'test/model',
          calls: [],
          headBinding: {
            intendedSha: 'head',
            checkoutSha: 'merge',
            status: bindingStatus,
            source: 'github',
            detail: 'mismatch',
          },
        }),
      )
      const result = await runVerify({
        cwd,
        runId: 'run-3',
        reportDir,
        identity: {
          repo: 'o/r',
          pr: '1',
          intendedHeadSha: 'head',
          checkoutSha: 'merge',
          baseSha: 'def',
        },
        selection: { review: true, flow: false, app: false, a0: false },
        runners: { review: async () => 0 },
      })
      expect(result.exitCode).toBe(1)
      expect(result.manifest.lanes.review.status).toBe('inconclusive')
      expect(result.manifest.aggregate.status).toBe('inconclusive')
    },
  )

  it('exposes verify as the default review-first CLI surface', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'argus-verify-cli-'))
    const reportDir = join(cwd, 'reports')
    await writeFile(
      join(cwd, 'argus-reviewer.config.json'),
      JSON.stringify({
        decisionModel: '',
        reportDir,
        codeReviewBudgetUsd: 1,
        budgetUsd: 2,
      }),
    )
    const code = await main(['verify', '--report-dir', reportDir], {
      cwd,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        ARGUS_BUDGET_USD: '0.003',
      },
      out: () => undefined,
      err: () => undefined,
    })
    expect(code).toBe(1)
    const manifest = JSON.parse(await readFile(join(reportDir, 'run-manifest.json'), 'utf8')) as {
      aggregate: { status: string }
      lanes: {
        review: { selected: boolean; status: string; budget: { limitUsd?: number } }
        flow: { selected: boolean; budget: { limitUsd?: number } }
      }
    }
    expect(manifest.aggregate.status).toBe('skipped')
    expect(manifest.lanes.review).toMatchObject({ selected: true, status: 'skipped' })
    expect(manifest.lanes.review.budget.limitUsd).toBe(0.003)
    expect(manifest.lanes.flow.selected).toBe(false)
  })
})
