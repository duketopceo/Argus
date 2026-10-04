import type { ExecFn } from '../detect.js'

/**
 * Static (non-model) review lane. Off by default so existing behavior is
 * byte-identical unless a caller explicitly opts in. Every probe failure
 * degrades to a reason string — discovery never throws to the caller.
 */

export interface StaticLaneConfig {
  enabled: boolean
  /** Path or name of the `ocr` binary. */
  bin: string
  timeoutMs: number
  model?: string
}

export const DEFAULTS: StaticLaneConfig = {
  enabled: false,
  bin: 'ocr',
  timeoutMs: 180_000,
}

export function resolveStaticLaneConfig(raw: Partial<StaticLaneConfig> = {}): StaticLaneConfig {
  if (raw.timeoutMs !== undefined && raw.timeoutMs < 0) {
    throw new Error(`staticLane.timeoutMs must be >= 0, got ${raw.timeoutMs}`)
  }
  return { ...DEFAULTS, ...raw }
}

export interface OcrDiscovery {
  found: boolean
  /** '' when found; otherwise 'not-installed' or 'crashed'. */
  reason: string
  version?: string
}

const DISCOVERY_TIMEOUT_MS = 10_000

export async function discoverOcr(bin: string, exec: ExecFn): Promise<OcrDiscovery> {
  let r
  try {
    r = await exec(bin, ['--version'], DISCOVERY_TIMEOUT_MS)
  } catch {
    // A throwing exec is still just "not usable" — degrade, never propagate.
    return { found: false, reason: 'crashed' }
  }
  if (r.code === 0) return { found: true, reason: '', version: r.stdout.trim() }
  // 127 is the shell's "command not found": the binary is simply absent, which
  // is a normal un-provisioned environment rather than an error.
  if (r.code === 127) return { found: false, reason: 'not-installed' }
  return { found: false, reason: 'crashed' }
}