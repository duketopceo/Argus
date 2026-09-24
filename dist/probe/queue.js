import { chmod, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, posix, relative } from 'node:path';
import { DEFAULT_SANDBOX } from '../config.js';
import { defaultExec } from '../detect.js';
import { mayProbePr } from '../evidence/gate.js';
import { isTestFile } from '../evidence/link.js';
import { buildProbeMessages, parseProbe, probeImportsSafe, PROBE_SCHEMA, } from './author.js';
import { detectHarness } from './harness.js';
import { checkSandboxPaths, dockerAvailable, resolveSandboxImage, runProbeInSandbox, SANDBOX_OUTPUT_CAP, SCRATCH_DIR_NAME, stripControlChars, sandboxLimits, } from '../executor/sandbox.js';
/** U9 — below this confidence the triage area signal is ignored. */
const MIN_AREA_CONFIDENCE = 0.5;
/**
 * U9 triage-informed ordering: a finding's file path "hits" the flagged
 * risk area when a path segment equals the area token or starts with
 * it at a camelCase/digit boundary — `src/auth/session.ts` and
 * `dataStore.ts` hit auth/data, while `author.ts` and `database.ts`
 * do not. Advisory only.
 */
function fileHitsArea(file, area) {
    const token = area.toLowerCase();
    return file.split(/[/._-]+/).some((segment) => {
        const lower = segment.toLowerCase();
        if (lower === token)
            return true;
        if (!lower.startsWith(token))
            return false;
        return /[A-Z0-9]/.test(segment.charAt(token.length));
    });
}
/** Pure selection: not_exercised findings at blocking severities, capped. */
export function selectProbeTargets(findings, severityGates, maxProbes, triageArea) {
    const eligible = findings.filter((f) => f.evidence.status === 'not_exercised' &&
        f.file !== undefined &&
        isSafeRepoPath(f.file) &&
        severityGates.includes(f.severity ?? ''));
    // U9 — a confident triage top_risk_area reorders candidates so probes
    // prefer the flagged subsystem. Stable sort keeps the original order
    // within each group; probe count/gates/verdict are unchanged.
    if (triageArea !== undefined && triageArea.confidence >= MIN_AREA_CONFIDENCE) {
        // Hit flags precomputed once — the comparator would re-derive them
        // O(n log n) times otherwise.
        const hit = new Map(eligible.map((f) => [f, fileHitsArea(f.file ?? '', triageArea.area)]));
        eligible.sort((a, b) => Number(hit.get(b)) - Number(hit.get(a)));
    }
    return eligible.slice(0, Math.max(0, maxProbes));
}
/**
 * Repo-relative path gate for anything model- or index-derived that is read
 * or written on the HOST: no absolute paths, no `..` escapes, no backslashes.
 * The write side is already basename-bound (PROBE_FILENAME_RE); this is the
 * read-side and exemplar-dir boundary — a prompt-injected `../../.env`
 * finding.file or a crafted index entry must never reach fs calls.
 */
export function isSafeRepoPath(p) {
    if (isAbsolute(p) || p.includes('\\'))
        return false;
    // posix normalize — on win32, normalize() turns `../x` into `..\x` and
    // the startsWith('../') check would miss it.
    const n = posix.normalize(p);
    return n !== '..' && !n.startsWith('../') && !posix.isAbsolute(n);
}
/**
 * Nearest existing test file to the finding's file — same directory first,
 * then same top-level segment, then any test file. The exemplar sets the
 * probe's write location so the consumer's own include/roots cover it.
 * Index paths are filtered through isSafeRepoPath — a committed/crafted
 * index could otherwise aim the host write outside the checkout.
 */
