import type { LaneStatus } from '../report/manifest.js'
import { STATUS_GLYPH } from '../report/viewmodel.js'

/**
 * TTY-aware terminal styler (plan KTD5, DESIGN.md 7.7). No dependency: SGR
 * codes come from the ANSI-16 map that scripts/build-tokens.mjs writes to
 * assets/brand/ansi.json. That file is not shipped in the npm package, so
 * the codes are copied here and a unit test pins them to it.
 */

export type Role = 'ink' | 'ink-2' | 'ink-3' | 'accent' | 'passed' | 'failed' | 'caution'

export const ROLE_SGR: Record<Role, string> = {
  ink: '39',
  'ink-2': '39',
  'ink-3': '2',
  accent: '34',
  passed: '32',
  failed: '31',
  caution: '33',
}

export const STATUS_SGR: Record<LaneStatus, string> = {
  passed: '32',
  failed: '31',
  inconclusive: '33',
  blocked: '1',
  unavailable: '2',
  skipped: '2',
}

export interface ColorInputs {
  env: Record<string, string | undefined>
  isTTY: boolean
  noColorFlag?: boolean
}

/**
 * Precedence: `--no-color` and `NO_COLOR` beat `FORCE_COLOR`, which beats
 * TTY detection. GitHub Actions logs are not a TTY, so they get color only
 * through `FORCE_COLOR`. An empty `NO_COLOR` does not count (no-color.org),
 * and `FORCE_COLOR=0`/`false` forces nothing.
 */
export function colorEnabled({ env, isTTY, noColorFlag }: ColorInputs): boolean {
  if (noColorFlag === true) return false
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false
  const force = env.FORCE_COLOR
  if (force !== undefined && force !== '' && force !== '0' && force !== 'false') return true
  return isTTY
}

export interface Styler {
  readonly enabled: boolean
  role: (role: Role, text: string) => string
  status: (status: LaneStatus, text: string) => string
  /** The status glyph, colored by status. */
  glyph: (status: LaneStatus) => string
  bold: (text: string) => string
  dim: (text: string) => string
}

export function createStyler(enabled: boolean): Styler {
  // '39' is the terminal default: wrapping it would only add noise.
  const sgr = (code: string, text: string): string =>
    !enabled || code === '39' || text === '' ? text : `\x1b[${code}m${text}\x1b[0m`
  return {
    enabled,
    role: (role, text) => sgr(ROLE_SGR[role], text),
    status: (status, text) => sgr(STATUS_SGR[status], text),
    glyph: (status) => sgr(STATUS_SGR[status], STATUS_GLYPH[status]),
    bold: (text) => sgr('1', text),
    dim: (text) => sgr('2', text),
  }
}

/** The styler for anything that must stay plain (files, JSON, tests). */
export const PLAIN: Styler = createStyler(false)
