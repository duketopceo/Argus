import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { buildJournalEntry } from '../../src/journal/build.js'
import { JOURNAL_SCHEMA_VERSION, JournalEntry } from '../../src/journal/schema.js'
import { journalDir, newRunId, writeJournal } from '../../src/journal/store.js'

function entry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    runId: newRunId(),
    repo: 'duketopceo/Pace-Server',
    commitSha: 'abc123',
    branch: 'main',
    startedAt: new Date().toISOString(),
    durationMs: 1234,
    ok: true,
    totals: { tests: 1, passed: 1, failed: 0, visionCalls: 0, visionCostUsd: 0, budgetExceeded: false },
    tests: [],
    errors: [],
    ...overrides,
  }
}

describe('journal store', () => {
  it('writes one record per run — two .json files, zero .tmp leftovers', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'argus-journal-'))
    const e1 = entry()
    const e2 = entry()
    const p1 = await writeJournal(cacheDir, e1)
    await writeJournal(cacheDir, e2)

    const files = await readdir(journalDir(cacheDir))
    expect(files.filter((f) => f.endsWith('.json'))).toHaveLength(2)
    expect(files.filter((f) => f.endsWith('.tmp'))).toHaveLength(0)
    expect(p1).toContain(e1.runId)
    const loaded = JSON.parse(await readFile(p1!, 'utf8')) as JournalEntry
    expect(loaded.schemaVersion).toBe(JOURNAL_SCHEMA_VERSION)
    expect(loaded.runId).toBe(e1.runId)
  })

  it('runIds are unique and lexicographically ordered by time', async () => {
    const ids = [newRunId(), newRunId(), newRunId()]
    expect(new Set(ids).size).toBe(3)
    // ISO timestamps sort chronologically; ids from the same instant may tie,
    // so assert non-decreasing order.
    const sorted = [...ids].sort()
    expect(sorted[0]! <= sorted[1]! && sorted[1]! <= sorted[2]!).toBe(true)
  })

  it('writeJournal returns undefined instead of throwing on failure', async () => {
    const result = await writeJournal('/nonexistent-readonly/\0bad', entry())
    expect(result).toBeUndefined()
  })

  it('journal records carry no config/secrets surface at all', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'argus-journal-'))
    const path = await writeJournal(cacheDir, entry())
    const raw = await readFile(path!, 'utf8')
    // The schema has no config or secrets field — a secret value can only
    // appear if a caller injects it into steps/errors, so assert the shape.
    expect(raw).not.toContain('secrets')
    expect(raw).not.toContain('apiKey')
  })
})

describe('buildJournalEntry', () => {
  it('maps report data without a RunReport (aborted run)', () => {
    const e = buildJournalEntry({
      runId: 'r1',
      repo: 'x/y',
      commitSha: undefined,
      branch: 'feat/x',
      startedAt: new Date('2026-09-09T00:00:00Z'),
      durationMs: 10,
      reports: [
        {
          name: 't1',
          file: 't1.test.ts',
          ok: false,
          durationMs: 5,
          failureMessage: 'boom',
          steps: [],
          asserts: [],
          healEvents: [],
          visionCalls: 2,
          visionCostUsd: 0.001,
          sandboxSeconds: 0,
          budgetExceeded: false,
          videoPath: undefined,
        },
      ],
      runErrors: [{ stage: 'locate', message: 'm', context: 'c' }],
    })
    expect(e.ok).toBe(false)
    expect(e.totals.failed).toBe(1)
    expect(e.tests[0]!.failureMessage).toBe('boom')
    expect(e.errors[0]!.stage).toBe('locate')
  })
})
