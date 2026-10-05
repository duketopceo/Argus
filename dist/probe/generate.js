import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { defaultExec } from '../detect.js';
import { createFilesPr } from '../github/write-pr.js';
import { parseProbe, probeImportsSafe, PROBE_CONTENT_CAP, } from './author.js';
import { detectHarness } from './harness.js';
import { findExemplarTest, isSafeRepoPath } from './queue.js';
import { checkSandboxPaths, dockerAvailable, resolveSandboxImage, runProbeInSandbox, SANDBOX_OUTPUT_CAP, SCRATCH_DIR_NAME, stripControlChars, sandboxLimits, } from '../executor/sandbox.js';
/**
 * U2 — diff-scoped test generation. Where the probe lane authors one
 * reproducer per `not_exercised` finding, this lane reads the whole PR
 * diff and authors general-purpose spec leafs covering the changed
 * behavior, sandbox-validates them green on head when a real head
 * checkout is present, and deposits the result on a reviewable PR under
 * the tests corpus root.
 *
 * Two trust postures the probe lane already established carry over:
 * - model-authored code is hostile input — filename, content cap, import
 *   scan, secret-env and path checks are identical (parseProbe reuse),
 *   with a stricter leaf-name contract on top;
 * - the PR is the boundary — sandbox green proves "passes in a
 *   container", never safety; the specs execute host-side in consumer CI
 *   after a human merges them.
 */
/**
 * Leaf-name contract for generated specs — stricter than the probe
 * basename RE: lowercase slug, a single `.test.` separator, no dots
 * inside the stem (so `foo.config.test.ts`, `vitest.setup.test.ts` and
 * `a.b.test.tsx` can never slip a config/setup-looking basename past).
 */
export const GEN_FILENAME_RE = /^[a-z0-9][a-z0-9-]{0,80}\.test\.[jt]sx?$/;
/** Stems that must never be authored even though they parse as test leafs. */
const GEN_FORBIDDEN_STEMS = new Set(['setup', 'conftest', 'config', 'fixture']);
/** The diff text handed to the authoring call, hard-capped. */
export const GENERATE_DIFF_CAP = 48 * 1024;
/** Schema ceiling independent of config — the lane also truncates at parse. */
const GEN_SCHEMA_MAX = 8;
export const GENERATE_SCHEMA = {
    name: 'argus-generate',
    strict: true,
    schema: {
        type: 'object',
        properties: {
            specs: {
                type: 'array',
                maxItems: GEN_SCHEMA_MAX,
                items: {
                    type: 'object',
                    properties: {
                        filename: {
                            type: 'string',
                            description: 'Bare leaf filename, lowercase slug ending .test.ts - no directories',
                        },
                        content: { type: 'string', description: 'Complete spec file contents' },
                        reasoning: { type: 'string' },
                    },
                    required: ['filename', 'content', 'reasoning'],
                    additionalProperties: false,
                },
            },
            note: {
                type: 'string',
                description: 'Why zero (or few) specs were authored - e.g. "docs-only diff, nothing behavioral to cover".',
            },
        },
        required: ['specs', 'note'],
        additionalProperties: false,
    },
};
/**
 * Zero-spend early-out for diffs that provably carry no behavioral change:
 * every changed path is docs/markup/meta. Narrow on purpose — anything
 * ambiguous falls through to the model call, which can still answer with
 * an empty specs list + note.
 */
const DOCS_ONLY_RE = /(^|\/)(docs?|documentation)(\/|$)|\.(md|mdx|rst|txt|adoc)$|(^|\/)(CHANGELOG|CHANGES|LICENSE|LICEN|NOTICE|AUTHORS|CODEOWNERS|CONTRIBUTING|SECURITY)(\.|\b)/i;
export function isDocsOnlyDiff(changedPaths) {
    return changedPaths.length > 0 && changedPaths.every((p) => DOCS_ONLY_RE.test(p));
}
/**
 * Parse the array-shaped authoring response. Each item reuses parseProbe's
 * full validation (content cap, secret-env scan, import-specifier scan via
 * the TypeScript parser) and then the stricter generated-leaf contract on
 * the filename. Per-item failures are collected, not fatal — one poisoned
 * spec must not sink the honest ones.
 */
