import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { defaultExec } from '../detect.js';
import { mayProbePr } from '../evidence/gate.js';
import { isTestFile } from '../evidence/link.js';
import { buildProbeMessages, parseProbe, PROBE_SCHEMA } from './author.js';
import { detectHarness } from './harness.js';
import { checkSandboxPaths, dockerAvailable, resolveSandboxImage, runProbeInSandbox, SANDBOX_OUTPUT_CAP, SCRATCH_DIR_NAME, sandboxLimits, } from '../executor/sandbox.js';
/** Pure selection: not_exercised findings at blocking severities, capped. */
export function selectProbeTargets(findings, severityGates, maxProbes) {
    return findings
        .filter((f) => f.evidence.status === 'not_exercised' &&
        f.file !== undefined &&
        severityGates.includes(f.severity ?? ''))
        .slice(0, Math.max(0, maxProbes));
}
/**
 * Nearest existing test file to the finding's file — same directory first,
 * then same top-level segment, then any test file. The exemplar sets the
 * probe's write location so the consumer's own include/roots cover it.
 */
export function findExemplarTest(index, findingFile) {
    const tests = index?.entries.map((e) => e.path).filter(isTestFile) ?? [];
    if (tests.length === 0)
        return undefined;
    const dir = dirname(findingFile);
    const same = tests.find((t) => dirname(t) === dir);
    if (same !== undefined)
        return same;
    const top = findingFile.split('/')[0];
    return tests.find((t) => t.split('/')[0] === top) ?? tests[0];
}
/**
 * Ensure `baseSha` is fetchable and checked out as a detached worktree at
 * `wtDir`. Returns the worktree path, or undefined when the base cannot be
 * materialized — probes then run head-only and can never mark `reproduced`.
 */
async function addBaseWorktree(exec, cwd, wtDir, baseSha, token) {
    const have = await exec('git', ['-C', cwd, 'cat-file', '-e', `${baseSha}^{commit}`], 15_000);
    if (have.code !== 0) {
        // Shallow PR checkouts lack the base — fetch it. Auth rides a one-off
        // extraheader like actions/checkout, so persist-credentials: false is
        // compatible.
        const args = ['-C', cwd];
        if (token !== undefined) {
            const auth = Buffer.from(`x-access-token:${token}`).toString('base64');
            args.push('-c', `http.https://github.com/.extraheader=AUTHORIZATION: basic ${auth}`);
        }
        args.push('fetch', '--depth', '1', 'origin', baseSha);
        const fetched = await exec('git', args, 60_000);
        if (fetched.code !== 0)
            return undefined;
    }
    const added = await exec('git', ['-C', cwd, 'worktree', 'add', '--detach', wtDir, baseSha], 60_000);
    return added.code === 0 ? wtDir : undefined;
}
async function removeBaseWorktree(exec, cwd, wtDir) {
    const res = await exec('git', ['-C', cwd, 'worktree', 'remove', '--force', wtDir], 30_000);
    if (res.code !== 0)
        await rm(wtDir, { recursive: true, force: true }).catch(() => undefined);
}
/** One bounded authoring call; returns the validated probe or undefined. */
async function authorProbe(o, target, harness, exemplarPath) {
    const fileContents = target.file === undefined
        ? undefined
        : await readFile(join(o.cwd, target.file), 'utf8').catch(() => undefined);
    const exemplar = exemplarPath === undefined
        ? undefined
        : {
            path: exemplarPath,
            content: await readFile(join(o.cwd, exemplarPath), 'utf8').catch(() => undefined),
        };
    const response = await o.client.complete({
        model: o.model,
        messages: buildProbeMessages({
            file: target.file,
            line: target.line,
            severity: target.severity ?? 'bug',
            message: target.message ?? '',
        }, fileContents, exemplar?.content === undefined ? undefined : { path: exemplar.path, content: exemplar.content }, harness),
        schema: PROBE_SCHEMA,
        kind: 'code',
        ...(o.provider !== undefined ? { provider: o.provider } : {}),
    });
    o.ledger.recordCall(response.cost);
    const parsed = parseProbe(response.content);
    if (!parsed.ok)
        return { probe: undefined, reason: parsed.reason };
    return { probe: parsed.probe, costUsd: response.cost.costUsd };
}
function record(target, probe, outcome, detail, extra = {}) {
    return {
        file: probe?.filename ?? '(none)',
        findingFile: target.file,
        findingLine: target.line,
        outcome,
        durationMs: extra.durationMs ?? 0,
        costUsd: extra.costUsd ?? 0,
        detail,
        ...(extra.headOutcome !== undefined ? { headOutcome: extra.headOutcome } : {}),
        ...(extra.baseOutcome !== undefined ? { baseOutcome: extra.baseOutcome } : {}),
        ...(extra.output !== undefined ? { output: extra.output } : {}),
    };
}
function probeOutput(stdout, stderr) {
    const combined = `${stdout}\n${stderr}`.trim();
    return combined === '' ? undefined : combined.slice(0, SANDBOX_OUTPUT_CAP);
}
/**
 * Run the probe lane. Mutates `findings` evidence in place for reproduced
 * results and returns the per-probe audit records for code-review.json.
 */
