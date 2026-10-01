import { LANE_IDS, LANE_STATUSES, } from './manifest.js';
/**
 * Manifest → view model. One contract for the three evidence surfaces —
 * sticky PR comment, TUI, and Electron dashboard — so lane names, status
 * labels, model/cost fields, and head identity agree by construction, not
 * by convention (R15, AE-C).
 *
 * Everything here is a pure function over an already-parsed RunManifest:
 * no fs, no fetch — the collector owns reading, this owns shaping.
 */
/** One display label per status — surfaces may color it, never rename it. */
export const LANE_STATUS_LABEL = {
    passed: 'passed',
    failed: 'failed',
    skipped: 'skipped',
    blocked: 'blocked',
    unavailable: 'unavailable',
    inconclusive: 'inconclusive',
};
/** One glyph per status — terminal/comment-safe, color-independent. */
export const LANE_STATUS_ICON = {
    passed: '✓',
    failed: '✗',
    skipped: '—',
    blocked: '⛔',
    unavailable: '⚠',
    inconclusive: '~',
};
/** Comment-flavored emoji per status — same ordering contract as the glyph. */
export const LANE_STATUS_EMOJI = {
    passed: '✅',
    failed: '❌',
    skipped: '⚪',
    blocked: '⛔',
    unavailable: '⚠️',
    inconclusive: '🟡',
};
function laneDurationMs(lane) {
    if (lane.startedAt === undefined || lane.finishedAt === undefined)
        return undefined;
    const ms = Date.parse(lane.finishedAt) - Date.parse(lane.startedAt);
    return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
}
export function laneView(lane) {
    return {
        lane: lane.lane,
        selected: lane.selected,
        status: lane.status,
        statusLabel: LANE_STATUS_LABEL[lane.status],
        statusIcon: LANE_STATUS_ICON[lane.status],
        summary: lane.summary,
        reason: lane.reason,
        reportPath: lane.reportPath,
        model: lane.model ?? lane.usage?.model,
        usage: lane.usage,
        budget: lane.budget,
        cache: lane.cache,
        headBinding: lane.headBinding,
        startedAt: lane.startedAt,
        finishedAt: lane.finishedAt,
        durationMs: laneDurationMs(lane),
    };
}
export function manifestToRunView(manifest) {
    const lanes = LANE_IDS.map((id) => laneView(manifest.lanes[id]));
    return {
        runId: manifest.runId,
        schemaVersion: manifest.schemaVersion,
        startedAt: manifest.startedAt,
        finishedAt: manifest.finishedAt,
        status: manifest.aggregate.status,
        statusLabel: LANE_STATUS_LABEL[manifest.aggregate.status],
        statusIcon: LANE_STATUS_ICON[manifest.aggregate.status],
        ok: manifest.aggregate.ok,
        costUsd: manifest.aggregate.costUsd,
        calls: manifest.aggregate.calls,
        tokens: manifest.aggregate.tokens,
        repo: manifest.identity.repo,
        pr: manifest.identity.pr,
        intendedHeadSha: manifest.identity.intendedHeadSha,
        checkoutSha: manifest.identity.checkoutSha,
        headBinding: manifest.lanes.review.headBinding,
        lanes,
        selectedLanes: lanes.filter((lane) => lane.selected),
    };
}
/** Structural validation — a manifest the view-model can trust enough to render. */
export function isRunManifest(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return false;
    const m = value;
    if (m.schemaVersion !== 1)
        return false;
    if (typeof m.runId !== 'string' || typeof m.startedAt !== 'string')
        return false;
    if (m.identity === undefined ||
        typeof m.identity !== 'object' ||
        m.identity === null ||
        Array.isArray(m.identity)) {
        return false;
    }
    for (const v of [
        m.identity.repo,
        m.identity.pr,
        m.identity.intendedHeadSha,
        m.identity.checkoutSha,
        m.identity.baseSha,
        m.identity.runNonce,
    ]) {
        if (v !== undefined && typeof v !== 'string')
            return false;
    }
    const aggregate = m.aggregate;
    if (aggregate === undefined || aggregate === null || typeof aggregate !== 'object') {
        return false;
    }
    // aggregate.status feeds LANE_STATUS_LABEL lookups and ok the verdict —
    // a type-confused aggregate must degrade to last-valid, not reach a
    // renderer that throws mid-post.
    if (typeof aggregate.status !== 'string')
        return false;
    if (!LANE_STATUSES.includes(aggregate.status))
        return false;
    if (typeof aggregate.ok !== 'boolean')
        return false;
    for (const n of [aggregate.calls, aggregate.tokens, aggregate.costUsd]) {
        if (typeof n !== 'number' || !Number.isFinite(n))
            return false;
    }
    if (m.lanes === undefined || m.lanes === null || typeof m.lanes !== 'object')
        return false;
    for (const id of LANE_IDS) {
        const lane = m.lanes[id];
        if (lane === undefined || lane === null || typeof lane !== 'object')
            return false;
        if (lane.lane !== id || typeof lane.status !== 'string')
            return false;
        if (!LANE_STATUSES.includes(lane.status))
            return false;
        if (typeof lane.selected !== 'boolean')
            return false;
        // usage/budget are dereferenced by laneView — a guard that certifies a
        // shape it doesn't check is a lying guard. `typeof null === 'object'`,
        // so a null here must be rejected before the field reads, not crash
        // inside the guard.
        if (lane.usage === null || lane.usage === undefined || typeof lane.usage !== 'object') {
            return false;
        }
        for (const n of [lane.usage.calls, lane.usage.tokens, lane.usage.costUsd]) {
            if (typeof n !== 'number' || !Number.isFinite(n))
                return false;
        }
        if (lane.budget === null || lane.budget === undefined || typeof lane.budget !== 'object') {
            return false;
        }
    }
    return true;
}
/**
 * Evidence strings pass through a secret-shaped-token mask before render —
 * a lane summary that captured a credential must not re-emit it onto a PR
 * comment or dashboard (R16's sanitized-evidence surface).
 */
const SECRET_PATTERNS = [
    /sk-or-[A-Za-z0-9_-]{4,}/g,
    /sk-[A-Za-z0-9_-]{8,}/g,
    /gh[pousr]_[A-Za-z0-9_]{8,}/g,
    /github_pat_[A-Za-z0-9_]{8,}/g,
    /xox[baprs]-[A-Za-z0-9-]{8,}/g,
    /AKIA[A-Z0-9]{16}/g,
    /npm_[A-Za-z0-9]{8,}/g,
    /Bearer\s+[A-Za-z0-9._~+/=-]{10,}/gi,
    /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,
    /:\/\/[^/\s:@]{1,64}:[^/\s:@]{6,}@/g,
];
export function maskSecrets(s) {
    let out = s;
    for (const re of SECRET_PATTERNS)
        out = out.replace(re, '•••');
    return out;
}
export function formatUsd(n) {
    return `$${(n ?? 0).toFixed(6)}`;
}
export function formatDuration(ms) {
    if (ms === undefined || !Number.isFinite(ms))
        return '—';
    if (ms < 1000)
        return `${Math.round(ms)}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
}
export function shortSha(sha) {
    return sha === undefined || sha === '' ? undefined : sha.slice(0, 7);
}