export function parseGeneratedSpecs(raw, maxSpecs) {
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return { ok: false, reason: 'unparseable model response' };
    }
    if (!Array.isArray(parsed.specs)) {
        return { ok: false, reason: 'response missing specs array' };
    }
    const note = typeof parsed.note === 'string' ? parsed.note : '';
    const specs = [];
    const rejected = [];
    for (const item of parsed.specs.slice(0, GEN_SCHEMA_MAX)) {
        if (specs.length >= maxSpecs) {
            rejected.push({ filename: '(cap)', reason: `over configured maxSpecs ${maxSpecs}` });
            continue;
        }
        const name = typeof item === 'object' && item !== null && typeof item.filename === 'string'
            ? item.filename
            : '(unnamed)';
        // Re-validate through the single-probe parser — one schema, one gate.
        const single = parseProbe(JSON.stringify(item));
        if (!single.ok) {
            rejected.push({ filename: name, reason: single.reason });
            continue;
        }
        const fname = single.probe.filename;
        if (!GEN_FILENAME_RE.test(fname)) {
            rejected.push({ filename: fname, reason: `filename outside generated-spec contract: ${fname}` });
            continue;
        }
        const stem = fname.split('.test.')[0] ?? '';
        if (GEN_FORBIDDEN_STEMS.has(stem)) {
            rejected.push({ filename: fname, reason: `forbidden spec stem: ${stem}` });
            continue;
        }
        specs.push(single.probe);
    }
    return { ok: true, specs, rejected, note };
}
export function buildGenerateMessages(diff, exemplarTest, harness, testsDir, maxSpecs) {
    const harnessNote = harness.kind === 'vitest'
        ? 'Vitest (import { describe, it, expect } from \'vitest\')'
        : harness.kind === 'jest'
            ? 'Jest (globals describe/it/expect)'
            : 'node:test (import { test } from \'node:test\' + node:assert)';
    const system = `You author test specs that cover the behavior a pull request changes. Output is JSON only, matching the schema.

Rules:
- Each spec asserts the CORRECT post-change behavior - it must PASS when run against the PR head. Never assert the bug; assert the contract.
- filename is a bare leaf: lowercase slug like 'billing-retry.test.ts' matching /^[a-z0-9][a-z0-9-]{0,80}\\.test\\.[jt]sx?$/ - no directories, no dots in the stem. The file lands at ${testsDir}/<filename>.
- Imports resolve from ${testsDir}/ - relative paths start '../' (e.g. '../src/billing'), bare specifiers come from the repo's dependencies, 'node:' builtins are allowed.
- Never read process.env (especially secrets), the network, or files outside the repo.
- Assert through public behavior, not internals - specs survive refactors.
- The repo's harness is ${harnessNote}. Match the exemplar's import style when given.
- At most ${maxSpecs} spec(s). One file may cover several changed behaviors when they share a module.
- Docs/config-only diffs, lockfile churn, and renames-with-no-behavior are not testable - return specs: [] with a note saying why. Do not invent coverage for behavior the diff does not change.`;
    const parts = [`Here is the pull request diff to cover:\n\n${diff}`];
    if (exemplarTest !== undefined) {
        parts.push(`\nAn existing test file for style/import reference (${exemplarTest.path}):\n\n${exemplarTest.content}`);
    }
    return [
        { role: 'system', content: [{ type: 'text', text: system }] },
        { role: 'user', content: [{ type: 'text', text: parts.join('\n') }] },
    ];
}
/** `timedOut` or the never-ran `-1` sentinel → run inconclusive; else the harness classifies. */
function outcomeOf(harness, r) {
    return r.timedOut || r.exitCode === -1 ? 'error' : harness.classify(r);
}
function cappedOutput(stdout, stderr) {
    const combined = stripControlChars(`${stdout}\n${stderr}`)
        // eslint-disable-next-line no-control-regex
        .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
        .trim();
    return combined === '' ? undefined : combined.slice(0, SANDBOX_OUTPUT_CAP);
}
/**
 * Run the generation lane. Never throws into the caller — every failure
 * degrades to a skipReason or per-record detail, and the lane never
 * changes the review verdict, ok, or the exit code.
 */