export async function runProbeLane(findings, o) {
    const log = o.log ?? (() => undefined);
    if (!o.enabled)
        return undefined;
    const sandbox = { ...o.sandbox, enabled: true };
    const targets = selectProbeTargets(findings, o.severityGates, sandbox.maxProbes);
    if (targets.length === 0)
        return undefined;
    if (!mayProbePr(o.meta, sandbox)) {
        log('probes: skipped — fork gate (needs argus-probe label on this head or allowForks)');
        return undefined;
    }
    const image = resolveSandboxImage(sandbox.image);
    const exec = o.exec ?? defaultExec;
    if (!(await dockerAvailable(exec, image, o.cwd))) {
        log('probes: skipped — docker unavailable or cannot see the workspace');
        return undefined;
    }
    const harness = await detectHarness(o.cwd);
    if (harness === undefined) {
        log('probes: skipped — no supported test harness (vitest/jest/node --test)');
        return undefined;
    }
    const scratchDir = join(o.reportDir, SCRATCH_DIR_NAME);
    await mkdir(scratchDir, { recursive: true });
    const scratchCheck = await checkSandboxPaths(o.cwd, scratchDir);
    if (!scratchCheck.ok) {
        log(`probes: skipped — ${scratchCheck.reason}`);
        return undefined;
    }
    // The double-run needs a merge-base checkout. Failures here don't block
    // the lane — head results still record — but without base nothing can
    // upgrade to `reproduced`.
    const wtDir = join(o.reportDir, 'probes-base');
    let baseDir;
    if (o.meta?.baseSha !== undefined) {
        baseDir = await addBaseWorktree(exec, o.cwd, wtDir, o.meta.baseSha, o.token);
    }
    if (baseDir === undefined) {
        log('probes: base worktree unavailable — head results will be recorded but cannot reproduce');
    }
    const records = [];
    try {
        for (const target of targets) {
            // Authoring stops at the budget edge but must NOT flag the ledger —
            // `budgetExceeded` flips the review verdict, and KTD8 pins the lane
            // to never change verdict. The spend still records on the ledger.
            if (o.budgetUsd !== undefined && o.ledger.visionCostUsd >= o.budgetUsd) {
                log('probes: authoring budget reached — remaining findings stay not_exercised');
                break;
            }
            const authored = await authorProbe(o, target, harness, target.file === undefined ? undefined : findExemplarTest(o.index, target.file));
            if (authored.probe === undefined) {
                records.push(record(target, undefined, 'error', `authoring failed: ${authored.reason}`));
                continue;
            }
            const probe = authored.probe;
            const relProbe = target.file === undefined
                ? probe.filename
                : join(dirname(findExemplarTest(o.index, target.file) ?? ''), probe.filename).replace(/^\.\//, '');
            // Write on the host — the ro workspace mount exposes it to head, and
            // a copy into the base worktree makes the double-run symmetric.
            try {
                await writeFile(join(o.cwd, relProbe), probe.content, 'utf8');
                if (baseDir !== undefined) {
                    await mkdir(dirname(join(baseDir, relProbe)), { recursive: true });
                    await writeFile(join(baseDir, relProbe), probe.content, 'utf8');
                }
            }
            catch (e) {
                records.push(record(target, probe, 'error', `probe write failed: ${e.message}`));
                continue;
            }
            try {
                const head = await runProbeInSandbox({
                    workdir: o.cwd,
                    scratchDir,
                    cmd: harness.runCmd(relProbe),
                    image,
                    name: `head-${records.length}`,
                    exec,
                    ...sandboxLimits(sandbox),
                });
                // exitCode -1 is the "never ran" sentinel (path check / spawn
                // rejection) — infra error, not harness output to classify.
                const headOutcome = head.timedOut || head.exitCode === -1 ? 'error' : harness.classify(head);
                let baseOutcome;
                let baseOutput = '';
                if (baseDir !== undefined) {
                    const baseScratch = join(baseDir, SCRATCH_DIR_NAME);
                    await mkdir(baseScratch, { recursive: true });
                    const base = await runProbeInSandbox({
                        workdir: baseDir,
                        scratchDir: baseScratch,
                        cmd: harness.runCmd(relProbe),
                        image,
                        name: `base-${records.length}`,
                        exec,
                        ...sandboxLimits(sandbox),
                    });
                    baseOutcome = base.timedOut || base.exitCode === -1 ? 'error' : harness.classify(base);
                    baseOutput = probeOutput(base.stdout, base.stderr) ?? '';
                }
                const output = probeOutput(head.stdout, head.stderr) ??
                    (baseOutput === '' ? undefined : baseOutput);
                if (headOutcome === 'failed-test' && baseOutcome === 'clean') {
                    target.evidence = {
                        status: 'reproduced',
                        detail: `reproduced by Argus probe ${probe.filename} (fails on head, clean on base)`,
                    };
                    records.push(record(target, probe, 'reproduced', 'probe fails on head and passes on base', {
                        headOutcome,
                        baseOutcome,
                        durationMs: head.durationMs,
                        costUsd: authored.costUsd,
                        output,
                    }));
                }
                else {
                    const outcome = headOutcome === 'failed-test'
                        ? baseOutcome === undefined
                            ? 'error'
                            : 'load-error' // failed on head but base did not stay clean — probe bug or pre-existing
                        : headOutcome;
                    const detail = headOutcome === 'failed-test'
                        ? baseOutcome === undefined
                            ? 'fails on head but base checkout unavailable — unverified'
                            : 'fails on both head and base — probe bug or pre-existing defect'
                        : `head outcome: ${headOutcome}`;
                    records.push(record(target, probe, outcome, detail, {
                        headOutcome,
                        baseOutcome,
                        durationMs: head.durationMs,
                        costUsd: authored.costUsd,
                        output,
                    }));
                }
            }
            finally {
                await rm(join(o.cwd, relProbe), { force: true }).catch(() => undefined);
                if (baseDir !== undefined) {
                    await rm(join(baseDir, relProbe), { force: true }).catch(() => undefined);
                }
            }
        }
    }
    finally {
        if (baseDir !== undefined)
            await removeBaseWorktree(exec, o.cwd, wtDir);
    }
    return records;
}
