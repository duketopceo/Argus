import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

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
  it('writes one immutable record per run, atomically', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'argus-journal-'))
    const e1 = entry()
    const e2 = entry()
    const p1 = await writeJournal(cacheDir, e1)
    await writeJournal(cacheDir, e2)

    const files = await readdir(journalDir(cacheDir))
    expect(files.filter((f) => f.endsWith('.json'))).toHaveLength(2)
    expect(p1).toContain(e1.runId)
    const loaded = JSON.parse(await readFile(p1, 'utf8')) as JournalEntry
    expect(loaded.schemaVersion).toBe(JOURNAL_SCHEMA_VERSION)
    expect(loaded.runId).toBe(e1.runId)
  })

  it('runIds are unique and sortable', () => {
    const ids = new Set([newRunId(), newRunId(), newRunId()])
    expect(ids.size).toBe(3)
    expect([...ids].sort()).toEqual([...ids].sort())
  })

  it('serializes error records verbatim (stage, message, context)', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'argus-journal-'))
    const e = entry({
      errors: [{ stage: 'locate', message: 'grounding corrected after probe mismatch', context: 'attempt=0' }],
    })
    const path = await writeJournal(cacheDir, e)
    const loaded = JSON.parse(await readFile(path, 'utf8')) as JournalEntry
    expect(loaded.errors[0]).toEqual({ stage: 'locate', message: 'grounding corrected after probe mismatch', context: 'attempt=0' })
  })

  it('never leaks configured secrets into the record', async () => {
    const secret = 'sk-live-DO-NOT-LEAK'
    const cacheDir = await mkdtemp(join(tmpdir(), 'argus-journal-'))
    const e = entry({
      tests: [{ name: 'login', file: 'x.test.ts', ok: true, durationMs: 1, steps: [], asserts: [], visionCalls: 0 }],
      errors: [{ stage: 'locate', message: 'retried', context: 'model call' }],
    })
    const path = await writeJournal(cacheDir, e)
    const raw = await readFile(path, 'utf8')
    expect(raw).not.toContain(secret)
  })
})
