import { Config, loadConfig } from '../config.js';
import { type ExecFn, type ProbeFn } from '../detect.js';
import { BrowserDriver } from '../driver/browser.js';
import { TargetProcess } from '../driver/target.js';
import { VisionClient } from '../engine/loop.js';
import { runRules } from '../review/rules.js';
import { type ErrorCode } from '../ui/errors.js';
import { type Styler } from '../ui/style.js';
export interface CliDeps {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    out?: (line: string) => void;
    err?: (line: string) => void;
    /** Inject a vision client (tests stub this; default builds OpenRouterClient). */
    createClient?: (config: Config) => VisionClient;
    /** Inject a driver factory (tests may stub browser launch). */
    launchDriver?: (config: Config) => Promise<BrowserDriver>;
    /** Inject a subprocess runner (tests stub `a0`/`gh` detection + delegation). */
    exec?: ExecFn;
    /** Inject the rules-lane runner (tests force lane-level failure). */
    rulesRunner?: typeof runRules;
    /** Inject the host reachability probe (tests stub a0 detection). */
    probe?: ProbeFn;
    /**
     * Whether output goes to a terminal. Defaults to process.stdout.isTTY
     * when `out` is not injected, and to false when it is.
     */
    isTTY?: boolean;
    /** Terminal width for the summary block (default process.stdout.columns, else 80). */
    columns?: number;
    /** Sleep step for the --keep-alive debug hold; injectable for tests. */
    sleep?: (ms: number) => Promise<void>;
}
export interface Ctx {
    cwd: string;
    env: NodeJS.ProcessEnv;
    out: (line: string) => void;
    err: (line: string) => void;
    /** TTY-aware styler (R12): plain when piped, NO_COLOR or --no-color. */
    style: Styler;
    /** Terminal width for the summary block. */
    width: number;
    /** `--json`: errors print as one JSON object with a stable code (R14). */
    json: boolean;
    /** `--debug` or ARGUS_DEBUG: stack traces and debug logs. */
    debug: boolean;
    /** Resolved TTY-ness (deps.isTTY or stdout.isTTY); gates interactive-only features. */
    isTTY: boolean;
    /** The invocation, for fix lines that say "re-run this". */
    rerun: string;
    /** True when a command runs as a verify lane: the outer command prints the summary. */
    nested?: boolean;
}
/** Flags accepted before or after any command; stripped before dispatch. */
export declare const GLOBAL_FLAGS: Set<string>;
export declare function shellQuote(arg: string): string;
/**
 * Print a classified error (R14): three styled lines, or one JSON object
 * on stdout under `--json`, so a pipe captures it. The caller still returns
 * its own exit code.
 */
export declare function reportError(ctx: Ctx, e: unknown, context: string | undefined, fallback: ErrorCode): void;
/** A usage error (exit 2 at the call site): the message is the summary, a help command the fix. */
export declare function usageError(ctx: Ctx, context: string | undefined, message: string, fix?: string): void;
/** loadConfig, with any failure classified as CONFIG_INVALID (R14). */
export declare function loadCliConfig(ctx: Ctx, trust: Parameters<typeof loadConfig>[1]['trust']): Promise<Config>;
/**
 * Top-level help, grouped by job (R16) with the default command first.
 * Each entry is a signature line and an indented description; every line
 * fits 80 columns.
 */
