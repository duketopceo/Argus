import { join } from 'node:path'
import { liveLog } from './live.js'

const DEBUG = process.env.ARGUS_DEBUG === '1' || process.env.ARGUS_DEBUG === 'true'

// debug() has no config access — it defaults to the conventional cache dir,
// and callers that resolve a config set the real live dir once it's known
// (otherwise debug lines and stage lines would split across two dirs).
const DEFAULT_LIVE_DIR = join(process.cwd(), '.argus-reviewer-cache')
let liveDir = DEFAULT_LIVE_DIR

export function setLiveDir(dir: string | undefined): void {
  liveDir = dir ?? DEFAULT_LIVE_DIR
}

function toMsg(arg: unknown): string {
  if (typeof arg === 'string') return arg
  try {
    const s = JSON.stringify(arg)
    return s === undefined ? String(arg) : s // JSON.stringify(undefined) -> undefined
  } catch {
    return String(arg) // BigInt, cyclic refs — never throw from a debug call
  }
}

export function debug(kind: string, ...args: unknown[]): void {
  if (!DEBUG) return // keep debug() free of fs work on the hot path
  for (const arg of args) {
    liveLog(liveDir, kind, 'debug', toMsg(arg))
    const prefix = `[argus-reviewer:${kind}]`
    if (typeof arg === 'string') {
      console.error(`${prefix} ${arg}`)
    } else {
      console.error(prefix, arg)
    }
  }
}
