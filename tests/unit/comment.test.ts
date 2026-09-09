import { describe, expect, it } from 'vitest'

import { renderComment, conclusionFromReport, SENTINEL } from '../../src/report/comment.js'
import { RunReport, TestReport } from '../../src/report/run.js'

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
      videoPath: undefined,
    },
  ]
  return {
    tool: 'vision-e2e',
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
    expect(body).toContain('## vision-e2e ✅ PASS')
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
    expect(body).toContain('## vision-e2e ⚪ skipped — no OpenRouter key')
    expect(body).toContain('OPENROUTER_API_KEY')
    expect(body).toContain('neutral')
  })
})

describe('conclusionFromReport', () => {
  it('maps pass, fail and missing-key to the correct check-run conclusion', () => {
    expect(conclusionFromReport(stubReport())).toBe('success')
    expect(conclusionFromReport({ ...stubReport(), ok: false })).toBe('failure')
    expect(conclusionFromReport(undefined, true)).toBe('neutral')
  })
})
