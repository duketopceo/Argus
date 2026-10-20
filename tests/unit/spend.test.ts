import { mkdtemp, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../../src/config.js'
import {
  appendSpend,
  evaluateCaps,
  periodSpend,
  resolveBudgetCaps,
  resolveJournalDir,
  spendJournalPath,
} from '../../src/spend.js'
import { ScriptedClient, reply, runReview } from './review-pipeline.helpers.js'

const day = 24 * 60 * 60 * 1000

describe('spend journal', () => {
  it('reports zeroed periods for a missing journal without an error', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'argus-spend-'))
    const spend = periodSpend(dir)
    expect(spend).toEqual({ dayUsd: 0, monthUsd: 0, corrupt: 0, readError: false })
  })

  it('round-trips records and sums the current UTC day and month', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'argus-spend-'))
    const now = Date.now()
    appendSpend(dir, { ts: now, costUsd: 0.4, source: 'code-review' })
    appendSpend(dir, { ts: now, costUsd: 0.25, source: 'run' })
    const spend = periodSpend(dir, now)
    expect(spend.dayUsd).toBeCloseTo(0.65)
    expect(spend.monthUsd).toBeCloseTo(0.65)
    expect(spend.corrupt).toBe(0)
  })

  it('excludes records older than the calendar month', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'argus-spend-'))
    const now = Date.now()
    appendSpend(dir, { ts: now - 45 * day, costUsd: 9.99 })
    appendSpend(dir, { ts: now, costUsd: 0.1 })
    const spend = periodSpend(dir, now)
    expect(spend.dayUsd).toBeCloseTo(0.1)
    expect(spend.monthUsd).toBeCloseTo(0.1)
  })

  it('excludes a same-month record from before today', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'argus-spend-'))
    const d = new Date()
    const yesterday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - 1, 12)
    if (d.getUTCDate() === 1) return // before today is a different month; covered above
    appendSpend(dir, { ts: yesterday, costUsd: 0.5 })
    appendSpend(dir, { ts: Date.now(), costUsd: 0.1 })
    const spend = periodSpend(dir)
    expect(spend.dayUsd).toBeCloseTo(0.1)
    expect(spend.monthUsd).toBeCloseTo(0.6)
  })

  it('counts corrupt and malformed lines instead of throwing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'argus-spend-'))
    await writeFile(
      spendJournalPath(dir),
      'not json\n{"ts":1}\n' + JSON.stringify({ ts: Date.now(), costUsd: 0.3 }) + '\n',
    )
    const spend = periodSpend(dir)
    expect(spend.dayUsd).toBeCloseTo(0.3)
    expect(spend.corrupt).toBe(2)
    expect(spend.readError).toBe(false)
  })
})

describe('resolveJournalDir', () => {
  it('prefers the env dir, then config, then the home default', () => {
    expect(resolveJournalDir('/cfg', { ARGUS_SPEND_JOURNAL_DIR: ' /env ' })).toBe('/env')
    expect(resolveJournalDir('/cfg', {})).toBe('/cfg')
    expect(resolveJournalDir(undefined, {})).toBe(join(homedir(), '.argus'))
  })
})

describe('resolveBudgetCaps', () => {
  const caps = { dailyUsd: 5, monthlyUsd: 50, alertAtPct: 80 }
  it('keeps configured caps when env is unset', () => {
    expect(resolveBudgetCaps(caps, {}, () => {})).toEqual(caps)
  })
  it('lets env set a cap on an unconfigured period', () => {
    expect(resolveBudgetCaps(undefined, { ARGUS_BUDGET_DAILY_USD: '3' }, () => {})?.dailyUsd).toBe(3)
  })
  it('lets env clear a configured cap with 0', () => {
    const resolved = resolveBudgetCaps(caps, { ARGUS_BUDGET_DAILY_USD: '0', ARGUS_BUDGET_MONTHLY_USD: '0' }, () => {})
    expect(resolved).toBeUndefined()
  })
  it('warns and keeps the configured cap on invalid env', () => {
    const warnings: string[] = []
    const resolved = resolveBudgetCaps(caps, { ARGUS_BUDGET_DAILY_USD: 'bogus' }, (l) => warnings.push(l))
    expect(resolved?.dailyUsd).toBe(5)
    expect(warnings[0]).toContain('ARGUS_BUDGET_DAILY_USD')
  })
})

