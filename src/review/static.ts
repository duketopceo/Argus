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