export declare const HELP_GROUPS: {
    title: string;
    commands: [signature: string[], description: string][];
}[];
export declare function renderUsage(style: Styler): string;
export declare const RECORD_USAGE = "Usage: argus-reviewer record \"<flow description>\" --url <target> [options]\n\nOptions:\n  --url <url>        Target URL (falls back to config.target.url)\n  --name <name>      Flow name for the cache + generated test file\n  --tests-dir <dir>  Where to write the generated test file (default: config testsDir or ./tests)\n  --max-steps <n>    Step cap before giving up on 'done' (default: config recordStepCap or 40)\n\n  -h, --help         Show this help";
export declare const RUN_USAGE = "Usage: argus-reviewer run [pattern] [options]\n\n\nDiscovers *.test.{ts,mts,mjs,js} under the tests dir, executes each against the\ntarget, and writes JUnit XML + a JSON run report.\n\nOptions:\n  [pattern]          Only run test files whose path contains this substring\n  --url <url>        Target URL (falls back to config.target.url)\n  --dir <dir>        Tests directory (default: config testsDir or ./tests)\n  --report-dir <dir> Report output dir (default: config reportDir or ./argus-reviewer-report)\n  --cache-dir <dir>  Fingerprint cache dir (default: config cacheDir)\n  --keep-alive       On failure, hold an argus-booted target up for inspection\n                     (interactive sessions only; skipped on CI/non-TTY)\n  --keep-alive-ttl <sec>  Keep-alive window in seconds (default 300, max 3600)\n  -h, --help         Show this help";
export declare const CODE_REVIEW_USAGE = "Usage: argus-reviewer code-review [options]\n\n\nReviews the PR diff for the repo/PR referenced by ARGUS_REVIEWER_TRACE using the\nconfigured code model. Writes code-review.json next to run.json.\n\nOptions:\n  --report-dir <dir> Report output dir (default: config reportDir or ./argus-reviewer-report)\n  --fixture <dir>    Review a local fixture repo (ref argus-fixture-base vs HEAD)\n                     instead of a live PR, with no GitHub API calls. Used by npm run demo.\n  --base <ref>       Review the local merge-base..worktree diff of <ref> -\n                     no GitHub context needed (the agent \"review my diff\" path).\n                     Without it, diffBase/ARGUS_DIFF_BASE supply the default base\n                     only when no PR context exists. Posts nothing; read\n                     code-review.json for the verdict.\n  --mode <mode>      realtime (default) | batch. batch submits the chunks through\n                     OpenRouter's async Batch API and falls back to realtime on\n                     failure or timeout. Overrides ARGUS_REVIEW_MODE and review.mode.\n  --batch-model <slug>  Model for batch mode (a :batch slug; default\n                     deepseek/deepseek-v4.1-flash:batch). Overrides\n                     ARGUS_BATCH_MODEL and review.batchModel.\n  --generate-tests   Author spec leafs from the diff (review.generateTests bounds),\n                     sandbox-validate when the head checkout is real, and deposit\n                     them on a reviewable PR under testsDir. Fork PRs refuse.\n  --full             Re-review the whole PR diff, bypassing the incremental\n                     baseline in the sticky comment (U4). Same effect as\n                     ARGUS_REVIEW_FULL=1 or '@argus review full'.\n  Env: ARGUS_REQUEST_TIMEOUT_MS sets the per-request timeout (default 120000,\n                     max 900000; also review.requestTimeoutMs).\n  -h, --help         Show this help";
export declare const CACHE_USAGE = "Usage: argus-reviewer cache <list|prune> [options]\n\n\n  cache list                 List cached flows (name + step count)\n  cache prune [name|--all]   Delete one flow cache, or all with --all\n\nOptions:\n  --dir <dir>   Cache directory (default: config cacheDir or ./.argus-reviewer-cache)\n  -h, --help    Show this help";
export declare const TEST_FILE_RE: RegExp;
/** Total wall-clock budget for all heal:'a0' delegations in one run. */
export declare const A0_HEAL_BUDGET_MS: number;
/** Default delegation-count ceiling for heal:'a0' — a0.maxTasks overrides. */
export declare const A0_HEAL_MAX_DELEGATIONS = 5;
/** Default --keep-alive window: long enough to attach, short enough to never strand a target. */
export declare const KEEP_ALIVE_DEFAULT_TTL_MS: number;
export declare const KEEP_ALIVE_MAX_TTL_MS: number;
export declare function parseKeepAliveTtl(raw: string | undefined): number | undefined;
/**
 * A run is interactive only on a real TTY outside CI. `CI` is the
 * conventional marker; `GITHUB_ACTIONS` covers a workflow that overrode CI.
 */
export declare function keepAliveInteractive(ctx: Ctx): boolean;
/**
 * U3 keep-alive: after a failed run, hold an argus-booted target up briefly
 * so a human can inspect the live app. Interactive sessions only: on CI or
 * under a headless agent there is nobody to attach, and the journal/report
 * is the debugging surface there (documented asymmetry, not a defect). Never
 * throws: a debug affordance must not break teardown.
 */
export declare function maybeKeepAliveHold(ctx: Ctx, deps: CliDeps, target: TargetProcess | undefined, url: string, ttlMs: number): Promise<void>;
/**
 * Checkout trust for config loading — resolved before `loadConfig` at every
 * call site so a hostile tree never executes config code (#58). `fetchMeta`
 * is only invoked on `issue_comment` or when a pull_request* payload is
 * unreadable; pull_request* events read fork status from the payload.
 */
export declare function resolveCheckoutTrust(ctx: Ctx): Promise<import("../trust.js").TrustResult>;
/**
 * Run-scoped nonce for evidence files. GITHUB_RUN_ID is not knowable when a
 * commit or a planted file is authored — that is the property that matters
 * (freshness, not secrecy: the id is public once the run exists). The sticky
 * poster and emit-review require evidence written by THIS run whenever the
 * env is present; local runs carry no nonce and are exempt.
 */
export declare function runNonceFrom(env: Record<string, string | undefined>): string | undefined;
/** Env/flag blank strings normalize to undefined — action inputs default to '' and must not shadow config, and a whitespace-only value must never stand in as a marker. */
export declare function envOr(v: string | undefined): string | undefined;
export declare function parseOpenRouterTrace(env: Ctx['env']): Record<string, string> | undefined;
export declare function createClient(deps: CliDeps, config: Config, ctx: Ctx): VisionClient;
export declare function launchDriver(config: Config, deps: CliDeps): Promise<BrowserDriver>;
export declare function warnUnknownProviders(config: Config, ctx: Ctx): void;
export declare function startTarget(config: Config): Promise<TargetProcess | undefined>;
export declare function slugify(text: string): string;
/** Repo identity for journal records; all probes degrade to 'unknown'. */
export declare function gitInfo(cwd: string): Promise<{
    repo: string;
    commitSha?: string;
    branch?: string;
}>;
