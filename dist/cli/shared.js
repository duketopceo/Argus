import { loadConfig, DEFAULT_RECORD_STEP_CAP, unknownProviderSlugs } from '../config.js';
import { BrowserDriver, inspectInstructions } from '../driver/browser.js';
import { TargetProcess, holdTargetForDebug, waitForReady } from '../driver/target.js';
import { fetchPrMeta } from '../evidence/ci.js';
import { resolveTrust } from '../trust.js';
import { toCliError, errorJson, renderError, CliError } from '../ui/errors.js';
import { OpenRouterClient } from '../vision/openrouter.js';
import { basename } from 'node:path';
/** Flags accepted before or after any command; stripped before dispatch. */
export const GLOBAL_FLAGS = new Set(['--json', '--no-color', '--debug']);
export function shellQuote(arg) {
    return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
}
/**
 * Print a classified error (R14): three styled lines, or one JSON object
 * on stdout under `--json`, so a pipe captures it. The caller still returns
 * its own exit code.
 */
export function reportError(ctx, e, context, fallback) {
    const err = toCliError(e, fallback);
    const opts = { context, rerun: ctx.rerun, debug: ctx.debug, width: ctx.width };
    if (ctx.json)
        ctx.out(errorJson(err, opts));
    else
        for (const line of renderError(err, ctx.style, opts))
            ctx.err(line);
}
/** A usage error (exit 2 at the call site): the message is the summary, a help command the fix. */
export function usageError(ctx, context, message, fix) {
    reportError(ctx, new CliError('USAGE', message, fix !== undefined ? { fix } : {}), context, 'USAGE');
}
/** loadConfig, with any failure classified as CONFIG_INVALID (R14). */
export async function loadCliConfig(ctx, trust) {
    try {
        return await loadConfig(ctx.cwd, { trust, note: ctx.err });
    }
    catch (e) {
        throw new CliError('CONFIG_INVALID', e.message, { cause: e });
    }
}
/**
 * Top-level help, grouped by job (R16) with the default command first.
 * Each entry is a signature line and an indented description; every line
 * fits 80 columns.
 */
export const HELP_GROUPS = [
    {
        title: 'Review',
        commands: [
            [
                ['verify [--flow] [--app] [--a0] [--report-dir <dir>]'],
                'Run the selected lanes. Code review is the default lane.',
            ],
            [['code-review [--report-dir <dir>]'], 'Review the PR diff with the configured code model.'],
            [['mention [--report-dir <dir>]'], 'Answer an @argus PR comment (issue_comment events).'],
        ],
    },
    {
        title: 'Test',
        commands: [
            [
                [
                    'record "<flow description>" --url <target>',
                    '  [--name <flow>] [--tests-dir <dir>] [--max-steps <n>]',
                ],
                'Record a flow and write a replayable test file.',
            ],
            [
                ['run [pattern] [--url <target>] [--dir <testsDir>]', '  [--report-dir <dir>]'],
                'Replay test files against the target; writes JUnit and run.json.',
            ],
        ],
    },
    {
        title: 'Operate',
        commands: [
            [['cache list [--dir <cacheDir>]'], 'List cached flows.'],
            [['cache prune [name|--all] [--dir <cacheDir>]'], 'Delete one flow cache, or all of them.'],
            [['index [--dir <repo>]'], 'Scan the repo into argus.index.json.'],
            [
                ['scan [path] [--model] [--base <ref>]', '  [--report-dir <dir>]'],
                'Audit a tree: deterministic rules + secrets; --model adds model findings.',
            ],
            [
                ['delegate "<task>" [--url <target>] [--host <a0-url>]'],
                'Send a task to an Agent Zero instance.',
            ],
        ],
    },
    {
        title: 'Setup',
        commands: [
            [['init [--force | --pr]'], 'Scaffold config, a smoke test and the PR workflow.'],
            [['--help'], 'Show this help.'],
        ],
    },
];
export function renderUsage(style) {
    const lines = [
        `${style.bold('argus-reviewer')}: vision-model code review and E2E testing`,
        '(BYOK via OPENROUTER_API_KEY)',
        '',
        'Usage: argus-reviewer <command> [options]',
    ];
    for (const group of HELP_GROUPS) {
        lines.push('', style.bold(group.title));
        for (const [signature, description] of group.commands) {
            signature.forEach((part, i) => lines.push(i === 0 ? `  argus-reviewer ${part}` : `  ${part}`));
            lines.push(`      ${style.dim(description)}`);
        }
    }
    lines.push('', style.bold('Global options'), '  --json       Print errors as one JSON object with a stable code.', '  --no-color   Plain output (also NO_COLOR=1; FORCE_COLOR=1 forces color).', '  --debug      Debug logs and stack traces.', '', 'Config: argus-reviewer.config.ts or argus-reviewer.config.json in the working', 'directory (legacy vision-e2e.config.* is still accepted): model,', 'escalation_model, provider rules, budgetUsd, target, cacheDir, testsDir,', 'reportDir, secrets, logLevel, sourceGlobs, indexPath, diffBase.');
    return lines.join('\n');
}
export const RECORD_USAGE = `Usage: argus-reviewer record "<flow description>" --url <target> [options]

Options:
  --url <url>        Target URL (falls back to config.target.url)
  --name <name>      Flow name for the cache + generated test file
  --tests-dir <dir>  Where to write the generated test file (default: config testsDir or ./tests)
  --max-steps <n>    Step cap before giving up on 'done' (default: config recordStepCap or ${DEFAULT_RECORD_STEP_CAP})

  -h, --help         Show this help`;
