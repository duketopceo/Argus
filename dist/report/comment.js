import { formatUsd as fmtUsd, LANE_STATUS_EMOJI, LANE_STATUS_LABEL, manifestToRunView, maskSecrets, } from './viewmodel.js';
export const SENTINEL = '<!-- argus-reviewer -->';
function formatUsd(n) {
    return `$${(n ?? 0).toFixed(6)}`;
}
function statusLine(report, missingKey) {
    if (missingKey)
        return '## argus-reviewer ⚪ skipped — no OpenRouter key';
    if (!report)
        return '## argus-reviewer ⚪ no report';
    const emoji = report.ok ? '✅' : '❌';
    const status = report.ok ? 'PASS' : 'FAIL';
    const budget = report.totals.budgetExceeded ? ' (budget cap exceeded)' : '';
    return `## argus-reviewer ${emoji} ${status}${budget}`;
}
function testRows(tests) {
    const lines = ['### Tests', ''];
    lines.push('| Test | Result | Calls | Cost | Failure |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const t of tests) {
        const result = t.ok ? '✅ pass' : '❌ fail';
        const failure = t.failureMessage ? t.failureMessage.replace(/\|/g, '\\|') : '';
        lines.push(`| ${t.name} | ${result} | ${t.visionCalls} | ${formatUsd(t.visionCostUsd)} | ${failure} |`);
    }
    return lines;
}
function costRows(totals) {
    const lines = ['### Cost ledger', ''];
    lines.push('| Line item | Value |');
    lines.push('| --- | --- |');
    lines.push(`| Vision calls | ${totals.visionCalls} |`);
    const perCall = totals.visionCalls > 0 ? formatUsd(totals.visionCostUsd / totals.visionCalls) : '$0.00';
    lines.push(`| Per-call cost (avg) | ${perCall} |`);
    for (const model of Object.keys(totals.callsByModel).sort()) {
        lines.push(`| Calls (${model}) | ${totals.callsByModel[model]} |`);
        lines.push(`| Spend (${model}) | ${formatUsd(totals.costByModel[model] ?? 0)} |`);
    }
    lines.push(`| Total vision spend | ${formatUsd(totals.visionCostUsd)} |`);
    lines.push(`| Sandbox seconds | ${totals.sandboxSeconds.toFixed(1)}s |`);
    return lines;
}
function healRows(tests) {
    const lines = ['### Heal events', ''];
    const heals = tests.flatMap((t) => t.healEvents);
    if (heals.length === 0) {
        lines.push('No heals this run.');
    }
    else {
        for (const h of heals) {
            lines.push(`- \`${h.instruction}\` healed with ${h.model ?? 'unknown model'}`);
        }
    }
    return lines;
}
function assertRows(tests) {
    const lines = ['### Assertions', ''];
    let any = false;
    for (const t of tests) {
        if (t.asserts.length === 0)
            continue;
        any = true;
        lines.push(`**${t.name}**`);
        for (const a of t.asserts) {
            const icon = a.verdict === 'pass' ? '✅' : '❌';
            lines.push(`- ${icon} *${a.question}* — ${a.reasoning}`);
        }
        lines.push('');
    }
    if (!any) {
        lines.push('No assertions recorded.');
    }
    return lines;
}
const CAPTURE_LABEL = {
    'console-error': 'console error',
    pageerror: 'page error',
    'request-failed': 'failed request',
};
/** Exploratory captures — `observed` findings, rendered but never gated on. */
function exploreRows(tests, explore) {
    const lines = ['### Exploratory', ''];
    if (explore?.skipped !== undefined) {
        lines.push(`- ⚪ explore skipped — ${explore.skipped}`);
        return lines;
    }
    // Act pass (U4b): summarize the bounded free-explore run, then merge its
    // session captures with the per-file ones below.
    if (explore?.steps !== undefined) {
        const pages = explore.visited ?? 0;
        const spend = explore.visionCostUsd !== undefined ? ` · ${formatUsd(explore.visionCostUsd)}` : '';
        lines.push(`explored **${explore.steps}** step(s) across **${pages}** page(s) — ` +
            `stopped: ${explore.stopReason ?? 'unknown'}${spend}`);
        lines.push('');
    }
    // Same capture can appear on multiple test reports from one file's shared
    // browser session — dedupe by signature before rendering.
    const seen = new Map();
    for (const c of [...(explore?.captures ?? []), ...tests.flatMap((t) => t.captures ?? [])]) {
        const key = `${c.kind}|${c.text}|${c.url ?? ''}`;
        const existing = seen.get(key);
        if (existing !== undefined) {
            existing.count += c.count;
        }
        else {
            seen.set(key, {
                label: CAPTURE_LABEL[c.kind] ?? c.kind,
                text: c.text.replace(/\|/g, '\\|'),
                ...(c.url !== undefined ? { url: c.url } : {}),
                count: c.count,
            });
        }
    }
    if (seen.size === 0) {
        lines.push('No page errors, console errors, or failed same-origin requests captured.');
        return lines;
    }
    const caps = [...seen.values()];
    for (const c of caps.slice(0, 10)) {
        const times = c.count > 1 ? ` ×${c.count}` : '';
        const target = c.url !== undefined ? ` — \`${c.url}\`` : '';
        lines.push(`- 🟡 observed · ${c.label}${times}: \`${c.text}\`${target}`);
    }
    if (caps.length > 10)
        lines.push(`- … +${caps.length - 10} more distinct capture(s)`);
    lines.push('');
    lines.push('*Observed findings are evidence only — they do not change the verdict.*');
    return lines;
}
function evidenceRows(videos, runUrl) {
    const lines = ['### Evidence', ''];
    for (const v of videos) {
        lines.push(`- video: ${v}`);
    }
    if (runUrl) {
        lines.push(`- [workflow run / artifacts](${runUrl})`);
    }
    if (videos.length === 0 && !runUrl) {
        lines.push('No artifact links configured.');
    }
    return lines;
}
function missingKeyBody() {
    return [
        '',
        '`OPENROUTER_API_KEY` is not configured. Add it as a repository or workflow secret to run argus-reviewer.',
        '',
        'This status is intentionally neutral, not a failure.',
        '',
    ];
}
function noReportBody() {
    return [
        '',
        'No run report was produced. The run may have failed before writing reports.',
        '',
    ];
}
/** Render the sticky PR comment markdown from a run report (or a missing-key state). */
export function renderComment(report, opts = {}) {
    const lines = [SENTINEL, ''];
    lines.push(statusLine(report, opts.missingKey ?? false));
    lines.push('');
    if (opts.missingKey) {
        lines.push(...missingKeyBody());
    }
    else if (!report) {
        lines.push(...noReportBody());
    }
    else {
        lines.push(`**Summary:** ${report.totals.passed}/${report.totals.tests} passed · ` +
            `${report.totals.visionCalls} vision calls · ` +
            `${formatUsd(report.totals.visionCostUsd)} spend · ` +
            `${report.totals.sandboxSeconds.toFixed(1)}s sandbox · ` +
            `${(report.durationMs / 1000).toFixed(1)}s wall`);
        lines.push('');
        lines.push(...testRows(report.tests));
        lines.push(...costRows(report.totals));
        lines.push(...healRows(report.tests));
        lines.push(...assertRows(report.tests));
        if (report.explore?.enabled === true) {
            lines.push(...exploreRows(report.tests, report.explore));
        }
        lines.push(...evidenceRows(report.artifacts.videos, opts.runUrl));
    }
    return lines.join('\n');
}
/**
 * Sticky comment for a `verify` run — the manifest is the evidence contract
 * (R15). Lane names, status labels, model/cost, and head identity come from
 * the shared view-model so the comment agrees with the TUI and dashboard
 * under the contract test, not by convention.
 */