export function findExemplarTest(index, findingFile) {
    const tests = index?.entries.map((e) => e.path).filter((p) => isTestFile(p) && isSafeRepoPath(p)) ?? [];
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
 * `wtDir`. Stale registrations from killed runs are pruned first — a
 * leftover `probes-base` would otherwise fail `worktree add` and silently
 * degrade every later run to head-only. The auth header rides env config
 * (GIT_CONFIG_*) so the token never appears in the git argv/`ps`.
 * Returns the worktree path, or undefined when the base cannot be
 * materialized — probes then run head-only and can never mark `reproduced`.
 */
async function addBaseWorktree(exec, cwd, wtDir, baseSha, token) {
    await exec('git', ['-C', cwd, 'worktree', 'remove', '--force', wtDir], 30_000);
    await exec('git', ['-C', cwd, 'worktree', 'prune'], 15_000);
    const have = await exec('git', ['-C', cwd, 'cat-file', '-e', `${baseSha}^{commit}`], 15_000);
    if (have.code !== 0) {
        // Shallow PR checkouts lack the base — fetch it. Auth rides env config
        // like actions/checkout's extraheader, but env keeps the token out of
        // the process argv where co-tenant jobs could scrape it via /proc.
        const env = token === undefined
            ? undefined
            : {
                GIT_CONFIG_COUNT: '1',
                GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
                GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
            };
        const fetched = await exec('git', ['-C', cwd, 'fetch', '--depth', '1', 'origin', baseSha], 60_000, env);
        if (fetched.code !== 0)
            return undefined;
    }
    const added = await exec('git', ['-C', cwd, 'worktree', 'add', '--detach', wtDir, baseSha], 60_000);
    return added.code === 0 ? wtDir : undefined;
}
async function removeBaseWorktree(exec, cwd, wtDir) {
    const res = await exec('git', ['-C', cwd, 'worktree', 'remove', '--force', wtDir], 30_000).catch(() => ({ code: 1, stdout: '', stderr: 'exec failed' }));
    if (res.code !== 0) {
        // rm fallback AND prune — without prune the stale .git/worktrees entry
        // makes the next `worktree add` fail and every later run degrades to
        // head-only.
        await rm(wtDir, { recursive: true, force: true }).catch(() => undefined);
        await exec('git', ['-C', cwd, 'worktree', 'prune'], 15_000).catch(() => undefined);
    }
}
/** Read a repo file for the prompt — windowed around the finding's line, hard-capped. */
const FILE_WINDOW_LINES = 300;
const FILE_CAP_BYTES = 64 * 1024;
const EXEMPLAR_CAP_BYTES = 32 * 1024;
function windowContent(content, line) {
    if (content.length <= FILE_CAP_BYTES)
        return content;
    if (line === undefined)
        return `${content.slice(0, FILE_CAP_BYTES)}\n…[truncated]`;
    const lines = content.split('\n');
    const lo = Math.max(0, line - 1 - FILE_WINDOW_LINES);
    const hi = Math.min(lines.length, line - 1 + FILE_WINDOW_LINES);
    const windowed = lines.slice(lo, hi).join('\n');
    const capped = windowed.length > FILE_CAP_BYTES ? windowed.slice(0, FILE_CAP_BYTES) : windowed;
    return `${lo > 0 ? `…[${lo} earlier lines omitted]\n` : ''}${capped}${hi < lines.length ? `\n…[${lines.length - hi} later lines omitted]` : ''}`;
}
/** One bounded authoring call; returns the validated probe or undefined. */
async function authorProbe(o, target, harness, exemplarPath, indexPaths) {
    // target.file is model-emitted — require index membership so a
    // prompt-injected path can't make the host read (and exfil) arbitrary
    // files into the authoring prompt.
    const fileTrusted = target.file !== undefined && indexPaths?.has(target.file) === true;
    const [rawFile, rawExemplar] = await Promise.all([
        fileTrusted
            ? readFile(join(o.cwd, target.file), 'utf8').catch(() => undefined)
            : Promise.resolve(undefined),
        exemplarPath === undefined
            ? Promise.resolve(undefined)
            : readFile(join(o.cwd, exemplarPath), 'utf8').catch(() => undefined),
    ]);
    const fileContents = rawFile === undefined ? undefined : windowContent(rawFile, target.line);
    const exemplar = exemplarPath === undefined || rawExemplar === undefined
        ? undefined
        : {
            path: exemplarPath,
            content: rawExemplar.length > EXEMPLAR_CAP_BYTES
                ? `${rawExemplar.slice(0, EXEMPLAR_CAP_BYTES)}\n…[truncated]`
                : rawExemplar,
        };
    let response;
    try {
        response = await o.client.complete({
            model: o.model,
            messages: buildProbeMessages({
                file: target.file,
                line: target.line,
                severity: target.severity ?? 'bug',
                message: target.message ?? '',
            }, fileContents, exemplar, harness),
            schema: PROBE_SCHEMA,
            kind: 'code',
            ...(o.provider !== undefined ? { provider: o.provider } : {}),
        });
    }
    catch (e) {
        return {
            probe: undefined,
            reason: `authoring call failed: ${e.message}`,
            costUsd: 0,
            tokens: 0,
        };
    }
    o.ledger.recordCall(response.cost);
    o.calls?.push(response.cost);
    const parsed = parseProbe(response.content);
    if (!parsed.ok) {
        // Failed parses still cost the call — carry the spend on the record.
        return {
            probe: undefined,
            reason: parsed.reason,
            costUsd: response.cost.costUsd,
            tokens: response.cost.tokens,
        };
    }
    return { probe: parsed.probe, costUsd: response.cost.costUsd, tokens: response.cost.tokens };
}
function record(target, probe, outcome, detail, extra = {}) {
    return {
        file: probe?.filename ?? '(none)',
        findingFile: target.file,
        findingLine: target.line,
        outcome,
        durationMs: extra.durationMs ?? 0,
        costUsd: extra.costUsd ?? 0,
        tokens: extra.tokens ?? 0,
        detail,
        headOutcome: extra.headOutcome,
        baseOutcome: extra.baseOutcome,
        output: extra.output,
    };
}
/** `timedOut` or the never-ran `-1` sentinel → infra error; else the harness classifies. */
function outcomeOf(harness, r) {
    return r.timedOut || r.exitCode === -1 ? 'error' : harness.classify(r);
}
function probeOutput(stdout, stderr) {
    // Strip control chars + ANSI before capping — attacker-influenced probe
    // output lands in code-review.json and the sticky comment verbatim.
    const combined = stripControlChars(`${stdout}\n${stderr}`)
        // eslint-disable-next-line no-control-regex
        .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
        .trim();
    return combined === '' ? undefined : combined.slice(0, SANDBOX_OUTPUT_CAP);
}
/**
 * Run the probe lane. Mutates `findings` evidence in place for reproduced
 * results and returns the per-probe audit records for code-review.json.
 * Returns undefined only when the lane is disabled entirely; otherwise a
 * result carrying records and (when it bowed out early) a skipReason the
 * report surface can render.
 */
export async function runProbeLane(findings, o) {
    const log = o.log ?? (() => undefined);
    if (!o.sandbox.enabled)
        return undefined;
    const skip = (reason) => {
        log(`probes: skipped — ${reason}`);
        return { records: [], skipReason: reason };
    };
    // For fork PRs the config file ships in the PR's own tree — attacker-set
    // image/limits/allowForks would self-approve the gate. Forks always run
    // on DEFAULT_SANDBOX and approve only via trusted author or the label.
    const sandbox = o.meta?.isFork ? { ...DEFAULT_SANDBOX, enabled: true } : o.sandbox;
    const targets = selectProbeTargets(findings, o.severityGates, sandbox.maxProbes, o.triageArea);
    if (targets.length === 0)
        return { records: [] };
    if (!mayProbePr(o.meta, sandbox)) {
        return skip('fork gate (needs argus-probe label on this head or allowForks)');
    }
    // Cheap check first: repos without a supported harness skip before docker
    // ever runs (a possible image pull would be wasted work).
    const harness = await detectHarness(o.cwd);
    if (harness === undefined) {
        return skip('no supported test harness (vitest/jest/node --test)');
    }
    const image = resolveSandboxImage(sandbox.image);
    const exec = o.exec ?? defaultExec;
    if (!(await dockerAvailable(exec, image, o.cwd))) {
        return skip('docker unavailable or cannot see the workspace');
    }
    // Validate reportDir's ancestry BEFORE mkdir — a symlinked reportDir must
    // not create dirs at an arbitrary host path.
    const dirCheck = await checkSandboxPaths(o.cwd, o.reportDir);
    if (!dirCheck.ok)
        return skip(`report dir unsafe — ${dirCheck.reason}`);
    const scratchDir = join(o.reportDir, SCRATCH_DIR_NAME);
    // The single writable mount must actually be writable by nobody (65534).
    // mkdir can reject (EACCES on reportDir, ENOTDIR on a file) — degrade to
    // a skip, not a lane crash.
    try {
        await mkdir(scratchDir, { recursive: true, mode: 0o777 });
        await chmod(scratchDir, 0o777);
    }
    catch (e) {
        return skip(`scratch dir unusable — ${e.message}`);
    }
    const scratchCheck = await checkSandboxPaths(o.cwd, scratchDir);
    if (!scratchCheck.ok)
        return skip(scratchCheck.reason);
    const indexPaths = o.index === undefined ? undefined : new Set(o.index.entries.map((e) => e.path));
    // The double-run needs a merge-base checkout. Started eagerly so the
    // fetch overlaps the first authoring call; failures don't block the lane —
    // head results still record, but without base nothing can upgrade to
    // `reproduced`.
    const wtDir = join(o.reportDir, 'probes-base');
    const basePromise = (o.meta?.baseSha === undefined
        ? Promise.resolve(undefined)
        : addBaseWorktree(exec, o.cwd, wtDir, o.meta.baseSha, o.token)).catch(() => undefined);
    const records = [];
    let baseDir;
    try {
        for (let i = 0; i < targets.length; i++) {
            const target = targets[i];
            // Authoring stops at the budget edge but must NOT flag the ledger —
            // `budgetExceeded` flips the review verdict, and KTD8 pins the lane
            // to never change verdict. The spend still records on the ledger.
            if (o.budgetUsd !== undefined && o.ledger.visionCostUsd >= o.budgetUsd) {
                log('probes: authoring budget reached — remaining findings stay not_exercised');
                break;
            }
            const exemplarPath = target.file === undefined ? undefined : findExemplarTest(o.index, target.file);
            const authored = await authorProbe(o, target, harness, exemplarPath, indexPaths);
            if (authored.probe === undefined) {
                records.push(record(target, undefined, 'error', `authoring failed: ${authored.reason}`, {
                    costUsd: authored.costUsd,
                    tokens: authored.tokens,
                }));
                continue;
            }
            // The host write uses a forced argus-probe- prefix + exclusive create —
            // a model-chosen name can never overwrite (then delete) a real test.
            const probe = authored.probe;
            const safeFilename = `argus-probe-${probe.filename}`;
            const relProbe = exemplarPath === undefined ? safeFilename : join(dirname(exemplarPath), safeFilename);
            if (!isSafeRepoPath(relProbe)) {
                records.push(record(target, probe, 'error', `unsafe probe path: ${relProbe}`));
                continue;
            }
            // `..` imports are legit (tests/ → ../src/x) but must resolve inside
            // the checkout from the probe's write location.
            if (!probeImportsSafe(probe, relProbe)) {
                records.push(record(target, probe, 'error', 'relative import escapes repo'));
                continue;
            }
            // Write on the host — the ro workspace mount exposes it to head, and
            // a copy into the base worktree makes the double-run symmetric.
            baseDir ??= await basePromise;
            let wroteHead = false;
            try {
                await writeFile(join(o.cwd, relProbe), probe.content, { encoding: 'utf8', flag: 'wx' });
                wroteHead = true;
                if (baseDir !== undefined) {
                    await mkdir(dirname(join(baseDir, relProbe)), { recursive: true });
                    await writeFile(join(baseDir, relProbe), probe.content, 'utf8');
                }
            }
            catch (e) {
                // Only remove what WE created — on EEXIST the path holds a real
                // consumer file and rm would delete it.
                if (wroteHead)
                    await rm(join(o.cwd, relProbe), { force: true }).catch(() => undefined);
                records.push(record(target, probe, 'error', `probe write failed: ${e.message}`));
                continue;
            }
            try {
                // Head and base runs are independent — distinct workdirs, scratch
                // dirs, and container names — so they run concurrently. The base
                // worktree has no node_modules (worktrees carry tracked files
                // only), so head's deps are bind-mounted ro — without it every
                // vitest/jest base run load-errors and `reproduced` can never fire.
                const nodeModules = join(o.cwd, 'node_modules');
                const hasNodeModules = (await stat(nodeModules).catch(() => undefined))?.isDirectory() === true;
                const baseScratch = baseDir === undefined ? undefined : join(baseDir, SCRATCH_DIR_NAME);
                if (baseScratch !== undefined) {
                    await mkdir(baseScratch, { recursive: true, mode: 0o777 });
                    await chmod(baseScratch, 0o777).catch(() => undefined);
                }
                // probes-base sits inside the head run's ro mount — mask it so a
                // head probe can't detect/read the base tree and condition on it.
                // Both sides realpath'd — a symlinked checkout must not silently
                // drop the mask.
                const realWt = baseDir === undefined ? undefined : await realpath(baseDir).catch(() => undefined);
                const wtMask = realWt === undefined ? undefined : relative(scratchCheck.realWork, realWt);
                const [head, base] = await Promise.all([
                    runProbeInSandbox({
                        workdir: o.cwd,
                        scratchDir,
                        cmd: harness.runCmd(relProbe),
                        image,
                        name: `head-${i}`,
                        exec,
                        masks: wtMask !== undefined && isSafeRepoPath(wtMask) ? [wtMask] : [],
                        ...sandboxLimits(sandbox),
                    }),
                    baseDir === undefined || baseScratch === undefined
                        ? Promise.resolve(undefined)
                        : runProbeInSandbox({
                            workdir: baseDir,
                            scratchDir: baseScratch,
                            cmd: harness.runCmd(relProbe),
                            image,
                            name: `base-${i}`,
                            exec,
                            roMounts: hasNodeModules
                                ? [{ host: nodeModules, container: '/work/node_modules' }]
                                : [],
                            ...sandboxLimits(sandbox),
                        }),
                ]);
                const headOutcome = outcomeOf(harness, head);
                const baseOutcome = base === undefined ? undefined : outcomeOf(harness, base);
                const output = probeOutput(head.stdout, head.stderr) ??
                    (base === undefined ? undefined : probeOutput(base.stdout, base.stderr));
                const extra = {
                    headOutcome,
                    baseOutcome,
                    durationMs: head.durationMs,
                    costUsd: authored.costUsd,
                    tokens: authored.tokens,
                    output,
                };
                let outcome;
                let detail;
                if (headOutcome === 'failed-test' && baseOutcome === 'clean') {
                    outcome = 'reproduced';
                    detail = `reproduced by Argus probe ${probe.filename} (fails on head, clean on base)`;
                    target.evidence = { ...target.evidence, status: 'reproduced', detail };
                }
                else if (headOutcome !== 'failed-test') {
                    outcome = headOutcome;
                    detail = `head outcome: ${headOutcome}`;
                }
                else if (baseOutcome === undefined) {
                    outcome = 'error';
                    detail = 'fails on head but base checkout unavailable — unverified';
                }
                else if (baseOutcome === 'failed-test') {
                    outcome = 'load-error';
                    detail = 'fails on both head and base — probe bug or pre-existing defect';
                }
                else {
                    // Base run produced no test verdict (infra error / load-error /
                    // not-collected) — report it accurately, never claim "fails on both".
                    outcome = 'error';
                    detail = `fails on head but base run inconclusive (${baseOutcome}) — unverified`;
                }
                records.push(record(target, probe, outcome, detail, extra));
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
        // The worktree may exist even when the loop never assigned baseDir
        // (e.g. every probe failed authoring) — resolve the promise here so the
        // teardown still runs.
        const bd = baseDir ?? (await basePromise);
        if (bd !== undefined)
            await removeBaseWorktree(exec, o.cwd, wtDir);
    }
    return { records };
}