export const RUN_USAGE = `Usage: argus-reviewer run [pattern] [options]


Discovers *.test.{ts,mts,mjs,js} under the tests dir, executes each against the
target, and writes JUnit XML + a JSON run report.

Options:
  [pattern]          Only run test files whose path contains this substring
  --url <url>        Target URL (falls back to config.target.url)
  --dir <dir>        Tests directory (default: config testsDir or ./tests)
  --report-dir <dir> Report output dir (default: config reportDir or ./argus-reviewer-report)
  --cache-dir <dir>  Fingerprint cache dir (default: config cacheDir)
  --keep-alive       On failure, hold an argus-booted target up for inspection
                     (interactive sessions only; skipped on CI/non-TTY)
  --keep-alive-ttl <sec>  Keep-alive window in seconds (default 300, max 3600)
  -h, --help         Show this help`;
export const CODE_REVIEW_USAGE = `Usage: argus-reviewer code-review [options]


Reviews the PR diff for the repo/PR referenced by ARGUS_REVIEWER_TRACE using the
configured code model. Writes code-review.json next to run.json.

Options:
  --report-dir <dir> Report output dir (default: config reportDir or ./argus-reviewer-report)
  --fixture <dir>    Review a local fixture repo (ref argus-fixture-base vs HEAD)
                     instead of a live PR, with no GitHub API calls. Used by npm run demo.
  --base <ref>       Review the local merge-base..worktree diff of <ref> -
                     no GitHub context needed (the agent "review my diff" path).
                     Without it, diffBase/ARGUS_DIFF_BASE supply the default base
                     only when no PR context exists. Posts nothing; read
                     code-review.json for the verdict.
  --mode <mode>      realtime (default) | batch. batch submits the chunks through
                     OpenRouter's async Batch API and falls back to realtime on
                     failure or timeout. Overrides ARGUS_REVIEW_MODE and review.mode.
  --batch-model <slug>  Model for batch mode (a :batch slug; default
                     deepseek/deepseek-v4.1-flash:batch). Overrides
                     ARGUS_BATCH_MODEL and review.batchModel.
  --generate-tests   Author spec leafs from the diff (review.generateTests bounds),
                     sandbox-validate when the head checkout is real, and deposit
                     them on a reviewable PR under testsDir. Fork PRs refuse.
  --full             Re-review the whole PR diff, bypassing the incremental
                     baseline in the sticky comment (U4). Same effect as
                     ARGUS_REVIEW_FULL=1 or '@argus review full'.
  Env: ARGUS_REQUEST_TIMEOUT_MS sets the per-request timeout (default 120000,
                     max 900000; also review.requestTimeoutMs).
  -h, --help         Show this help`;
