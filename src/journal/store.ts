import { join } from 'node:path'

import { writeAtomicJson } from '../fsutil.js'

import { JournalEntry } from './schema.js'

export function journalDir(cacheDir: string): string {
  return join(cacheDir, 'journal')
}

/**
 * Append one immutable run record. Atomic via tmp+rename (src/fsutil.ts).
 * Returns the written path, or undefined on failure — a journal write must
 * never abort a run.
 */
export async function writeJournal(
  cacheDir: string,
  entry: JournalEntry,
): Promise<string | undefined> {
  const path = join(journalDir(cacheDir), `${entry.runId}.json`)
  try {
    await writeAtomicJson(path, entry)
    return path
  } catch {
    return undefined
  }
}

/** runId: timestamp + short random suffix — sortable and collision-safe. */
export function newRunId(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const rand = Math.random().toString(36).slice(2, 8)
  return `${ts}-${rand}`
}
