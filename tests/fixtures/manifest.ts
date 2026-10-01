import type { LaneId, LaneManifest, RunManifest } from '../../src/report/manifest.js'
import { emptyLane, MANIFEST_SCHEMA_VERSION } from '../../src/report/manifest.js'

/**
 * Shared manifest fixture — the parity contract tests render the same
 * 4-lane manifest through the comment renderer, the view-model, and the
 * action's sticky-comment block, then assert they agree (AE-C).
 */

export function fixtureLane(
  lane: LaneId,
  overrides: Partial<LaneManifest> = {},
): LaneManifest {
  const base = emptyLane(lane, false)
  return { ...base, ...overrides }
}

export function fixtureManifest(overrides: Partial<RunManifest> = {}): RunManifest {
  const lanes: Record<LaneId, LaneManifest> = {
    review: fixtureLane('review', {
      selected: true,
      status: 'passed',
      startedAt: '2026-09-30T20:00:00.000Z',
      finishedAt: '2026-09-30T20:00:30.000Z',
      reportPath: 'reports/code-review.json',
      model: 'deepseek/deepseek-v4.1-flash',
      summary: '2 findings',
      usage: {
        provider: 'openrouter',
        model: 'deepseek/deepseek-v4.1-flash',
        calls: 4,
        tokens: 4000,
        costUsd: 0.0042,
        metered: true,
      },
      budget: {
        limitUsd: 1,
        spentUsd: 0.0042,
        exceeded: false,
        maxDurationMs: undefined,
        elapsedMs: 30_000,
        maxTasks: undefined,
        tasks: 0,
      },
      headBinding: {
        intendedSha: 'abc1234deadbeef',
        checkoutSha: 'abc1234deadbeef',
        status: 'match',
        source: 'github',
        detail: 'checkout matches the intended PR head',
      },
    }),
    flow: fixtureLane('flow', {
      selected: true,
      status: 'failed',
      startedAt: '2026-09-30T20:00:30.000Z',
      finishedAt: '2026-09-30T20:01:00.000Z',
      reportPath: 'reports/run.json',
      model: 'google/gemini-2.5-flash-lite',
      summary: 'flow failed',
      reason: 'landing.test.ts: assertion failed',
      usage: {
        provider: 'openrouter',
        model: 'google/gemini-2.5-flash-lite',
        calls: 3,
        tokens: 3000,
        costUsd: 0.0015,
        metered: true,
      },
      budget: {
        limitUsd: 2,
        spentUsd: 0.0015,
        exceeded: false,
        maxDurationMs: undefined,
        elapsedMs: 30_000,
        maxTasks: undefined,
        tasks: 0,
      },
      cache: {
        hits: 2,
        misses: 1,
        heals: 1,
        staleEntries: 0,
        assertionHits: 1,
        assertionMisses: 0,
      },
    }),
    app: fixtureLane('app', {
      selected: true,
      status: 'passed',
      startedAt: '2026-09-30T20:01:00.000Z',
      finishedAt: '2026-09-30T20:01:20.000Z',
      reportPath: 'reports/app-lane.json',
      model: 'google/gemini-2.5-flash-lite',
      summary: 'expected state verified',
      usage: {
        provider: 'openrouter',
        model: 'google/gemini-2.5-flash-lite',
        calls: 1,
        tokens: 1000,
        costUsd: 0.0005,
        metered: true,
      },
      budget: {
        limitUsd: 1,
        spentUsd: 0.0005,
        exceeded: false,
        maxDurationMs: 120_000,
        elapsedMs: 20_000,
        maxTasks: undefined,
        tasks: 0,
      },
    }),
    a0: fixtureLane('a0', {
      selected: true,
      status: 'inconclusive',
      startedAt: '2026-09-30T20:01:20.000Z',
      finishedAt: '2026-09-30T20:02:00.000Z',
      reportPath: 'reports/a0-lane.json',
      summary: 'delegation returned — self-reported',
      usage: {
        provider: 'a0',
        model: undefined,
        calls: 0,
        tokens: 0,
        costUsd: 0,
        metered: false,
      },
      budget: {
        limitUsd: undefined,
        spentUsd: 0,
        exceeded: false,
        maxDurationMs: 600_000,
        elapsedMs: 40_000,
        maxTasks: 1,
        tasks: 1,
      },
    }),
  }
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    runId: 'run-fixture-1',
    startedAt: '2026-09-30T20:00:00.000Z',
    finishedAt: '2026-09-30T20:02:00.000Z',
    identity: {
      repo: 'owner/repo',
      pr: '42',
      intendedHeadSha: 'abc1234deadbeef',
      checkoutSha: 'abc1234deadbeef',
      baseSha: 'base00',
      runNonce: undefined,
    },
    lanes,
    aggregate: {
      status: 'failed',
      ok: false,
      costUsd: 0.0062,
      calls: 8,
      tokens: 8000,
    },
    ...overrides,
  }
}