export async function runGenerateLane(o) {
    const log = o.log ?? (() => undefined);
    const empty = { records: [], costUsd: 0, tokens: 0 };
    const skip = (reason) => {
        log(`generate: skipped - ${reason}`);
        return { ...empty, skipReason: reason };
    };
    // Hard refusal: generation writes model-authored code to a reviewable
    // PR — on a fork that becomes a contributor-steered write path even
    // with a read-only token (the failed-open call still burns budget).
    if (o.meta?.isFork === true) {
        return skip('fork PR - generated write-back never runs on forks');
    }
    if (o.diff.trim() === '')
        return skip('empty diff');
    if (isDocsOnlyDiff(o.changedPaths))
        return skip('docs-only diff - no behavioral changes to cover');
    if (o.budgetUsd !== undefined && o.ledger.visionCostUsd >= o.budgetUsd) {
        return skip('review budget already spent');
    }
    if (!isSafeRepoPath(o.testsDir)) {
        return skip(`tests dir outside the repo: ${o.testsDir}`);
    }
    // Harness detection serves both the prompt (import style) and the
    // sandbox run command — no harness means nothing can execute the leafs.
    const harness = await detectHarness(o.cwd);
    if (harness === undefined)
        return skip('no supported test harness (vitest/jest/node --test)');
    // Sandbox validation is optional per-run: absent (base checkout on the
    // mention lane, sandbox disabled) every spec ships as an unvalidated
    // draft. Enabled-but-unusable docker lands the same way, never as a
    // hard failure.
    const exec = o.exec ?? defaultExec;
    let sandboxUsable = false;
    let sandboxSkipNote = '';
    if (o.sandbox !== undefined) {
        const image = resolveSandboxImage(o.sandbox.image);
        if (!(await dockerAvailable(exec, image, o.cwd))) {
            sandboxSkipNote = 'docker unavailable - specs ship unvalidated';
        }
        else {
            const dirCheck = await checkSandboxPaths(o.cwd, o.reportDir);
            if (!dirCheck.ok) {
                sandboxSkipNote = `report dir unsafe: ${dirCheck.reason}`;
            }
            else {
                const scratchDir = join(o.reportDir, SCRATCH_DIR_NAME);
                try {
                    await mkdir(scratchDir, { recursive: true, mode: 0o777 });
                    await chmod(scratchDir, 0o777);
                }
                catch (e) {
                    sandboxSkipNote = `scratch dir unusable: ${e.message}`;
                }
                if (sandboxSkipNote === '') {
                    const scratchCheck = await checkSandboxPaths(o.cwd, scratchDir);
                    if (scratchCheck.ok)
                        sandboxUsable = true;
                    else
                        sandboxSkipNote = scratchCheck.reason;
                }
            }
        }
        if (sandboxSkipNote !== '')
            log(`generate: ${sandboxSkipNote}`);
    }
    // Authoring call — one request for the whole diff, bounded by schema.
    const exemplarPath = findExemplarTest(o.index, o.testsDir === '' ? 'x' : `${o.testsDir}/x`);
    const rawExemplar = exemplarPath === undefined
        ? undefined
        : await readFile(join(o.cwd, exemplarPath), 'utf8').catch(() => undefined);
    const exemplar = exemplarPath === undefined || rawExemplar === undefined
        ? undefined
        : {
            path: exemplarPath,
            content: rawExemplar.length > PROBE_CONTENT_CAP
                ? `${rawExemplar.slice(0, PROBE_CONTENT_CAP)}\n…[truncated]`
                : rawExemplar,
        };
    const diff = o.diff.length > GENERATE_DIFF_CAP ? `${o.diff.slice(0, GENERATE_DIFF_CAP)}\n…[truncated]` : o.diff;
    let response;
    try {
        response = await o.client.complete({
            model: o.model,
            messages: buildGenerateMessages(diff, exemplar, harness, o.testsDir, o.maxSpecs),
            schema: GENERATE_SCHEMA,
            kind: 'code',
            ...(o.provider !== undefined ? { provider: o.provider } : {}),
        });
    }
    catch (e) {
        return skip(`authoring call failed: ${e.message}`);
    }
    o.ledger.recordCall(response.cost);
    o.calls?.push(response.cost);
    const authored = parseGeneratedSpecs(response.content, o.maxSpecs);
    if (!authored.ok)
        return skip(`authoring failed: ${authored.reason}`);
    const records = [];
    for (const r of authored.rejected) {
        records.push({
            path: r.filename,
            status: 'rejected',
            validation: 'unvalidated',
            detail: r.reason,
            content: '',
            reasoning: '',
        });
    }
    if (authored.specs.length === 0) {
        return {
            records,
            note: authored.note,
            costUsd: response.cost.costUsd,
            tokens: response.cost.tokens,
            ...(authored.rejected.length === 0 ? { skipReason: authored.note || 'model produced no specs' } : {}),
        };
    }
    const scratchDir = join(o.reportDir, SCRATCH_DIR_NAME);
    const image = o.sandbox !== undefined ? resolveSandboxImage(o.sandbox.image) : '';
    for (let i = 0; i < authored.specs.length; i++) {
        const spec = authored.specs[i];
        const relPath = posix.join(o.testsDir, spec.filename);
        if (!isSafeRepoPath(relPath)) {
            records.push({
                path: relPath,
                status: 'rejected',
                validation: 'unvalidated',
                detail: `unsafe path: ${relPath}`,
                content: spec.content.slice(0, PROBE_CONTENT_CAP),
                reasoning: spec.reasoning,
            });
            continue;
        }
        if (!probeImportsSafe(spec, relPath)) {
            records.push({
                path: relPath,
                status: 'rejected',
                validation: 'unvalidated',
                detail: 'relative import escapes the repo',
                content: spec.content.slice(0, PROBE_CONTENT_CAP),
                reasoning: spec.reasoning,
            });
            continue;
        }
        let validation = 'unvalidated';
        let detail = o.sandbox === undefined ? 'no sandbox - unvalidated draft' : sandboxSkipNote;
        let output;
        if (sandboxUsable && o.sandbox !== undefined) {
            try {
                await writeFile(join(o.cwd, relPath), spec.content, { encoding: 'utf8', flag: 'wx' });
            }
            catch {
                records.push({
                    path: relPath,
                    status: 'rejected',
                    validation: 'unvalidated',
                    detail: `host write failed (path exists or unwritable): ${relPath}`,
                    content: spec.content.slice(0, PROBE_CONTENT_CAP),
                    reasoning: spec.reasoning,
                });
                continue;
            }
            try {
                const run = await runProbeInSandbox({
                    workdir: o.cwd,
                    scratchDir,
                    cmd: harness.runCmd(relPath),
                    image,
                    name: `gen-${i}`,
                    exec,
                    ...sandboxLimits(o.sandbox),
                });
                const outcome = outcomeOf(harness, run);
                output = cappedOutput(run.stdout, run.stderr);
                if (outcome === 'clean') {
                    validation = 'green';
                    detail = 'green in sandbox on head';
                }
                else {
                    validation = 'failed';
                    detail = `sandbox: ${outcome}${output !== undefined ? `: ${output.split('\n')[0]}` : ''}`;
                }
            }
            finally {
                // Only remove what we created — the 'wx' flag above proves it's ours.
                await rm(join(o.cwd, relPath), { force: true }).catch(() => undefined);
            }
        }
        records.push({
            path: relPath,
            // Failed validation excludes the spec from the write PR; unvalidated
            // drafts still ship (clearly labeled) — the human review is the gate.
            status: validation === 'failed' ? 'draft' : 'committed',
            validation,
            detail,
            content: spec.content.slice(0, PROBE_CONTENT_CAP),
            reasoning: spec.reasoning,
        });
    }
    // Deposit: every non-failed, non-rejected spec goes to the write PR.
    const shippable = records.filter((r) => r.status === 'committed');
    let prUrl;
    if (shippable.length > 0) {
        if (o.repo === undefined || o.token === undefined || o.meta?.baseRef === undefined) {
            for (const r of shippable) {
                r.status = 'draft';
                r.detail = `${r.detail} (no GitHub write context - not deposited)`;
            }
        }
        else {
            const unvalidated = shippable.filter((r) => r.validation !== 'green').length;
            const drafts = records.filter((r) => r.status === 'draft' || r.status === 'rejected');
            const headSha = o.meta.headSha ?? 'unknown';
            const result = await createFilesPr({
                repo: o.repo,
                baseRef: o.meta.baseRef,
                branch: `argus/generated-tests-${headSha.slice(0, 8)}`,
                files: shippable.map((r) => ({ path: r.path, content: r.content })),
                title: `test: Argus generated coverage for ${o.pr !== undefined ? `#${o.pr}` : 'this change'}`,
                exists: 'create',
                body: ({ written, skipped }) => renderGenerateBody({
                    written,
                    skipped,
                    drafts,
                    pr: o.pr,
                    headSha,
                    unvalidated,
                }),
            }, o.token, { err: log });
            prUrl = result.prUrl;
            if (result.error !== undefined) {
                for (const r of shippable) {
                    r.status = 'draft';
                    r.detail = `${r.detail} (write failed: ${result.error})`;
                }
            }
            else {
                for (const r of records) {
                    if (r.status === 'committed' && result.skipped.includes(r.path)) {
                        r.status = 'draft';
                        r.detail = `${r.detail} (path already exists - exclusive create skipped)`;
                    }
                    else if (r.status === 'committed' && !result.written.includes(r.path)) {
                        r.status = 'draft';
                        r.detail = `${r.detail} (not written)`;
                    }
                }
            }
        }
    }
    log(`generate: ${records.filter((r) => r.status === 'committed').length} committed, ` +
        `${records.filter((r) => r.status === 'draft').length} draft, ` +
        `${records.filter((r) => r.status === 'rejected').length} rejected` +
        (prUrl !== undefined ? ` - ${prUrl}` : ''));
    return {
        records,
        costUsd: response.cost.costUsd,
        tokens: response.cost.tokens,
        ...(prUrl !== undefined ? { prUrl } : {}),
        ...(authored.note !== '' ? { note: authored.note } : {}),
    };
}
/** ASCII only — the repo's no-em-dash test convention applies here too. */
function renderGenerateBody(p) {
    const lines = [
        'Authored test specs covering the changed behavior in this PR, generated by Argus.',
        '',
        `Source: ${p.pr !== undefined ? `#${p.pr}` : 'review run'} @ head \`${p.headSha.slice(0, 8)}\``,
        '',
    ];
    if (p.written.length > 0) {
        lines.push('## Specs', '');
        for (const w of p.written)
            lines.push(`- \`${w}\``);
        lines.push('');
    }
    if (p.skipped.length > 0) {
        lines.push('Skipped (already exists on branch):');
        for (const s of p.skipped)
            lines.push(`- \`${s}\``);
        lines.push('');
    }
    if (p.unvalidated > 0) {
        lines.push(`> ${p.unvalidated} spec(s) were NOT sandbox-validated (no head checkout / docker) -`, '> they may not compile or pass. Review before merging.', '');
    }
    lines.push('**Sandbox validation proves "green in a container", not safety.** These files are', 'model-authored and will run host-side in your CI after merge - review them like any', 'contributor PR.');
    if (p.drafts.length > 0) {
        lines.push('', '## Held back as drafts (not on this branch):');
        for (const d of p.drafts.slice(0, 10)) {
            lines.push(`- \`${d.path}\` - ${d.detail}`);
        }
        if (p.drafts.length > 10)
            lines.push(`- ...and ${p.drafts.length - 10} more (see the review report)`);
        lines.push('');
    }
    lines.push('', '<sub>Generated by Argus - self-hosted, BYOK</sub>', '');
    return lines.join('\n');
}
