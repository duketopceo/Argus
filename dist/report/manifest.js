import { defaultExec } from '../detect.js';
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
    const result = await exec('git', ['-C', cwd, 'rev-parse', 'HEAD'], 10_000);
    if (result.code !== 0)
        return undefined;
    const sha = result.stdout.trim();
    return sha === '' ? undefined : sha;
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
export function emptyBudget() {
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
