import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { writeAtomicJson } from '../fsutil.js'

import { FingerprintRecord } from './fingerprint.js'

export const FLOW_CACHE_SCHEMA_VERSION = 1 as const

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
  schemaVersion?: typeof FLOW_CACHE_SCHEMA_VERSION
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
    const { schemaVersion, steps, asserts } = parsed as {
      schemaVersion?: unknown
      steps?: unknown
      asserts?: unknown
    }
    if (!Array.isArray(steps)) {
      return undefined
    }
    if (schemaVersion !== undefined && schemaVersion !== FLOW_CACHE_SCHEMA_VERSION) {
      return undefined
    }
    const out: FlowCache = {
      ...(schemaVersion === FLOW_CACHE_SCHEMA_VERSION ? { schemaVersion } : {}),
      steps: steps as FingerprintRecord[],
    }
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
  await writeAtomicJson(
    flowPath(cacheDir, flowName),
    { schemaVersion: FLOW_CACHE_SCHEMA_VERSION, steps, asserts: asserts ?? [] },
    sortKeys,
  )
}
