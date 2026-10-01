import { describe, expect, it } from 'vitest'

import {
  renderComment,
  renderManifestComment,
  conclusionFromReport,
  SENTINEL,
} from '../../src/report/comment.js'
import { RunReport, TestReport } from '../../src/report/run.js'
import { fixtureManifest } from '../fixtures/manifest.js'

function stubReport(overrides: Partial<RunReport> = {}): RunReport {
  const tests: TestReport[] = [
    {
      name: 'landing',
      file: 'tests/landing.test.ts',
      ok: true,
      durationMs: 500,
      failureMessage: undefined,
      steps: [],
      asserts: [
        {
          question: 'hero visible',
          verdict: 'pass',
          reasoning: 'hero section is in view',
          cached: false,
        },
      ],
      healEvents: [{ instruction: 'the "Submit" button', model: 'qwen/qwen3.7-flash' }],
      visionCalls: 2,
      visionCostUsd: 0.002,
      sandboxSeconds: 2.0,
      budgetExceeded: false,
      calls: [
        { model: 'qwen/qwen3.7-flash', provider: 'stub', tokens: 10, costUsd: 0.001, kind: 'ground' },
        { model: 'qwen/qwen3.7-flash', provider: 'stub', tokens: 10, costUsd: 0.001, kind: 'assert' },
      ],
      videoPath: 'videos/landing.webm',
    },
    {
      name: 'login',
      file: 'tests/login.test.ts',
      ok: false,
      durationMs: 700,
      failureMessage: 'assert failed',
      steps: [],
      asserts: [
        {
          question: 'form visible',
          verdict: 'fail',
          reasoning: 'no form found on the page',
          cached: false,
        },
      ],
      healEvents: [],
      visionCalls: 1,
      visionCostUsd: 0.001,
      sandboxSeconds: 2.5,
      budgetExceeded: false,
      calls: [{ model: 'qwen/qwen3.7-flash', provider: 'stub', tokens: 10, costUsd: 0.001, kind: 'heal' }],
      videoPath: undefined,
    },
  ]
  return {
    tool: 'argus-reviewer',
    startedAt: '2026-09-08T00:00:00.000Z',
    durationMs: 1200,
    ok: true,
    totals: {
      tests: 2,
      passed: 2,
      failed: 0,
      visionCalls: 3,
      visionCostUsd: 0.003,
      sandboxSeconds: 4.5,
      budgetExceeded: false,
      callsByModel: { 'qwen/qwen3.7-flash': 3 },
      costByModel: { 'qwen/qwen3.7-flash': 0.003 },
    },
    tests,
    artifacts: { videos: ['videos/landing.webm'] },
    ...overrides,
  }
}

describe('renderComment', () => {
  it('renders the sentinel, status, verdicts, cost ledger, heals, assertions and evidence', () => {
    const body = renderComment(stubReport(), { runUrl: 'https://github.com/run/1' })

    expect(body).toContain(SENTINEL)
    expect(body).toContain('## argus-reviewer ✅ PASS')
    expect(body).toContain('### Tests')
    expect(body).toContain('| landing | ✅ pass | 2 | $0.002000 |  |')
    expect(body).toContain('| login | ❌ fail | 1 | $0.001000 | assert failed |')
    expect(body).toContain('### Cost ledger')
    expect(body).toContain('| Vision calls | 3 |')
    expect(body).toContain('| Per-call cost (avg) | $0.001000 |')
    expect(body).toContain('| Total vision spend | $0.003000 |')
    expect(body).toContain('### Heal events')
    expect(body).toContain('`the "Submit" button` healed with qwen/qwen3.7-flash')
    expect(body).toContain('### Assertions')
    expect(body).toContain('*hero visible*')
    expect(body).toContain('*form visible*')
    expect(body).toContain('### Evidence')
    expect(body).toContain('videos/landing.webm')
    expect(body).toContain('[workflow run / artifacts](https://github.com/run/1)')
  })

  it('contains the sentinel marker exactly once', () => {
    const body = renderComment(stubReport())
    expect(body.split(SENTINEL).length - 1).toBe(1)
  })

  it('renders a missing-key explanatory body', () => {
    const body = renderComment(undefined, { missingKey: true })

    expect(body).toContain(SENTINEL)
    expect(body).toContain('## argus-reviewer ⚪ skipped — no OpenRouter key')
    expect(body).toContain('OPENROUTER_API_KEY')
    expect(body).toContain('neutral')
  })

  it('omits the Exploratory section when the lane is disabled', () => {
    const body = renderComment(stubReport())
    expect(body).not.toContain('### Exploratory')
  })

  it('renders captures as observed findings, deduped across tests, verdict untouched', () => {
    const report = stubReport({
      explore: { enabled: true },
      ok: true,
    })
    const capture = {
      kind: 'console-error' as const,
      text: 'seeded console boom',
      count: 3,
    }
    // Same signature attached to both tests (shared browser session) —
    // counts merge in the rendered section.
    report.tests[0]!.captures = [capture]
    report.tests[1]!.captures = [
      capture,
      {
        kind: 'request-failed' as const,
        text: 'net::ERR_ABORTED',
        url: 'http://127.0.0.1:4000/api/missing',
        count: 1,
      },
    ]
    const body = renderComment(report)
    expect(body).toContain('### Exploratory')
    expect(body).toContain('🟡 observed · console error ×6: `seeded console boom`')
    expect(body).toContain(
      '🟡 observed · failed request: `net::ERR_ABORTED` — `http://127.0.0.1:4000/api/missing`',
    )
    expect(body).toContain('evidence only')
    // Non-blocking: the verdict line still reflects test results only.
    expect(body).toContain('## argus-reviewer ✅ PASS')
  })

  it('renders an explicit skip line when the lane could not observe', () => {
    const body = renderComment(
      stubReport({ explore: { enabled: true, skipped: 'no page loaded — nothing captured' } }),
    )
    expect(body).toContain('### Exploratory')
    expect(body).toContain('explore skipped — no page loaded — nothing captured')
  })

  it('reports a clean lane when enabled and nothing was captured', () => {
    const body = renderComment(stubReport({ explore: { enabled: true } }))
    expect(body).toContain('No page errors, console errors, or failed same-origin requests captured.')
  })

  it('renders the act-pass summary and merges its captures with test captures', () => {
    const body = renderComment(
      stubReport({
        explore: {
          enabled: true,
          steps: 7,
          visited: 2,
          stopReason: 'max-steps',
          visionCalls: 7,
          visionCostUsd: 0.0012,
          captures: [
            {
              kind: 'pageerror' as const,
              text: 'TypeError: boom',
              count: 1,
            },
          ],
        },
      }),
    )
    expect(body).toContain('### Exploratory')
    expect(body).toContain('explored **7** step(s) across **2** page(s)')
    expect(body).toContain('stopped: max-steps')
    expect(body).toContain('🟡 observed · page error: `TypeError: boom`')
  })

  it('renders a reachable-target skip line from the act pass', () => {
    const body = renderComment(
      stubReport({
        explore: { enabled: true, skipped: 'no reachable target — net::ERR_CONNECTION_REFUSED' },
      }),
    )
    expect(body).toContain('explore skipped — no reachable target')
  })
})

