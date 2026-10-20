/**
 * Host-shared spend journal (issue #22): one NDJSON record per completed
 * paid run, appended to `<dir>/spend.ndjson` where <dir> defaults to
 * `<home>/.argus`. The run cache is per-repo, so the journal lives outside
 * it — aggregation covers the repos that share the file (a self-hosted
 * runner fleet on one host, or a developer machine). On ephemeral CI
 * runners each job sees only its own records; nothing is invented.
 *
 * Best-effort like liveLog: an unreadable or unwritable journal never
 * breaks a run. Cap checks then warn and continue — a corrupt local file
 * must not silently disable reporting, and must not block all reviews.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import {
  applyBudgetSetting,
  type BudgetCaps,
  parseBudgetSetting,
} from './config.js'

const MAX_BYTES = 4 * 1024 * 1024
const KEEP_BYTES = 1024 * 1024

/** One completed run's metered spend. `source` names the lane (`code-review`, `run`). */
export interface SpendRecord {
  ts: number
  costUsd: number
  repo?: string
  source?: string
  runNonce?: string
}

export function spendJournalPath(dir: string): string {
  return resolve(join(dir, 'spend.ndjson'))
}

/**
 * Journal directory: `ARGUS_SPEND_JOURNAL_DIR` (workflow author) wins over
 * the trusted `spendJournalDir` config key; the default is `<home>/.argus`.
 */
export function resolveJournalDir(
  configDir: string | undefined,
  env: Record<string, string | undefined>,
): string {
  const envDir = env.ARGUS_SPEND_JOURNAL_DIR?.trim()
  if (envDir !== undefined && envDir !== '') return resolve(envDir)
  if (configDir !== undefined) return resolve(configDir)
  return join(homedir(), '.argus')
}

/**
 * `ARGUS_BUDGET_DAILY_USD`/`ARGUS_BUDGET_MONTHLY_USD` (the workflow-author
 * channel, same trust level as `ARGUS_BUDGET_USD`) override the trusted
 * config per period: a value sets it, `0` clears it, invalid warns and
 * keeps the configured value. Returns undefined when no cap survives.
 */
export function resolveBudgetCaps(
  configured: BudgetCaps | undefined,
  env: Record<string, string | undefined>,
  warn: (line: string) => void,
): BudgetCaps | undefined {
  let daily = configured?.dailyUsd
  let monthly = configured?.monthlyUsd
  for (const [name, apply] of [
    ['ARGUS_BUDGET_DAILY_USD', (v: number | undefined) => (daily = v)],
    ['ARGUS_BUDGET_MONTHLY_USD', (v: number | undefined) => (monthly = v)],
  ] as const) {
    const setting = parseBudgetSetting(env[name])
    if (setting.kind === 'invalid') {
      warn(`warning: ignoring invalid ${name}="${env[name] ?? ''}"`)
      continue
    }
    const applied = applyBudgetSetting(setting)
    if (applied !== 'keep') apply(applied)
  }
  if (daily === undefined && monthly === undefined) return undefined
  return { dailyUsd: daily, monthlyUsd: monthly, alertAtPct: configured?.alertAtPct ?? 80 }
}

/** Appends a run's spend; never throws. Bounded like live.ndjson. */
export function appendSpend(dir: string, record: SpendRecord): void {
  try {
    const path = spendJournalPath(dir)
    try {
      mkdirSync(dirname(path), { recursive: true })
    } catch { /* exists or unwritable — append decides */ }
    try {
      if (statSync(path).size > MAX_BYTES) {
        const buf = readFileSync(path)
        const start = Math.max(0, buf.length - KEEP_BYTES)
        const nl = buf.indexOf(0x0a, start)
        const tmp = `${path}.${process.pid}.tmp`
        writeFileSync(tmp, nl === -1 ? buf.subarray(start) : buf.subarray(nl + 1))
        renameSync(tmp, path)
      }
    } catch { /* file doesn't exist yet */ }
    appendFileSync(path, JSON.stringify(record) + '\n')
  } catch { /* observability must not break runs */ }
}

export interface PeriodSpend {
  /** Spend since 00:00 UTC today. */
  dayUsd: number
  /** Spend since the 1st of this month, 00:00 UTC. */
  monthUsd: number
  /** Journal lines that did not parse — counted, never hidden. */
  corrupt: number
  /** The journal could not be read at all (not 'missing'). */
  readError: boolean
}

/** Sums journal records inside the current UTC day and calendar month. */
export function periodSpend(dir: string, now = Date.now()): PeriodSpend {
  const result: PeriodSpend = { dayUsd: 0, monthUsd: 0, corrupt: 0, readError: false }
  let text: string
  try {
    if (!existsSync(spendJournalPath(dir))) return result
    text = readFileSync(spendJournalPath(dir), 'utf8')
  } catch {
    result.readError = true
    return result
  }
  const d = new Date(now)
  const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
  for (const line of text.split('\n')) {
    if (line === '') continue
    try {
      const r = JSON.parse(line) as SpendRecord
      if (typeof r.ts !== 'number' || typeof r.costUsd !== 'number' || r.costUsd < 0) {
        result.corrupt++
        continue
      }
      if (r.ts >= monthStart) {
        result.monthUsd += r.costUsd
        if (r.ts >= dayStart) result.dayUsd += r.costUsd
      }
    } catch {
      result.corrupt++
    }
  }
  return result
}

export interface CapsVerdict {
  /** Set when a cap forbids further spend; carries the human reason. */
  stop: string | undefined
  /** Alert lines for capped periods at/past `alertAtPct`. */
  alerts: string[]
}

const usd = (v: number) => `$${v.toFixed(4)}`

/** Evaluates period caps against collected spend; pure, no I/O. */
export function evaluateCaps(caps: BudgetCaps, spend: PeriodSpend): CapsVerdict {
  const alerts: string[] = []
  let stop: string | undefined
  for (const [label, cap, used] of [
    ['daily', caps.dailyUsd, spend.dayUsd],
    ['monthly', caps.monthlyUsd, spend.monthUsd],
  ] as const) {
    if (cap === undefined) continue
    if (used >= cap) {
      stop = `org ${label} spend cap reached (${usd(used)} of ${usd(cap)})`
      continue
    }
    if (used >= (cap * caps.alertAtPct) / 100) {
      alerts.push(`org ${label} spend at ${usd(used)} of ${usd(cap)} cap (>=${caps.alertAtPct}%)`)
    }
  }
  return { stop, alerts }
}
