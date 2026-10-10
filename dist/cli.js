#!/usr/bin/env node
import { cmdCache } from './cli/cache.js';
import { cmdCodeReview } from './cli/code-review.js';
import { cmdDelegate } from './cli/delegate.js';
import { cmdIndex } from './cli/index.js';
import { cmdInit } from './cli/init.js';
import { cmdMention } from './cli/mention.js';
import { cmdRecord } from './cli/record.js';
import { cmdRun } from './cli/run.js';
import { cmdScan } from './cli/scan.js';
import { GLOBAL_FLAGS, shellQuote, reportError, renderUsage, usageError } from './cli/shared.js';
import { cmdVerify } from './cli/verify.js';
import { createStyler, colorEnabled } from './ui/style.js';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export async function main(argv, deps = {}) {
    // Global flags are accepted anywhere before a `--` terminator.
    const terminator = argv.indexOf('--');
    const head = terminator === -1 ? argv : argv.slice(0, terminator);
    const tail = terminator === -1 ? [] : argv.slice(terminator);
    const flags = new Set(head.filter((a) => GLOBAL_FLAGS.has(a)));
    const args = [...head.filter((a) => !GLOBAL_FLAGS.has(a)), ...tail];
    const baseEnv = deps.env ?? process.env;
    const debugOn = flags.has('--debug') || baseEnv.ARGUS_DEBUG === '1' || baseEnv.ARGUS_DEBUG === 'true';
    const isTTY = deps.isTTY ?? (deps.out === undefined && process.stdout.isTTY === true);
    const ctx = {
        cwd: deps.cwd ?? process.cwd(),
        // --debug raises the log level the same way ARGUS_DEBUG=1 does.
        env: flags.has('--debug') ? { ...baseEnv, ARGUS_DEBUG: '1' } : baseEnv,
        out: deps.out ?? ((line) => console.log(line)),
        err: deps.err ?? ((line) => console.error(line)),
        style: createStyler(colorEnabled({ env: baseEnv, isTTY, noColorFlag: flags.has('--no-color') })),
        width: deps.columns ?? (deps.out === undefined ? (process.stdout.columns ?? 80) : 80),
        json: flags.has('--json'),
        debug: debugOn,
        isTTY,
        rerun: ['argus-reviewer', ...args].map(shellQuote).join(' '),
    };
    try {
        return await dispatch(args, ctx, deps);
    }
    catch (e) {
        // Exit code stays 1 for anything thrown, as before U11 (the bin wrapper
        // used to map a rejected main() to 1). Only the rendering changed.
        reportError(ctx, e, undefined, 'INTERNAL');
        return 1;
    }
}
async function dispatch(argv, ctx, deps) {
    const [cmd, ...rest] = argv;
    if (cmd === undefined || cmd === '--help' || cmd === '-h' || cmd === 'help') {
        ctx.out(renderUsage(ctx.style));
        return 0;
    }
    switch (cmd) {
        case 'record':
            return cmdRecord(rest, ctx, deps);
        case 'run':
            return cmdRun(rest, ctx, deps);
        case 'verify':
            return cmdVerify(rest, ctx, deps);
        case 'code-review':
            return cmdCodeReview(rest, ctx, deps);
        case 'mention':
            return cmdMention(rest, ctx, deps);
        case 'delegate':
            return cmdDelegate(rest, ctx, deps);
        case 'cache':
            return cmdCache(rest, ctx);
        case 'index':
            return cmdIndex(rest, ctx);
        case 'scan':
            return cmdScan(rest, ctx, deps);
        case 'init':
            return cmdInit(rest, ctx, deps);
        default:
            usageError(ctx, undefined, `unknown command: ${cmd}`);
            return 2;
    }
}
const invokedAsScript = (() => {
    try {
        return (process.argv[1] !== undefined &&
            realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]));
    }
    catch {
        return false;
    }
})();
if (invokedAsScript) {
    main(process.argv.slice(2))
        .then((code) => {
        process.exitCode = code;
    })
        .catch((e) => {
        console.error(`argus-reviewer: ${e.message}`);
        process.exitCode = 1;
    });
}
export { filesFromUnifiedDiff, loadFixture, loadLocalDiff, buildPatchChunks, buildCodeReviewMessages, parseCodeReview, carryForwardSuggestions, diffLineRanges, diffLineTexts, filterRevertNits, filterToDiffLines, P_TRUE_POSITIVE_THRESHOLD, computeReviewEvent, isEffectiveBlocker, renderReviewComments } from './cli/review-shared.js';
