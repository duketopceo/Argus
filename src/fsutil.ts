import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Atomic JSON write via tmp+rename — the one place the pattern lives.
 * Callers: cache store, journal store, repo index.
 */
export async function writeAtomicJson(
  path: string,
  value: unknown,
  replacer?: (key: string, v: unknown) => unknown,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  await writeFile(tmp, `${JSON.stringify(value, replacer, 2)}\n`, 'utf8')
  await rename(tmp, path)
}