export const CACHE_USAGE = `Usage: argus-reviewer cache <list|prune> [options]


  cache list                 List cached flows (name + step count)
  cache prune [name|--all]   Delete one flow cache, or all with --all

Options:
  --dir <dir>   Cache directory (default: config cacheDir or ./.argus-reviewer-cache)
  -h, --help    Show this help`;
export const TEST_FILE_RE = /\.test\.(ts|mts|mjs|js)$/;
/** Total wall-clock budget for all heal:'a0' delegations in one run. */
export const A0_HEAL_BUDGET_MS = 15 * 60_000;
/** Default delegation-count ceiling for heal:'a0' — a0.maxTasks overrides. */
export const A0_HEAL_MAX_DELEGATIONS = 5;
/** Default --keep-alive window: long enough to attach, short enough to never strand a target. */
export const KEEP_ALIVE_DEFAULT_TTL_MS = 5 * 60_000;
export const KEEP_ALIVE_MAX_TTL_MS = 60 * 60_000;
export function parseKeepAliveTtl(raw) {
    if (raw === undefined)
        return undefined;
    const seconds = Number(raw);
    if (!Number.isInteger(seconds) || seconds < 1)
        return undefined;
    return Math.min(seconds * 1000, KEEP_ALIVE_MAX_TTL_MS);
}
/**
 * A run is interactive only on a real TTY outside CI. `CI` is the
 * conventional marker; `GITHUB_ACTIONS` covers a workflow that overrode CI.
 */
export function keepAliveInteractive(ctx) {
    return (ctx.isTTY === true &&
        envOr(ctx.env.CI) === undefined &&
        envOr(ctx.env.GITHUB_ACTIONS) === undefined);
}
/**
 * U3 keep-alive: after a failed run, hold an argus-booted target up briefly
 * so a human can inspect the live app. Interactive sessions only: on CI or
 * under a headless agent there is nobody to attach, and the journal/report
 * is the debugging surface there (documented asymmetry, not a defect). Never
 * throws: a debug affordance must not break teardown.
 */
export async function maybeKeepAliveHold(ctx, deps, target, url, ttlMs) {
    try {
        if (!keepAliveInteractive(ctx)) {
            ctx.out('keep-alive: skipped (non-interactive or CI run)');
            return;
        }
        if (target === undefined) {
            // The app is served externally; nothing argus owns would die on
            // teardown, so the inspect hint alone is the hold.
            ctx.out('keep-alive: target was not booted by argus; it stays up on its own');
            for (const line of inspectInstructions(url))
                ctx.out(`  ${line}`);
            return;
        }
        await holdTargetForDebug(url, ttlMs, (line) => ctx.out(line), {
            ...(deps.sleep !== undefined ? { sleep: deps.sleep } : {}),
        });
    }
    catch (e) {
        ctx.err(`keep-alive hold failed: ${e.message}`);
    }
}
/**
 * Checkout trust for config loading — resolved before `loadConfig` at every
 * call site so a hostile tree never executes config code (#58). `fetchMeta`
 * is only invoked on `issue_comment` or when a pull_request* payload is
 * unreadable; pull_request* events read fork status from the payload.
 */
export function resolveCheckoutTrust(ctx) {
    return resolveTrust({
        env: ctx.env,
        fetchMeta: (repo, pr, token) => fetchPrMeta(repo, pr, token, ctx),
        note: (line) => ctx.err(line),
    });
}
/**
 * Run-scoped nonce for evidence files. GITHUB_RUN_ID is not knowable when a
 * commit or a planted file is authored — that is the property that matters
 * (freshness, not secrecy: the id is public once the run exists). The sticky
 * poster and emit-review require evidence written by THIS run whenever the
 * env is present; local runs carry no nonce and are exempt.
 */
