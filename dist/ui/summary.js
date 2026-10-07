import { LANE_IDS } from '../report/manifest.js';
import { formatDuration, formatUsd, LANE_STATUS_LABEL, maskSecrets, shortSha } from '../report/viewmodel.js';
/** The config key that raises each lane's dollar cap (ARGUS_BUDGET_USD overrides all). */
const BUDGET_KEY = {
    review: 'codeReviewBudgetUsd',
    flow: 'budgetUsd',
    app: 'app.budgetUsd',
};
const LANE_COL = 7;
const COST_COL = 9;
/**
 * A lane row is 2 indent + glyph + space + lane + 2, the detail, then 2 +
 * cost: 24 columns plus the detail. Six more columns of slack keep it clear
 * of the right edge.
 */
const FIXED_COLS = 2 + 1 + 1 + LANE_COL + 2 + 2 + COST_COL + 6;
const DETAIL_MAX = 50;
const DETAIL_MIN = 16;
function fit(text, width) {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length <= width ? flat.padEnd(width) : `${flat.slice(0, width - 1)}…`;
}
const dollars = (n) => `$${n.toFixed(2)}`;
export function renderSummary(input, style, width = 80) {
    const head = [
        `${style.glyph(input.status)} ${style.bold(LANE_STATUS_LABEL[input.status])}`,
        ...(input.headSha !== undefined ? [`head ${input.headSha}`] : []),
        ...(input.durationMs !== undefined ? [formatDuration(input.durationMs)] : []),
    ].join('   ');
    const lines = [head];
    const detailWidth = Math.max(DETAIL_MIN, Math.min(DETAIL_MAX, width - FIXED_COLS));
    for (const lane of input.lanes) {
        const cost = lane.metered ? formatUsd(lane.costUsd) : 'unmetered';
        lines.push(`  ${style.glyph(lane.status)} ${lane.lane.padEnd(LANE_COL)}  ` +
            `${fit(maskSecrets(lane.detail), detailWidth)}  ${style.dim(cost.padStart(COST_COL))}`);
    }
    for (const lane of input.lanes) {
        if (lane.exceeded !== true || lane.limitUsd === undefined)
            continue;
        lines.push(`  ${style.glyph('failed')} budget exceeded: spent ${dollars(lane.spentUsd ?? lane.costUsd)} ` +
            `of ${dollars(lane.limitUsd)} (${lane.lane})`);
        const key = BUDGET_KEY[lane.lane];
        if (key !== undefined) {
            lines.push(`    raise ${key} in the config, or set ARGUS_BUDGET_USD`);
        }
    }
    const total = `total ${formatUsd(input.totalUsd)}` +
        (input.budgetUsd !== undefined ? ` of ${dollars(input.budgetUsd)} budget` : '');
    if (input.reportPath === undefined) {
        lines.push(`  ${total}`);
    }
    else {
        const oneLine = `  ${total} · report ${input.reportPath}`;
        // Too wide for one line: the report path gets its own, easy to copy.
        if (oneLine.length <= width)
            lines.push(oneLine);
        else
            lines.push(`  ${total}`, `  report ${input.reportPath}`);
    }
    return lines;
}
function laneDetail(status, summary, reason) {
    // A lane that did not pass leads with why; a passing lane with what it found.
    const text = status === 'passed' ? (summary ?? reason) : (reason ?? summary);
    return text ?? LANE_STATUS_LABEL[status];
}
function durationOf(startedAt, finishedAt) {
    const ms = Date.parse(finishedAt) - Date.parse(startedAt);
    return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
}
/** Project a verify manifest onto the summary block. */
export function verifySummary(manifest, reportPath) {
    const lanes = [];
    let budget;
    for (const id of LANE_IDS) {
        const lane = manifest.lanes[id];
        if (!lane.selected)
            continue;
        lanes.push({
            lane: id,
            status: lane.status,
            detail: laneDetail(lane.status, lane.summary, lane.reason),
            costUsd: lane.usage.costUsd,
            metered: lane.usage.metered,
            limitUsd: lane.budget.limitUsd,
            spentUsd: lane.budget.spentUsd,
            exceeded: lane.budget.exceeded,
        });
        if (lane.budget.limitUsd !== undefined)
            budget = (budget ?? 0) + lane.budget.limitUsd;
    }
    return {
        status: manifest.aggregate.status,
        headSha: shortSha(manifest.identity.intendedHeadSha ?? manifest.identity.checkoutSha),
        durationMs: durationOf(manifest.startedAt, manifest.finishedAt),
        lanes,
        totalUsd: manifest.aggregate.costUsd,
        budgetUsd: budget,
        reportPath,
    };
}
