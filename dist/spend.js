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
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync, } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { applyBudgetSetting, parseBudgetSetting, } from './config.js';
const MAX_BYTES = 4 * 1024 * 1024;
const KEEP_BYTES = 1024 * 1024;
export function spendJournalPath(dir) {
    return resolve(join(dir, 'spend.ndjson'));
}
/**
 * Journal directory: `ARGUS_SPEND_JOURNAL_DIR` (workflow author) wins over
 * the trusted `spendJournalDir` config key; the default is `<home>/.argus`.
 * Relative config paths resolve against `root` (the checkout cwd), not the
 * process cwd — config means "this repo's journal".
 */
export function resolveJournalDir(configDir, env, root) {
    const envDir = env.ARGUS_SPEND_JOURNAL_DIR?.trim();
    if (envDir !== undefined && envDir !== '')
        return resolve(envDir);
    if (configDir !== undefined)
        return resolve(root ?? '.', configDir);
    return join(homedir(), '.argus');
}
/**
 * `ARGUS_BUDGET_DAILY_USD`/`ARGUS_BUDGET_MONTHLY_USD` (the workflow-author
 * channel, same trust level as `ARGUS_BUDGET_USD`) override the trusted
 * config per period: a value sets it, `0` clears it, invalid warns and
 * keeps the configured value. Returns undefined when no cap survives.
 */
export function resolveBudgetCaps(configured, env, warn) {
    let daily = configured?.dailyUsd;
    let monthly = configured?.monthlyUsd;
    for (const [name, apply] of [
        ['ARGUS_BUDGET_DAILY_USD', (v) => (daily = v)],
        ['ARGUS_BUDGET_MONTHLY_USD', (v) => (monthly = v)],
    ]) {
        const setting = parseBudgetSetting(env[name]);
        if (setting.kind === 'invalid') {
            warn(`warning: ignoring invalid ${name}="${env[name] ?? ''}"`);
            continue;
        }
        const applied = applyBudgetSetting(setting);
        if (applied !== 'keep')
            apply(applied);
    }
    if (daily === undefined && monthly === undefined)
        return undefined;
    return { dailyUsd: daily, monthlyUsd: monthly, alertAtPct: configured?.alertAtPct ?? 80 };
}
/** Appends a run's spend; never throws. Bounded like live.ndjson. */
export function appendSpend(dir, record) {
    try {
        const path = spendJournalPath(dir);
        try {
            mkdirSync(dirname(path), { recursive: true });
        }
        catch { /* exists or unwritable — append decides */ }
        try {
            if (statSync(path).size > MAX_BYTES) {
                const text = readFileSync(path, 'utf8');
                const lines = text.split('\n');
                // The cap needs every current-month record: trim to the last
                // KEEP_BYTES, but never cut a line inside the current UTC month —
                // under-counting this month would silently raise the effective cap.
                const now = new Date();
                const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
                let firstCurrent = lines.length;
                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i];
                    if (line === undefined || line === '')
                        continue;
                    try {
                        const r = JSON.parse(line);
                        if (typeof r.ts === 'number' && r.ts >= monthStart) {
                            firstCurrent = i;
                            break;
                        }
                    }
                    catch { /* corrupt lines don't gate the trim */ }
                }
                const byteStart = Math.max(0, text.length - KEEP_BYTES);
                const nl = text.indexOf('\n', byteStart);
                const startLine = nl === -1 ? lines.length - 1 : text.slice(0, nl + 1).split('\n').length - 1;
                const keepFrom = Math.min(startLine, firstCurrent);
                const tmp = `${path}.${process.pid}.tmp`;
                writeFileSync(tmp, lines.slice(keepFrom).join('\n'));
                renameSync(tmp, path);
            }
        }
        catch { /* file doesn't exist yet */ }
        appendFileSync(path, JSON.stringify(record) + '\n');
    }
    catch { /* observability must not break runs */ }
}
/** Sums journal records inside the current UTC day and calendar month. */
export function periodSpend(dir, now = Date.now()) {
    const result = { dayUsd: 0, monthUsd: 0, corrupt: 0, readError: false };
    let text;
    try {
        if (!existsSync(spendJournalPath(dir)))
            return result;
        text = readFileSync(spendJournalPath(dir), 'utf8');
    }
    catch {
        result.readError = true;
        return result;
    }
    const d = new Date(now);
    const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    for (const line of text.split('\n')) {
        if (line === '')
            continue;
        try {
            const r = JSON.parse(line);
            if (typeof r.ts !== 'number' || typeof r.costUsd !== 'number' || r.costUsd < 0) {
                result.corrupt++;
                continue;
            }
            if (r.ts >= monthStart) {
                result.monthUsd += r.costUsd;
                if (r.ts >= dayStart)
                    result.dayUsd += r.costUsd;
            }
        }
        catch {
            result.corrupt++;
        }
    }
    return result;
}
const usd = (v) => `$${v.toFixed(4)}`;
/** Evaluates period caps against collected spend; pure, no I/O. */
export function evaluateCaps(caps, spend) {
    const alerts = [];
    let stop;
    for (const [label, cap, used] of [
        ['daily', caps.dailyUsd, spend.dayUsd],
        ['monthly', caps.monthlyUsd, spend.monthUsd],
    ]) {
        if (cap === undefined)
            continue;
        if (used >= cap) {
            stop = `org ${label} spend cap reached (${usd(used)} of ${usd(cap)})`;
            continue;
        }
        if (used >= (cap * caps.alertAtPct) / 100) {
            alerts.push(`org ${label} spend at ${usd(used)} of ${usd(cap)} cap (>=${caps.alertAtPct}%)`);
        }
    }
    return { stop, alerts };
}
