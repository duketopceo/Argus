/**
 * Journal schema — one append-only record per run. Evidence store, not logs:
 * every error and non-fatal recovery is a structured entry so failure modes
 * can be analyzed across runs.
 */
export const JOURNAL_SCHEMA_VERSION = 1

export interface ErrorRecord {
  /** Pipeline stage: boot | target | locate | assert | heal | report | index */
  stage: string
  message: string
  /** Minimal context: step instruction, model, page URL — never secrets. */
  context?: string
}

export interface JournalStep {
  instruction: string
  action: string
  ok: boolean
  reason?: string
  healed?: boolean
  model?: string
}

export interface JournalAssert {
  question: string
  verdict: 'pass' | 'fail'
  reasoning: string
  cached?: boolean
}

export interface JournalTest {
  name: string
  file: string
  ok: boolean
  durationMs: number
  failureMessage?: string
  steps: JournalStep[]
  asserts: JournalAssert[]
  visionCalls: number
}

export interface JournalEntry {
  schemaVersion: typeof JOURNAL_SCHEMA_VERSION
  runId: string
  /** Repo identifier: `owner/name` from git remote, else directory basename. */
  repo: string
  commitSha: string | undefined
  branch: string | undefined
  startedAt: string
  durationMs: number
  ok: boolean
  totals: {
    tests: number
    passed: number
    failed: number
    visionCalls: number
    visionCostUsd: number
    budgetExceeded: boolean
  }
  tests: JournalTest[]
  /** Non-fatal recoveries + fatal errors — the failure-mode dataset. */
  errors: ErrorRecord[]
}
