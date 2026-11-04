import { readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultExec } from '../detect.js';
import { writeAtomicJson } from '../fsutil.js';
export const LANE_IDS = ['review', 'flow', 'app', 'a0'];
export const LANE_STATUSES = [
    'passed',
    'failed',
    'skipped',
    'blocked',
    'unavailable',
    'inconclusive',
];
export const MANIFEST_SCHEMA_VERSION = 1;
/** Read the checked-out commit without making git identity a hard dependency. */
export async function readCheckoutSha(cwd, exec = defaultExec) {
    // `safe.directory=*` is scoped to this one invocation — git's `-c` does not
    // persist. CI containers commonly run the job as a uid that does not own the
    // checkout (`--user 1000:1000` against a runner-owned workdir), and git then
    // refuses every command with "detected dubious ownership" and a 128 exit,
    // which surfaced as an inconclusive head binding on every PR. `rev-parse` runs
    // no hooks, so trusting the tree for this read is not the attack
    // safe.directory guards against. Passing it through `-c` also survives an
    // unset HOME, where the global config that holds checkout's safe.directory
    // entry is unreadable.
    const result = await exec('git', ['-c', 'safe.directory=*', '-C', cwd, 'rev-parse', 'HEAD'], 10_000);
    if (result.code !== 0) {
        // A bare `undefined` cannot be told apart from "git is missing" versus "git
        // refused", and that ambiguity is exactly what made this undiagnosable from
        // a CI log. Surface what git actually said.
        console.error(`readCheckoutSha: git rev-parse HEAD failed in ${cwd} (exit ${result.code}): ` +
            `${result.stderr.trim().slice(0, 300) || '<no stderr>'}`);
        return undefined;
    }
    const sha = result.stdout.trim();
    if (sha === '') {
        console.error(`readCheckoutSha: git rev-parse HEAD returned no output in ${cwd} (exit 0)`);
        return undefined;
    }
    return sha;
}
/** Classify the relationship between API/fixture head identity and the checkout. */
export function classifyHeadBinding(intendedSha, checkoutSha, source) {
    if (source === 'fixture') {
        return {
            intendedSha,
            checkoutSha,
            status: 'not_applicable',
            source,
            detail: 'fixture diff is bound to its local fixture head',
        };
    }
    if (source === 'local') {
        return {
            intendedSha,
            checkoutSha,
            status: 'not_applicable',
            source,
            detail: 'local diff is bound to the working tree, not a pushed head',
        };
    }
    if (intendedSha === undefined || intendedSha === '') {
        return {
            intendedSha,
            checkoutSha,
            status: 'unknown',
            source,
            detail: 'PR head identity was unavailable',
        };
    }
    if (checkoutSha === undefined || checkoutSha === '') {
        return {
            intendedSha,
            checkoutSha,
            status: 'unknown',
            source,
            detail: 'checkout identity was unavailable',
        };
    }
    if (intendedSha === checkoutSha) {
        return {
            intendedSha,
            checkoutSha,
            status: 'match',
            source,
            detail: 'checkout matches the intended PR head',
        };
    }
    return {
        intendedSha,
        checkoutSha,
        status: 'mismatch',
        source,
        detail: `checkout ${checkoutSha} does not match intended PR head ${intendedSha}`,
    };
}
/** True when runtime evidence is bound to the intended head (or a fixture). */
export function isHeadBindingConclusive(binding) {
    return binding?.status === 'match' || binding?.status === 'not_applicable';
}
export function emptyUsage(provider = 'unknown') {
    return {
        provider,
        model: undefined,
        calls: 0,
        tokens: 0,
        costUsd: 0,
        metered: provider !== 'a0',
    };
}
function emptyBudget() {
    return {
        limitUsd: undefined,
        spentUsd: 0,
        exceeded: false,
        maxDurationMs: undefined,
        elapsedMs: 0,
        maxTasks: undefined,
        tasks: 0,
    };
}
export function emptyLane(lane, selected) {
    return {
        lane,
        selected,
        status: selected ? 'blocked' : 'skipped',
        startedAt: undefined,
        finishedAt: undefined,
        reportPath: undefined,
        model: undefined,
        summary: undefined,
        reason: undefined,
        usage: emptyUsage(),
        budget: emptyBudget(),
        headBinding: undefined,
        cache: undefined,
    };
}
export function aggregateLanes(lanes) {
    const selected = LANE_IDS.map((lane) => lanes[lane]).filter((lane) => lane.selected);
    const hasFailure = selected.some((lane) => ['failed', 'blocked'].includes(lane.status));
    const hasInconclusive = selected.some((lane) => lane.status === 'inconclusive');
    const hasUnavailable = selected.some((lane) => lane.status === 'unavailable');
    const status = hasFailure
        ? 'failed'
        : hasInconclusive || hasUnavailable
            ? 'inconclusive'
            : selected.length === 0 || selected.every((lane) => lane.status === 'skipped')
                ? 'skipped'
                : selected.every((lane) => lane.status === 'passed' || lane.status === 'skipped')
                    ? 'passed'
                    : 'inconclusive';
    return {
        status,
        ok: status === 'passed',
        costUsd: selected.reduce((sum, lane) => sum + lane.usage.costUsd, 0),
        calls: selected.reduce((sum, lane) => sum + lane.usage.calls, 0),
        tokens: selected.reduce((sum, lane) => sum + lane.usage.tokens, 0),
    };
}
export function addProviderUsage(usage, calls) {
    if (calls === undefined || calls.length === 0)
        return usage;
    const costUsd = calls.reduce((sum, call) => sum + call.costUsd, 0);
    const tokens = calls.reduce((sum, call) => sum + call.tokens, 0);
    const model = calls.at(-1)?.model;
    return {
        provider: 'openrouter',
        model: usage.model ?? model,
        calls: usage.calls + calls.length,
        tokens: usage.tokens + tokens,
        costUsd: usage.costUsd + costUsd,
        metered: true,
    };
}
/** Run manifests are archived under `<reportDir>/manifests/<runId>.json`. */
const MANIFEST_HISTORY_DIR = 'manifests';
/**
 * Archive a completed verify manifest into local history and prune to the
 * retention bound — the dashboard/TUI run list reads this directory.
 * runIds are timestamp-prefixed, so name sort is chronological; pruning
 * drops the oldest names beyond `keep`. `keep <= 0` writes nothing and
 * clears nothing existing (retention governs new archives, not deletes).
 */
export async function archiveManifest(reportDir, manifest, keep) {
    if (keep <= 0)
        return;
    const dir = join(reportDir, MANIFEST_HISTORY_DIR);
    // runId becomes a filename — never trust it as a path component.
    const safeName = manifest.runId.replace(/[^\w.-]/g, '-');
    await writeAtomicJson(join(dir, `${safeName}.json`), manifest);
    let names;
    try {
        names = (await readdir(dir)).filter((n) => n.endsWith('.json')).sort();
    }
    catch {
        return;
    }
    const excess = names.length - keep;
    for (const name of names.slice(0, Math.max(0, excess))) {
        try {
            await unlink(join(dir, name));
        }
        catch {
            // already gone — pruning is best-effort
        }
    }
}
