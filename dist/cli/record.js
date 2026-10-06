import { renderTestFile, td, test as registerTest } from '../api.js';
import { loadFlow, flowPath, serializeFlow } from '../cache/store.js';
import { Actions } from '../engine/actions.js';
import { Engine } from '../engine/loop.js';
import { isSafeFlowName } from '../flow/writeback.js';
import { writeAtomicText } from '../fsutil.js';
import { Ledger } from '../vision/ledger.js';
import { RECORD_USAGE, usageError, resolveCheckoutTrust, loadCliConfig, warnUnknownProviders, slugify, startTarget, launchDriver, createClient, reportError, TEST_FILE_RE } from './shared.js';
import { mkdtemp, mkdir, writeFile, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, extname, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
export async function cmdRecord(args, ctx, deps) {
    const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: {
            help: { type: 'boolean', short: 'h', default: false },
            url: { type: 'string' },
            name: { type: 'string' },
            'tests-dir': { type: 'string' },
            'max-steps': { type: 'string' },
        },
    });
    if (values.help) {
        ctx.out(RECORD_USAGE);
        return 0;
    }
    const description = positionals.join(' ').trim();
    if (description === '') {
        usageError(ctx, 'record', 'record requires a flow description', 'argus-reviewer record "<flow>" --url <target>');
        return 2;
    }
    const { trust } = await resolveCheckoutTrust(ctx);
    const config = await loadCliConfig(ctx, trust);
    warnUnknownProviders(config, ctx);
    const url = values.url ?? config.target?.url;
    if (url === undefined) {
        usageError(ctx, 'record', 'no target URL: pass --url or set config.target.url', `${ctx.rerun} --url http://localhost:3000`);
        return 2;
    }
    const flowName = values.name ?? slugify(description);
    if (!isSafeFlowName(flowName)) {
        usageError(ctx, 'record', `flow name "${flowName}" is not a safe recording name; use lowercase letters, digits, '-', '_'`, `${ctx.rerun} --name my-flow`);
        return 2;
    }
    const maxSteps = values['max-steps'] !== undefined ? Number(values['max-steps']) : undefined;
    if (maxSteps !== undefined && (!Number.isInteger(maxSteps) || maxSteps < 1)) {
        usageError(ctx, 'record', `--max-steps must be a positive integer, got "${values['max-steps']}"`);
        return 2;
    }
    let target;
    let driver;
    let setupTmp;
    try {
        target = await startTarget(config);
        driver = await launchDriver(config, deps);
        setupTmp = await mkdtemp(join(tmpdir(), 'argus-setup-'));
        await applyPageSetup(config, driver, ctx, setupTmp);
        const client = createClient(deps, config, ctx);
        const ledger = new Ledger(config.budgetUsd);
        const actions = new Actions(driver);
        const engine = new Engine({ driver, actions, client, ledger, config });
        ledger.startSandbox();
        await driver.goto(url);
        const result = await engine.record(description, actions, {
            flowName,
            ...(maxSteps !== undefined ? { stepCap: maxSteps } : {}),
        });
        ledger.stopSandbox();
        const state = ledger.state;
        ctx.out(`record ${result.ok ? 'succeeded' : 'FAILED'}: ${result.steps.length} steps, ` +
            `${result.visionCalls} vision calls, $${state.visionCostUsd.toFixed(6)} vision spend`);
        if (result.reason !== undefined)
            ctx.err(`reason: ${result.reason}`);
        if (state.budgetExceeded)
            ctx.err('budget cap was hit during record');
        if (result.ok) {
            const testsDir = resolve(ctx.cwd, values['tests-dir'] ?? config.testsDir ?? 'tests');
            await mkdir(testsDir, { recursive: true });
            const cacheDir = config.cacheDir ?? join(ctx.cwd, '.argus-reviewer-cache');
            const flow = await loadFlow(cacheDir, flowName);
            const testFile = join(testsDir, `${flowName}.test.ts`);
            await writeFile(testFile, renderTestFile(flowName, flow?.steps ?? []), 'utf8');
            ctx.out(`wrote test file: ${testFile}`);
            if (config.cacheDir !== undefined)
                ctx.out(`wrote cache: ${flowPath(cacheDir, flowName)}`);
            // The committed recording — canonical flow state that survives CI
            // checkouts (the cache dir is local/gitignored). Commit alongside the
            // test file; heal write-back updates it via PR.
            const flowFile = join(testsDir, 'flows', `${flowName}.json`);
            await writeAtomicText(flowFile, serializeFlow(flow?.steps ?? [], flow?.asserts));
            ctx.out(`wrote flow recording: ${flowFile}; commit it with the test file`);
        }
        return result.ok ? 0 : 1;
    }
    catch (e) {
        reportError(ctx, e, 'record', 'COMMAND_FAILED');
        return 1;
    }
    finally {
        await driver?.close();
        await target?.stop();
        if (setupTmp !== undefined)
            await rm(setupTmp, { recursive: true, force: true }).catch(() => { });
    }
}
export async function discoverTestFiles(dir) {
    const found = [];
    let entries;
    try {
        entries = await readdir(dir, { withFileTypes: true });
    }
    catch {
        return found;
    }
    for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
            found.push(...(await discoverTestFiles(path)));
        }
        else if (entry.isFile() && TEST_FILE_RE.test(entry.name)) {
            found.push(path);
        }
    }
    return found.sort();
}
export async function importModule(file, tmpDir) {
    let target = file;
    if (extname(file) === '.ts' || extname(file) === '.mts') {
        let transpile;
        try {
            const ts = await import('typescript');
            transpile = (source) => ts.transpileModule(source, {
                compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
            }).outputText;
        }
        catch {
            throw new Error(`cannot execute TypeScript module ${file}: the "typescript" package is not ` +
                'available. Install it or ship precompiled .mjs modules.');
        }
        const source = await readFile(file, 'utf8');
        await mkdir(tmpDir, { recursive: true });
        target = join(tmpDir, `${basename(file)}.${process.pid}.mjs`);
        await writeFile(target, transpile(source), 'utf8');
    }
    return (await import(`${pathToFileURL(target).href}?t=${Date.now()}`));
}
export async function importTestFile(file, tmpDir) {
    await importModule(file, tmpDir);
}
/**
 * Optional `config.pageSetup` module: default-exported function invoked with
 * the Playwright Page after launch, before navigation — the seam for
 * page.route mocks and pre-navigation seeding.
 */
export async function applyPageSetup(config, driver, ctx, tmpDir) {
    if (config.pageSetup === undefined || config.pageSetup === '')
        return;
    const file = resolve(ctx.cwd, config.pageSetup);
    const mod = await importModule(file, tmpDir);
    const setup = mod.default;
    if (typeof setup !== 'function') {
        throw new Error(`pageSetup module ${file} must default-export a function`);
    }
    await setup(driver.rawPage);
}
export function patchGlobals() {
    const g = globalThis;
    const patches = [
        { key: 'td', previous: g.td },
        { key: 'test', previous: g.test },
    ];
    g.td = td;
    g.test = registerTest;
    return patches;
}
export function restoreGlobals(patches) {
    const g = globalThis;
    for (const { key, previous } of patches) {
        if (previous === undefined) {
            // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
            delete g[key];
        }
        else {
            g[key] = previous;
        }
    }
}
