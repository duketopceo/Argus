import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { JournalEntry } from './schema.js'

export function journalDir(cacheDir: string): string {
  return join(cacheDir, 'journal')
}

/**
 * Append one immutable run record. Atomic via tmp+rename (same pattern as
 * src/cache/store.ts). Never throws — journal write failure is itself an
 * evidence gap, not a reason to abort a run.
 */
export async function writeJournal(cacheDir: string, entry: JournalEntry): Promise<string> {
  const dir = journalDir(cacheDir)
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${entry.runId}.json`)
  const tmp = `${path}.tmp`
  await writeFile(tmp, `${JSON.stringify(entry, null, 2)}\n`, 'utf8')
  await rename(tmp, path)
  return path
}

/** runId: timestamp + short random suffix — sortable and collision-safe. */
export function newRunId(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const rand = Math.random().toString(36).slice(2, 8)
  return `${ts}-${rand}`
}
