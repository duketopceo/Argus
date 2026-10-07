import { loadFlow } from '../cache/store.js';
import { CACHE_USAGE, resolveCheckoutTrust, loadCliConfig, usageError } from './shared.js';
import { readdir, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
export async function cmdCache(args, ctx) {
    const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: {
            help: { type: 'boolean', short: 'h', default: false },
            dir: { type: 'string' },
            all: { type: 'boolean', default: false },
        },
    });
    const [sub, ...restPositionals] = positionals;
    if (values.help || sub === undefined || (sub !== 'list' && sub !== 'prune')) {
        ctx.out(CACHE_USAGE);
        return sub === undefined || values.help ? 0 : 2;
    }
    const { trust } = await resolveCheckoutTrust(ctx);
    const config = await loadCliConfig(ctx, trust);
    const cacheDir = resolve(ctx.cwd, values.dir ?? config.cacheDir ?? join(ctx.cwd, '.argus-reviewer-cache'));
    if (sub === 'list') {
        let names = [];
        try {
            names = (await readdir(cacheDir)).filter((f) => f.endsWith('.json')).sort();
        }
        catch {
            // missing cache dir reads as empty
        }
        if (names.length === 0) {
            ctx.out(`cache empty (${cacheDir})`);
            return 0;
        }
        for (const name of names) {
            const flowName = name.replace(/\.json$/, '');
            const flow = await loadFlow(cacheDir, flowName);
            ctx.out(`${flowName}: ${flow?.steps.length ?? 0} steps`);
        }
        return 0;
    }
    // prune
    if (!values.all && restPositionals.length === 0) {
        usageError(ctx, 'cache', 'cache prune requires a flow name or --all', 'argus-reviewer cache prune --all');
        return 2;
    }
    let names = [];
    try {
        names = (await readdir(cacheDir)).filter((f) => f.endsWith('.json'));
    }
    catch {
        // missing cache dir reads as empty
    }
    const targets = values.all ? names : restPositionals.map((n) => `${n}.json`);
    let removed = 0;
    for (const name of targets) {
        try {
            await rm(join(cacheDir, name));
            removed++;
        }
        catch {
            ctx.err(`warning: could not remove ${name}`);
        }
    }
    ctx.out(`pruned ${removed} cached flow(s) from ${cacheDir}`);
    return 0;
}