describe('evaluateCaps', () => {
  const spend = (dayUsd: number, monthUsd: number) => ({ dayUsd, monthUsd, corrupt: 0, readError: false })
  it('stops when a capped period is exhausted', () => {
    const v = evaluateCaps({ dailyUsd: 1, monthlyUsd: 10, alertAtPct: 80 }, spend(1.2, 1.2))
    expect(v.stop).toContain('daily')
    expect(v.stop).toContain('$1.2000')
  })
  it('alerts at the threshold share without stopping', () => {
    const v = evaluateCaps({ dailyUsd: 1, monthlyUsd: undefined, alertAtPct: 80 }, spend(0.85, 0.85))
    expect(v.stop).toBeUndefined()
    expect(v.alerts).toHaveLength(1)
    expect(v.alerts[0]).toContain('daily')
  })
  it('stays quiet below the threshold and ignores uncapped periods', () => {
    const v = evaluateCaps({ dailyUsd: undefined, monthlyUsd: 100, alertAtPct: 80 }, spend(5, 5))
    expect(v.stop).toBeUndefined()
    expect(v.alerts).toHaveLength(0)
  })
})

describe('resolveConfig budgetCaps', () => {
  it('keeps well-formed caps and defaults the alert percentage', () => {
    const c = resolveConfig({ budgetCaps: { dailyUsd: 2, monthlyUsd: 20, alertAtPct: 50 } })
    expect(c.budgetCaps).toEqual({ dailyUsd: 2, monthlyUsd: 20, alertAtPct: 50 })
    const d = resolveConfig({ budgetCaps: { dailyUsd: 2, monthlyUsd: undefined, alertAtPct: 0 } })
    expect(d.budgetCaps?.alertAtPct).toBe(80)
  })
  it('degrades non-positive or mis-typed caps to unset', () => {
    expect(resolveConfig({ budgetCaps: { dailyUsd: 0, monthlyUsd: -3, alertAtPct: 80 } }).budgetCaps).toBeUndefined()
    expect(resolveConfig({ budgetCaps: 'bogus' as never }).budgetCaps).toBeUndefined()
  })
  it('degrades a mis-typed journal dir to unset', () => {
    expect(resolveConfig({ spendJournalDir: 42 as never }).spendJournalDir).toBeUndefined()
    expect(resolveConfig({ spendJournalDir: '/x' }).spendJournalDir).toBe('/x')
  })
})

describe('code-review org caps', () => {
  it('skips before any model call when the daily cap is already spent', async () => {
    const journalDir = await mkdtemp(join(tmpdir(), 'argus-spend-'))
    appendSpend(journalDir, { ts: Date.now(), costUsd: 1 })
    const client = new ScriptedClient([reply([])])
    const result = await runReview({
      head: { 'src/a.ts': 'a\n' },
      client,
      config: { spendJournalDir: journalDir, budgetCaps: { dailyUsd: 0.5 } },
    })
    expect(result.code).toBe(0)
    expect(result.report.skipped).toBe(true)
    expect(result.report.summary).toContain('daily')
    expect(client.prompts).toHaveLength(0)
  })

  it('honors the env journal dir and env cap on an unconfigured run', async () => {
    const journalDir = await mkdtemp(join(tmpdir(), 'argus-spend-'))
    appendSpend(journalDir, { ts: Date.now(), costUsd: 1 })
    const client = new ScriptedClient([reply([])])
    const result = await runReview({
      head: { 'src/a.ts': 'a\n' },
      client,
      env: { ARGUS_SPEND_JOURNAL_DIR: journalDir, ARGUS_BUDGET_DAILY_USD: '0.5' },
    })
    expect(result.report.skipped).toBe(true)
    expect(client.prompts).toHaveLength(0)
  })

  it('warns when a capped period nears its cap but still reviews', async () => {
    const journalDir = await mkdtemp(join(tmpdir(), 'argus-spend-'))
    appendSpend(journalDir, { ts: Date.now(), costUsd: 0.045 })
    const client = new ScriptedClient([reply([])])
    const result = await runReview({
      head: { 'src/a.ts': 'a\n' },
      client,
      config: { spendJournalDir: journalDir, budgetCaps: { dailyUsd: 0.05 } },
    })
    expect(result.report.skipped).not.toBe(true)
    expect(result.err.some((l) => l.includes('org daily spend'))).toBe(true)
    expect(client.prompts.length).toBeGreaterThan(0)
  })

  it('appends the completed review spend to the shared journal', async () => {
    const journalDir = await mkdtemp(join(tmpdir(), 'argus-spend-'))
    const client = new ScriptedClient([reply([])])
    const result = await runReview({
      head: { 'src/a.ts': 'a\n' },
      client,
      config: { spendJournalDir: journalDir },
    })
    expect(result.code).toBe(0)
    expect(existsSync(spendJournalPath(journalDir))).toBe(true)
    const record = JSON.parse(readFileSync(spendJournalPath(journalDir), 'utf8').trim())
    expect(record.source).toBe('code-review')
    expect(record.costUsd).toBeGreaterThan(0)
    const spend = periodSpend(journalDir)
    expect(spend.dayUsd).toBeCloseTo(record.costUsd)
  })
})
