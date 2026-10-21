import { type BudgetCaps } from './config.js';
/** One completed run's metered spend. `source` names the lane (`code-review`, `run`). */
export interface SpendRecord {
    ts: number;
    costUsd: number;
    repo?: string;
    source?: string;
    runNonce?: string;
}
export declare function spendJournalPath(dir: string): string;
/**
 * Journal directory: `ARGUS_SPEND_JOURNAL_DIR` (workflow author) wins over
 * the trusted `spendJournalDir` config key; the default is `<home>/.argus`.
 * Relative config paths resolve against `root` (the checkout cwd), not the
 * process cwd — config means "this repo's journal".
 */
export declare function resolveJournalDir(configDir: string | undefined, env: Record<string, string | undefined>, root?: string): string;
/**
 * `ARGUS_BUDGET_DAILY_USD`/`ARGUS_BUDGET_MONTHLY_USD` (the workflow-author
 * channel, same trust level as `ARGUS_BUDGET_USD`) override the trusted
 * config per period: a value sets it, `0` clears it, invalid warns and
 * keeps the configured value. Returns undefined when no cap survives.
 */
export declare function resolveBudgetCaps(configured: BudgetCaps | undefined, env: Record<string, string | undefined>, warn: (line: string) => void): BudgetCaps | undefined;
/** Appends a run's spend; never throws. Bounded like live.ndjson. */
export declare function appendSpend(dir: string, record: SpendRecord): void;
export interface PeriodSpend {
    /** Spend since 00:00 UTC today. */
    dayUsd: number;
    /** Spend since the 1st of this month, 00:00 UTC. */
    monthUsd: number;
    /** Journal lines that did not parse — counted, never hidden. */
    corrupt: number;
    /** The journal could not be read at all (not 'missing'). */
    readError: boolean;
}
/** Sums journal records inside the current UTC day and calendar month. */
export declare function periodSpend(dir: string, now?: number): PeriodSpend;
export interface CapsVerdict {
    /** Set when a cap forbids further spend; carries the human reason. */
    stop: string | undefined;
    /** Alert lines for capped periods at/past `alertAtPct`. */
    alerts: string[];
}
/** Evaluates period caps against collected spend; pure, no I/O. */
export declare function evaluateCaps(caps: BudgetCaps, spend: PeriodSpend): CapsVerdict;