export function runNonceFrom(env) {
    return envOr(env.GITHUB_RUN_ID);
}
/** Env/flag blank strings normalize to undefined — action inputs default to '' and must not shadow config, and a whitespace-only value must never stand in as a marker. */
export function envOr(v) {
    return v !== undefined && v.trim() !== '' ? v.trim() : undefined;
}
export function parseOpenRouterTrace(env) {
    const raw = env.ARGUS_REVIEWER_TRACE;
    if (!raw)
        return undefined;
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            return undefined;
        return Object.fromEntries(Object.entries(parsed).filter(([_, v]) => typeof v === 'string'));
    }
    catch {
        return undefined;
    }
}
export function createClient(deps, config, ctx) {
    if (deps.createClient)
        return deps.createClient(config);
    // Lazy: a cache-hit replay makes zero vision calls and needs no key. The
    // error fires clearly on the first actual model call.
    let inner;
    const getInner = () => {
        if (inner === undefined) {
            const apiKey = ctx.env.OPENROUTER_API_KEY;
            if (apiKey === undefined || apiKey === '') {
                throw new CliError('OPENROUTER_KEY_MISSING', 'OPENROUTER_API_KEY is not set; model calls bill through this key (BYOK)');
            }
            const envTrace = parseOpenRouterTrace(ctx.env);
            const trace = { ...(envTrace ?? {}), ...(config.openrouter?.trace ?? {}) };
            const headers = { ...(config.openrouter?.headers ?? {}) };
            const traceOpt = Object.keys(trace).length > 0 ? trace : undefined;
            const headersOpt = Object.keys(headers).length > 0 ? headers : undefined;
            inner = new OpenRouterClient({
                apiKey,
                timeoutMs: config.review.requestTimeoutMs,
                ...(traceOpt ? { trace: traceOpt } : {}),
                ...(headersOpt ? { headers: headersOpt } : {}),
                onCall: (call) => {
                    ctx.out(`openrouter ${call.kind} ${call.model} ${call.tokens}tok $${call.costUsd.toFixed(6)}`);
                },
            });
        }
        return inner;
    };
    return {
        complete: async (opts) => getInner().complete(opts),
        completeBatch: async (opts) => getInner().completeBatch(opts),
    };
}
export async function launchDriver(config, deps) {
    if (deps.launchDriver)
        return deps.launchDriver(config);
    return BrowserDriver.launch({
        browser: config.browser,
        browserTimeoutMs: config.browserTimeoutMs,
        captureErrors: config.explore.enabled,
    });
}
export function warnUnknownProviders(config, ctx) {
    for (const slug of unknownProviderSlugs(config.provider)) {
        ctx.err(`warning: unknown provider slug "${slug}" in provider rules; passing it through anyway`);
    }
}
export async function startTarget(config) {
    const target = config.target;
    if (target === undefined)
        return undefined;
    if (!target.command) {
        // No boot command — the app is assumed already running (or a file://
        // target). Still wait for the URL so `run` fails fast on a dead target.
        await waitForReady(target.url, target.readyTimeoutMs);
        return undefined;
    }
    return TargetProcess.start(target);
}
export function slugify(text) {
    const slug = text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60);
    return slug === '' ? 'flow' : slug;
}
/** Repo identity for journal records; all probes degrade to 'unknown'. */
export async function gitInfo(cwd) {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const exec = promisify(execFile);
    const run = (args) => exec('git', args, { cwd, timeout: 10_000, maxBuffer: 1024 * 1024 })
        .then((r) => r.stdout.trim())
        .catch(() => '');
    const [remote, sha, branch] = await Promise.all([
        run(['remote', 'get-url', 'origin']),
        run(['rev-parse', 'HEAD']),
        run(['rev-parse', '--abbrev-ref', 'HEAD']),
    ]);
    const repoMatch = remote.match(/[:/]([^/]+\/[^/]+?)(\.git)?$/);
    return {
        repo: repoMatch?.[1] ?? basename(cwd),
        ...(sha !== '' ? { commitSha: sha } : {}),
        ...(branch !== '' ? { branch } : {}),
    };
}
