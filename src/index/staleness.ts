import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { sha256, type RepoIndex } from './scan.js'

/**
 * Per-review staleness signal for `argus.index.json` — the Greptile-gap
 * answer to "the index is opt-in and goes stale silently". Rather than an
 * age heuristic, the check is exact: a changed file whose on-disk sha256
 * no longer matches its index entry's contentHash had provable drift
 * under review. Files absent from the index are `missing` (new files are
 * coverage, not staleness); unreadable files count as stale — the hash
 * can no longer be proven.
 */

export interface IndexStaleness {
  /** Index write time, echoed from the index for the warning line. */
  generatedAt: string
  /** Reviewed files present in the index (hash-checkable). */
  checked: number
  /** Of those, contentHash no longer matches the file on disk. */
  stale: number
  /** Reviewed files with no index entry at all. */
  missing: number
}

export async function indexStaleness(
  index: RepoIndex,
  /** Repo-relative paths under review (post-exclude). */
  files: string[],
  /** Checked-out tree the review ran against. */
  cwd: string,
): Promise<IndexStaleness> {
  const byPath = new Map(index.entries.map((e) => [e.path.replace(/^\.\//, ''), e]))
  let checked = 0
  let stale = 0
  let missing = 0
  // Sequential reads are fine — reviewed-file counts are in the hundreds
  // and each read is a single small file.
  for (const f of files) {
    const entry = byPath.get(f.replace(/^\.\//, ''))
    if (entry === undefined) {
      missing++
      continue
    }
    checked++
    try {
      const buf = await readFile(join(cwd, f))
      if (sha256(buf) !== entry.contentHash) stale++
    } catch {
      stale++
    }
  }
  return { generatedAt: index.generatedAt, checked, stale, missing }
}