export function renderManifestComment(manifest, opts = {}) {
    const view = manifestToRunView(manifest);
    const emoji = LANE_STATUS_EMOJI[view.status];
    const lines = [SENTINEL, ''];
    lines.push(`## argus-reviewer ${emoji} ${view.statusLabel.toUpperCase()}`);
    lines.push('');
    const headBits = [];
    if (view.intendedHeadSha !== undefined) {
        headBits.push(`head \`${view.intendedHeadSha.slice(0, 7)}\``);
    }
    if (view.headBinding !== undefined) {
        headBits.push(`${view.headBinding.status} — ${view.headBinding.detail}`);
    }
    lines.push(`**Run:** ${view.runId} · ${view.calls} provider call(s) · ` +
        `${fmtUsd(view.costUsd)} spend${headBits.length > 0 ? ` · ${headBits.join(' · ')}` : ''}`);
    lines.push('');
    lines.push('| Lane | Status | Calls | Cost | Detail |');
    lines.push('| --- | --- | ---: | ---: | --- |');
    for (const lane of view.selectedLanes) {
        const icon = LANE_STATUS_EMOJI[lane.status];
        const usage = lane.usage;
        const cost = usage.metered ? fmtUsd(usage.costUsd) : 'unmetered';
        const detail = maskSecrets(lane.reason ?? lane.summary ?? '').replace(/\|/g, '\\|');
        const model = lane.model !== undefined ? ` (\`${lane.model}\`)` : '';
        lines.push(`| ${lane.lane} | ${icon} ${LANE_STATUS_LABEL[lane.status]} | ` +
            `${usage.calls} | ${cost} | ${detail}${model} |`);
    }
    for (const lane of view.lanes) {
        if (lane.selected)
            continue;
        lines.push(`| ${lane.lane} | ⚪ skipped | 0 | — | not selected |`);
    }
    lines.push('');
    const flowLane = view.lanes.find((l) => l.lane === 'flow');
    if (flowLane?.cache !== undefined) {
        const c = flowLane.cache;
        lines.push(`**Fingerprint cache:** ${c.hits} hit(s) · ${c.misses} miss(es) · ${c.heals} heal(s)`);
        lines.push('');
    }
    const evidence = view.selectedLanes.filter((l) => l.reportPath !== undefined);
    if (evidence.length > 0 || opts.runUrl !== undefined) {
        lines.push('### Evidence');
        lines.push('');
        for (const lane of evidence) {
            lines.push(`- ${lane.lane}: \`${lane.reportPath}\``);
        }
        if (opts.runUrl !== undefined) {
            lines.push(`- [workflow run / artifacts](${opts.runUrl})`);
        }
        lines.push('');
    }
    lines.push('---');
    lines.push('');
    lines.push('<sub>`argus-reviewer` — self-hosted, BYOK review. Lane detail lives in the run manifest.</sub>');
    lines.push('');
    return lines.join('\n');
}
/** Map a run report (and optional missing-key flag) to a check-run conclusion. */
export function conclusionFromReport(report, missingKey = false) {
    if (missingKey)
        return 'neutral';
    if (!report)
        return 'failure';
    return report.ok ? 'success' : 'failure';
}
