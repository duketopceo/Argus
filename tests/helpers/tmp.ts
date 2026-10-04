import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { onTestFinished } from 'vitest'

/**
 * Create temp dirs that are removed after the test that created them.
 * Prefer this over bare `mkdtemp(join(tmpdir(), ...))` in new tests. (The
 * global setup also sweeps the whole per-run TMPDIR, so this is about not
 * accumulating within a run.) Cleanup binds via onTestFinished to the test
 * that made each dir, so a shared factory is safe under concurrent tests.
 */
export function useTmpDir(prefix: string): () => Promise<string> {
  return async () => {
    const dir = await mkdtemp(join(tmpdir(), `${prefix}-`))
    onTestFinished(() => rm(dir, { recursive: true, force: true }))
    return dir
  }
}
