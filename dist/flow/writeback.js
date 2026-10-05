import { join } from 'node:path';
import { writeAtomicText } from '../fsutil.js';
import { serializeFlow } from '../cache/store.js';
import { createFilesPr } from '../github/write-pr.js';
import { isSafeRepoPath } from '../probe/queue.js';
/** Relocation fields a heal may legitimately replace. */
const RELOCATION_FIELDS = new Set(['bbox', 'clickPoint', 'regionHash', 'a11ySnippet', 'model']);
/** Action fields that move with relocation — everything else is payload. */
const RELOCATION_ACTION_FIELDS = new Set(['x', 'y']);
const FLOW_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,119}$/;
/** Flow names map to `<dir>/<name>.json` — refuse anything path-shaped. */
export function isSafeFlowName(name) {
    return FLOW_NAME_RE.test(name);
}
function diffKeys(a, b) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].filter((k) => k !== 'stale' && JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null));
}
/**
 * Relocation-only gate per healed step. `action` and `instruction` are the
 * payload: `action.x/y` may move (that IS the relocation), but a changed
 * kind/text/keys/dx/dy/ms — or a rewritten instruction — means the model
 * tried to rewrite the step, not relocate it. `stale` never round-trips.
 */
export function planWriteback(flow) {
    const steps = [...flow.steps];
    const applied = [];
    const suppressed = [];
    for (const heal of flow.heals) {
        const { before, after } = heal;
        if (before.instruction !== after.instruction) {
            suppressed.push({ heal, reason: 'instruction changed' });
            continue;
        }
        const fieldDiff = diffKeys(before, after).filter((k) => k !== 'action');
        const badField = fieldDiff.find((k) => !RELOCATION_FIELDS.has(k));
        if (badField !== undefined) {
            suppressed.push({ heal, reason: `unexpected field changed: ${badField}` });
            continue;
        }
        const actionDiff = diffKeys(before.action, after.action);
        const badAction = actionDiff.find((k) => !RELOCATION_ACTION_FIELDS.has(k));
        if (badAction !== undefined) {
            suppressed.push({ heal, reason: `action payload changed: ${badAction}` });
            continue;
        }
        // A heal that re-resolved to the identical record confirms the location
        // but changes nothing — writing it would be an empty-diff PR.
        if (fieldDiff.length === 0 && actionDiff.length === 0)
            continue;
        applied.push(heal);
        // Write `after` minus `stale` — every differing field already verified
        // to be a relocation field.
        const { stale: _stale, ...rest } = after;
        steps[heal.index] = rest;
    }
    for (const { heal } of suppressed) {
        steps[heal.index] = heal.before;
    }
    return { steps, applied, suppressed };
}
/** Repo-relative path for a flow's committed recording — refused fail-closed. */
export function flowRelPath(flowsDir, flowName) {
    if (!isSafeFlowName(flowName))
        return undefined;
    const path = `${flowsDir}/${flowName}.json`;
    return isSafeRepoPath(path) ? path : undefined;
}
function stepCard(flowName, heal, status) {
    const { before, after } = heal;
    const where = (r) => `(${r.clickPoint.x},${r.clickPoint.y})`;
    const lines = [
        `- **step ${heal.index + 1}**: ${before.instruction}`,
        `  - action: \`${before.action.action}\`, element: ${before.a11ySnippet.slice(0, 80)}`,
        `  - relocated: ${where(before)} -> ${where(after)} (model: ${after.model})`,
    ];
    if (status === 'suppressed') {
        lines.push('  - **suppressed** - the healed step changed more than its location; kept the recorded action');
    }
    return lines.join('\n');
}
/** PR body — legible step cards, not a raw record diff. */
export function renderWritebackBody(flows, headSha) {
    const sections = flows.map(({ flow, plan }) => {
        const cards = [
            ...plan.applied.map((h) => stepCard(flow.flowName, h, 'applied')),
            ...plan.suppressed.map(({ heal }) => stepCard(flow.flowName, heal, 'suppressed')),
        ];
        const suppressedNotes = plan.suppressed
            .map(({ heal, reason }) => `  - suppressed step ${heal.index + 1}: ${reason}`)
            .join('\n');
        return [
            `### \`${flow.flowName}\``,
            '',
            ...cards,
            ...(suppressedNotes === '' ? [] : ['', suppressedNotes]),
        ].join('\n');
    });
    return [
        `Argus healed ${flows.reduce((n, f) => n + f.plan.applied.length, 0)} relocated step(s) ` +
            `during a flow run${headSha !== undefined ? ` at \`${headSha.slice(0, 7)}\`` : ''}. ` +
            `This PR writes the re-resolved locations back to the committed flow recordings ` +
            `so replays stay cache-hit cheap.`,
        '',
        ...sections,
        '',
        `Only relocation fields may change (bbox, clickPoint, regionHash, a11ySnippet). ` +
            `A heal that rewrote an action, its text, or its keys is suppressed and kept ` +
            `pre-heal in the file.`,
        '',
        `**Warning:** healed locations are model-authored; review each step card before ` +
            `merging. Generated by [argus-reviewer](https://github.com/duketopceo/argus-reviewer).`,
    ].join('\n');
}
/**
 * Collect sanitized write-back files from healed flows. Returns undefined
 * when nothing survives sanitization or a flow name is unsafe — the caller
 * reports the skip, the lane never fails.
 */
