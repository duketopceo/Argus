import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { FingerprintRecord } from './fingerprint.js'

export interface FlowCache {
  steps: FingerprintRecord[]
}

function sortKeys(_: string, value: unknown): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    )
    return Object.fromEntries(entries)
  }
  return value
}

export function flowPath(cacheDir: string, flowName: string): string {
  return join(cacheDir, `${flowName}.json`)
}

export async function loadFlow(cacheDir: string, flowName: string): Promise<FlowCache | undefined> {
  const path = flowPath(cacheDir, flowName)
  try {
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined
    }
    const { steps } = parsed as { steps?: unknown }
    if (!Array.isArray(steps)) {
      return undefined
    }
    return { steps: steps as FingerprintRecord[] }
  } catch (e) {
    const code = (e as { code?: string }).code
    if (code === 'ENOENT') {
      return undefined
    }
    throw e
  }
}

export async function saveFlow(
  cacheDir: string,
  flowName: string,
  steps: FingerprintRecord[],
): Promise<void> {
  await mkdir(cacheDir, { recursive: true })
  const path = flowPath(cacheDir, flowName)
  const tmp = `${path}.tmp`
  const json = `${JSON.stringify({ steps }, sortKeys, 2)}\n`
  await writeFile(tmp, json, 'utf8')
  await rename(tmp, path)
}
