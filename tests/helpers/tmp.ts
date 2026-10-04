import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach } from 'vitest'

/**
 * Create temp dirs that are removed after each test. Prefer this over bare
 * `mkdtemp(join(tmpdir(), ...))` in new tests. (The global setup also sweeps
 * the whole per-run TMPDIR, so this is about not accumulating within a run.)
 */
export function useTmpDir(prefix: string): () => Promise<string> {
  const made: string[] = []
  afterEach(async () => {
    await Promise.all(made.splice(0).map((d) => rm(d, { recursive: true, force: true })))
  })
  return async () => {
    const dir = await mkdtemp(join(tmpdir(), `${prefix}-`))
    made.push(dir)
    return dir
  }
}