export function buildWritebackFiles(flows, flowsDir) {
    const files = [];
    const plans = new Map();
    const unsafe = [];
    for (const flow of flows) {
        const path = flowRelPath(flowsDir, flow.flowName);
        if (path === undefined) {
            unsafe.push(flow.flowName);
            continue;
        }
        const plan = planWriteback(flow);
        if (plan.applied.length === 0) {
            plans.set(flow.flowName, plan);
            continue;
        }
        plans.set(flow.flowName, plan);
        files.push({ path, content: serializeFlow(plan.steps, flow.asserts) });
    }
    return { files, plans, unsafe };
}
/**
 * CI path: commit sanitized recordings to `argus/flow-heals-<sha7>` and open
 * one PR against the base ref.
 */
export async function writebackHealsToPr(flows, flowsDir, gh, ctx) {
    const { files, plans, unsafe } = buildWritebackFiles(flows, flowsDir);
    for (const name of unsafe) {
        ctx.err(`heal write-back: unsafe flow name "${name}" skipped`);
    }
    if (files.length === 0) {
        return { plans, skipped: 'no applied heals after sanitization' };
    }
    const sha7 = gh.headSha?.slice(0, 7) ?? 'run';
    const result = await createFilesPr({
        repo: gh.repo,
        baseRef: gh.baseRef,
        branch: `argus/flow-heals-${sha7}`,
        files,
        title: `fix(tests): Argus flow heal write-back${gh.pr !== undefined ? ` for #${gh.pr}` : ''}`,
        body: (r) => renderWritebackBody(flows
            .filter((f) => plans.has(f.flowName))
            .map((f) => ({ flow: f, plan: plans.get(f.flowName) })), gh.headSha) +
            `\n\nFiles:\n${[...r.written.map((p) => `- \`${p}\` (new)`), ...r.updated.map((p) => `- \`${p}\` (updated)`), ...r.skipped.map((p) => `- \`${p}\` (skipped)`)].join('\n')}`,
        exists: 'upsert',
    }, gh.token, ctx);
    return { plans, result };
}
/**
 * Local path: write sanitized recordings to the working tree — `git diff` is
 * the review surface, same contract as the PR.
 */
export async function writebackHealsLocal(flows, flowsDirAbs, ctx) {
    const plans = new Map();
    let wrote = 0;
    for (const flow of flows) {
        if (!isSafeFlowName(flow.flowName)) {
            ctx.err(`heal write-back: unsafe flow name "${flow.flowName}" skipped`);
            continue;
        }
        const plan = planWriteback(flow);
        plans.set(flow.flowName, plan);
        if (plan.applied.length === 0)
            continue;
        await writeAtomicText(join(flowsDirAbs, `${flow.flowName}.json`), serializeFlow(plan.steps, flow.asserts));
        wrote++;
    }
    if (wrote === 0)
        return { plans, skipped: 'no applied heals after sanitization' };
    return { plans };
}
