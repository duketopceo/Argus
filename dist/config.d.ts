import type { Trust } from './trust.js';
export interface ProviderRules {
    only?: string[];
    ignore?: string[];
    order?: string[];
    allow_fallbacks?: boolean;
    require_parameters?: boolean;
}
export interface Target {
    command: string;
    url: string;
    readyTimeoutMs: number;
}
/**
 * Sandbox probe lane (Phase B.2, KTD5): runs authored test probes against
 * `not_exercised` code-review findings inside a hardened Docker container.
 * Opt-in — `enabled` defaults to false. Fork PRs are gated by `allowForks`,
 * the `argus-probe` label, or a trusted author_association (see
 * `evidence/gate.ts`).
 */
export interface Sandbox {
    /** Master switch for the probe lane. Default false. */
    enabled: boolean;
    /**
     * Docker image probes run in — trusted maintainer config (a custom image
     * extends the sandbox's trusted computing base). Default undefined →
     * resolved at probe time as `node:<host Node major>-slim`, because native
     * `node_modules` are ABI-bound to the Node version that installed them.
     */
    image: string | undefined;
    /** Max probes authored/executed per code-review run. Default 3. */
    maxProbes: number;
    /** Hard wall-clock timeout per probe in milliseconds. Default 120_000. */
    timeoutMs: number;
    /** Container memory limit (`--memory`). Default '2g'. */
    memory: string;
    /** Container CPU limit (`--cpus`). Default '2'. */
    cpus: string;
    /** Container PID limit (`--pids-limit`). Default 256. */
    pidsLimit: number;
    /**
     * When true, probes run on fork PRs without further approval. When false,
     * fork PRs require a head-bound `argus-probe` label (the labeled event must
     * postdate the head's pushed_at) or a MEMBER/OWNER/COLLABORATOR
     * author_association. Same-repo PRs are unaffected either way.
     */
    allowForks: boolean;
}
export interface Config {
    model: string;
    escalation_model: string;
    /**
     * Optional specialist model for grounding-correction retries (e.g. a
     * ui-tars-class model that returns bare coordinates). Used only when the
     * primary model's proposed point resolves to the wrong element.
     */
    grounding_model: string | undefined;
    /**
     * Optional code review model. Used by `argus-reviewer code-review` to review
     * PR diffs and post findings. Defaults to the primary `model` if not set.
     */
    code_model: string | undefined;
    /**
     * Hard budget for the `argus-reviewer code-review` lane. When set, the
     * review stops early if the cumulative OpenRouter cost exceeds this cap.
     */
    codeReviewBudgetUsd: number | undefined;
    provider: ProviderRules;
    budgetUsd: number | undefined;
    target: Target | undefined;
    cacheDir: string | undefined;
    /** Directory scanned by `argus-reviewer run` for *.test.* files. */
    testsDir: string | undefined;
    /** Directory for JUnit XML + JSON run report output. */
    reportDir: string | undefined;
    /**
     * Named secrets for `td.type(name, { secret: true })`. The value is typed
     * locally and never sent to the model — the model only resolves the field.
     */
    secrets: Record<string, string> | undefined;
    /**
     * Optional module path (resolved from cwd) whose default export is invoked
     * with the Playwright `Page` after the driver launches and before any
     * navigation — the seam for `page.route` mocks, tenant seeding, and other
     * pre-navigation setup.
     */
    pageSetup: string | undefined;
    /**
     * OpenRouter request metadata. `trace` is sent in the request body and
     * can be used to attribute spend by repo, PR, or run. `headers` are
     * sent verbatim with every OpenRouter request (e.g. HTTP-Referer, X-Title).
     */
    openrouter: {
        trace?: Record<string, string>;
        headers?: Record<string, string>;
    } | undefined;
    /**
     * Browser engine for Playwright: `chromium`, `firefox`, or `webkit`.
     * Defaults to `chromium`.
     */
    browser: 'chromium' | 'firefox' | 'webkit' | undefined;
    /**
     * Hard limit in milliseconds for Playwright cleanup (context + browser close).
     * Prevents a hung browser from keeping the runner or test suite alive.
     * Defaults to 30 seconds.
     */
    browserTimeoutMs: number | undefined;
    /**
     * Severity levels that block a pre-merge status. Defaults to `['bug']` so
     * `risk`/`nit`/`q` findings are surfaced but do not fail the status.
     */
    severity: string[] | undefined;
    /**
     * Log verbosity — 'debug'|'info'|'warn'|'error'. ARGUS_DEBUG=1 forces
     * 'debug'. Default 'warn'.
     */
    logLevel: 'debug' | 'info' | 'warn' | 'error' | undefined;
    /**
     * Repo globs naming the app surface the tests exercise (e.g. 'ui/src/**').
     * Diff-aware invalidation marks flow caches stale when the diff touches
     * files in this surface's dependency cone.
     */
    sourceGlobs: string[] | undefined;
    /** Path (repo-relative) for the generated repo index. Default 'argus.index.json'. */
    indexPath: string | undefined;
    /** Base ref for diff invalidation (e.g. 'origin/main'); unset = working tree. */
    diffBase: string | undefined;
    /**
     * Max actions `argus-reviewer record` will take before giving up on `done`.
     * Real multi-action flows need headroom — defaults to 40; `record
     * --max-steps <n>` overrides.
     */
    recordStepCap: number | undefined;
    /**
     * Agent Zero instance for delegated tasks (`argus-reviewer delegate`,
     * `heal: 'a0'`). `url` is the instance base URL — leave unset to let the
     * `a0` CLI resolve it (saved host, AGENT_ZERO_HOST, Docker discovery).
     * Least-privilege scoping (browser vs full desktop) is configured on the
     * instance's gateway, not here.
     */
    a0: {
        url: string | undefined;
    } | undefined;
    /**
     * Failure escalation for `run`. 'local' (default) heals via the vision
     * model only. 'a0' additionally sends each failed test to Agent Zero for an
     * autonomous second opinion — it clicks through the app and reports whether
     * the app or the expectation is wrong.
     */
    heal: 'local' | 'a0' | undefined;
    /**
     * Sandbox probe lane for `code-review` (Phase B.2). Always populated after
     * `resolveConfig` — `enabled: false` by default so the lane is opt-in.
     */
    sandbox: Sandbox;
}
export type ConfigInput = Partial<Omit<Config, 'provider' | 'sandbox'>> & {
    provider?: Partial<ProviderRules>;
    sandbox?: Partial<Sandbox>;
};
export declare const DEFAULT_RECORD_STEP_CAP = 40;
export declare const DEFAULT_SANDBOX: Sandbox;
export declare function defineConfig(input: ConfigInput): ConfigInput;
export declare function resolveConfig(input?: ConfigInput): Config;
export interface LoadConfigOpts {
    /**
     * Required — there is no default. Every call site must state the
     * checkout's trust so a missed or future caller can't silently execute
     * config code on a hostile tree (see src/trust.ts).
     */
    trust: Trust;
    /** Human-readable note on security-relevant load decisions (e.g. ctx.err). */
    note?: (line: string) => void;
}
export declare function loadConfig(cwd: string, opts: LoadConfigOpts): Promise<Config>;
/**
 * Provider slugs the harness recognizes for `provider.only/ignore/order`
 * (KTD4). Unknown slugs warn but do not fail — OpenRouter's catalog changes
 * faster than this list, so validation is fail-open by design.
 */
export declare const KNOWN_PROVIDER_SLUGS: ReadonlySet<string>;
/** Slugs in the provider rules that are not recognized; callers warn, not fail. */
export declare function unknownProviderSlugs(provider: ProviderRules): string[];
