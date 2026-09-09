import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { FingerprintRecord } from './fingerprint.js'

/** A cached assertion verdict, keyed on (question, page-state hash). */
export interface CachedAssert {
  question: string
  /** FNV-1a hash of the a11y snapshot at assert time — stable across pixel noise. */
  a11yHash: string
  verdict: 'pass' | 'fail'
  reasoning: string
  model: string | undefined
}

export interface FlowCache {
  steps: FingerprintRecord[]
  asserts?: CachedAssert[]
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
    const { steps, asserts } = parsed as { steps?: unknown; asserts?: unknown }
    if (!Array.isArray(steps)) {
      return undefined
    }
    const out: FlowCache = { steps: steps as FingerprintRecord[] }
    if (Array.isArray(asserts)) out.asserts = asserts as CachedAssert[]
    return out
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
  asserts?: CachedAssert[],
): Promise<void> {
  await mkdir(cacheDir, { recursive: true })
  const path = flowPath(cacheDir, flowName)
  const tmp = `${path}.tmp`
  const json = `${JSON.stringify({ steps, asserts: asserts ?? [] }, sortKeys, 2)}\n`
  await writeFile(tmp, json, 'utf8')
  await rename(tmp, path)
}