// U5/R15 — the verify-run sticky renders straight from the shared manifest
// view-model: all four lanes, statuses as text, costs, head binding.
describe('renderManifestComment', () => {
  it('renders every selected lane with status, calls, cost, and detail', () => {
    const body = renderManifestComment(fixtureManifest(), {
      runUrl: 'https://github.com/run/1',
    })

    expect(body).toContain(SENTINEL)
    expect(body).toContain('## argus-reviewer ❌ FAILED')
    expect(body).toContain('run-fixture-1')
    expect(body).toContain('8 provider call(s)')
    expect(body).toContain('$0.006200 spend')
    // All four lanes in canonical order.
    expect(body).toContain('| review | ✅ passed | 4 | $0.004200 | 2 findings (`deepseek/deepseek-v4.1-flash`) |')
    expect(body).toContain('| flow | ❌ failed | 3 | $0.001500 | landing.test.ts: assertion failed (`google/gemini-2.5-flash-lite`) |')
    expect(body).toContain('| app | ✅ passed | 1 | $0.000500 | expected state verified (`google/gemini-2.5-flash-lite`) |')
    expect(body).toContain('| a0 | 🟡 inconclusive | 0 | unmetered | delegation returned — self-reported |')
    // Head binding surfaces the match contract.
    expect(body).toContain('head `abc1234`')
    expect(body).toContain('match — checkout matches the intended PR head')
    // Cache economics and per-lane evidence paths ride along.
    expect(body).toContain('**Fingerprint cache:** 2 hit(s) · 1 miss(es) · 1 heal(s)')
    expect(body).toContain('- review: `reports/code-review.json`')
    expect(body).toContain('- a0: `reports/a0-lane.json`')
    expect(body).toContain('[workflow run / artifacts](https://github.com/run/1)')
  })

  it('renders unselected lanes as explicitly skipped rows', () => {
    const manifest = fixtureManifest()
    manifest.lanes.app.selected = false
    manifest.lanes.app.status = 'skipped'
    const body = renderManifestComment(manifest)
    expect(body).toContain('| app | ⚪ skipped | 0 | — | not selected |')
    // and after the selected rows — lane order is canonical regardless.
    const reviewIdx = body.indexOf('| review |')
    const appIdx = body.indexOf('| app |')
    expect(appIdx).toBeGreaterThan(reviewIdx)
  })

  it('masks secret-shaped tokens in lane detail before they reach a PR', () => {
    const manifest = fixtureManifest()
    manifest.lanes.flow.reason = 'auth failed: sk-or-v1-abcdef12345'
    const body = renderManifestComment(manifest)
    expect(body).not.toContain('sk-or-v1-abcdef12345')
  })
})

describe('conclusionFromReport', () => {
  it('maps pass, fail and missing-key to the correct check-run conclusion', () => {
    expect(conclusionFromReport(stubReport())).toBe('success')
    expect(conclusionFromReport({ ...stubReport(), ok: false })).toBe('failure')
    expect(conclusionFromReport(undefined, true)).toBe('neutral')
  })
})
