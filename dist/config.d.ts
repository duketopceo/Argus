import { type ReviewProfile } from './review/packs.js';
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
/**
 * Exploratory lane (roadmap E2.U4): free runtime capture today
 * (console/pageerror/failed-request taps render as `observed` findings),
 * bounded act policy later. Opt-in — `enabled` defaults to false. On
 * untrusted checkouts the whole block is stripped by the config allowlist.
 */
export interface Explore {
    /** Master switch for capture + act. Default false. */
    enabled: boolean;
    /** Step cap for the exploratory act policy (U4b). Default 20. */
    maxSteps: number;
    /** Model budget for the act policy (U4b). Unset = bounded by run budget. */
    budgetUsd: number | undefined;
}
/**
 * Verified expected state for `verify --app`: at least one of these must
 * hold for the lane to pass — a page that merely loads is never a pass.
 * All configured conditions are ANDed.
 */
export interface AppExpectation {
    /** Substring that must appear in the a11y tree (case-insensitive). */
    text?: string;
    /** Regex source the final page URL must match. */
    url?: string;
    /** Playwright/CSS selector that must resolve at least one node. */
    selector?: string;
}
/**
 * `verify --app` lane (follow-through U3): a bounded natural-language task
 * run on the ExploreLoop substrate. Opt-in — the lane is selected by the
 * `--app` flag and this block supplies the task contract. Without `task`
 * and at least one `expected` marker the lane records `blocked`.
 */
export interface AppLane {
    /** Natural-language task the lane must accomplish. */
    task: string | undefined;
    /** Expected-state marker(s) the lane verifies deterministically. */
    expected: AppExpectation | undefined;
    /** Step cap for the task loop. Unset → explore.maxSteps. */
    maxSteps: number | undefined;
    /** Lane USD budget. Unset = bounded by run budget. */
    budgetUsd: number | undefined;
    /** Wall-clock cap in ms. Unset → lane default (120s). */
    timeoutMs: number | undefined;
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
     * OpenRouter Decisions API model for typed adjudication (the confidence model). Defaults
     * to the pinned `typesafe/jev-1.13-20260917` — alias slugs like
     * `~typesafe/jev-latest` drift silently and thresholds are calibrated
     * to a version. Set to `''` to disable adjudication (regex-only mode).
     */
    decisionModel: string | undefined;
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
     * How many `verify` run manifests the local history keeps
     * (`<reportDir>/manifests/*.json`) — the dashboard/TUI run list reads it.
     * `0` disables archival; unset defaults to 20 at write time.
     */
    reportRetention: number | undefined;
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
     * `heal: 'a0'`, `verify --a0`). `url` is the instance base URL — leave
     * unset to let the `a0` CLI resolve it (saved host, AGENT_ZERO_HOST,
     * Docker discovery). `maxTasks` caps delegations per `verify`/`run`
     * invocation (verify lane default 1, heal default 5); `timeoutMs` is the
     * per-task wall-clock bound for the verify lane. The lane is
     * an explicit opt-in escalation and caps completed delegations at
     * `inconclusive` — the agent's answer is self-reported evidence, never a
     * `passed` verdict (live round-trip proven in #53).
     */
    a0: {
        url: string | undefined;
        maxTasks: number | undefined;
        timeoutMs: number | undefined;
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
    /**
     * Exploratory lane. Always populated after `resolveConfig` —
     * `enabled: false` by default so capture is opt-in.
     */
    explore: Explore;
    /**
     * `verify --app` task lane. Always populated after `resolveConfig` —
     * every field unset by default so the lane blocks on missing contract
     * rather than inventing one.
     */
    app: AppLane;
    /**
     * Code-review policy knobs. Always populated after `resolveConfig`.
     * `secretsThreshold`: confidence-model `noul` probability at/above which a
     * secret-shaped diff literal is reported as a finding (below →
     * suppressed but audit-recorded). Default 0.3 — tune after dogfooding.
     * `maxComments`: cap on inline review comments posted per run
     * (default 20) — overflow is summarized count-only in the sticky.
     * `severityGate`: consumer-facing alias over `severity` — 'bug'
     * fails on bugs only, 'risk' fails on bug|risk. Unset → `severity`
     * list is authoritative.
     * `triage`: confidence-model pre-review lane — 'off' no call, 'annotate' (default)
     * records risk/deep-review/area into the report + sticky, 'route'
     * additionally swaps the code model to `lowRiskModel` on low-risk
     * diffs. The confidence model routes/annotates, never gates — coverage is constant.
     * `lowRiskModel`: the cheap code-model slug 'route' falls to; unset →
     * route keeps `code_model` (annotate-equivalent).
     * `findingThreshold`: P(false-positive) required to suppress a nit/q
     * finding after confidence-model adjudication — 1.0 (default) is annotate-only,
     * lowering it suppresses progressively more low-confidence nits.
     * bug/risk are never suppressed.
     * `requestChanges`: allow the review event to escalate to
     * REQUEST_CHANGES for proven blockers (probe-reproduced or confidence-model
     * high-confidence). Default true — set false for advisory-only posting.
     * `profiles`: named review lenses appended to the review prompt
     * ('security'|'perf'|'debloat' — see src/review/packs.ts). Unknown names
     * are dropped at config load. Default [] — no extra rubric.
     */
    review: {
        secretsThreshold: number;
        maxComments: number;
        severityGate: 'bug' | 'risk' | undefined;
        triage: 'off' | 'annotate' | 'route';
        lowRiskModel: string | undefined;
        findingThreshold: number;
        requestChanges: boolean;
        profiles: ReviewProfile[];
        /**
         * Glob list of changed paths kept out of the review input. A configured
         * list replaces the defaults (generated, fixture, golden, vendored
         * paths); `[]` excludes nothing.
         */
        exclude: string[];
        /**
         * `realtime` (default) calls the chat API per chunk. `batch` submits all
         * chunks through OpenRouter's async Batch API (cheaper, slower: minutes),
         * falling back to realtime on failure or timeout.
         */
        mode: 'realtime' | 'batch';
        /**
         * Poll deadline for a batch, ms. Must sit inside the CI job timeout
         * (the shipped workflow's is 15 minutes) with room left for a realtime
         * fallback. Default 480000.
         */
        batchTimeoutMs: number;
        /**
         * Model for `mode: 'batch'`, a `:batch` slug (the base slug is what is
         * sent). Separate from `code_model` because not every realtime model has
         * a batch endpoint. Unset: `<review model>:batch` when that slug is known
         * to exist, else DEFAULT_BATCH_MODEL.
         */
        batchModel: string | undefined;
        /**
         * Per-request timeout for realtime review calls, ms (1..900000,
         * default 120000). Reasoning models need more than the default.
         */
        requestTimeoutMs: number;
    };
}
export declare const DEFAULT_REQUEST_TIMEOUT_MS = 120000;
export declare const MAX_REQUEST_TIMEOUT_MS = 900000;
export declare const DEFAULT_BATCH_MODEL = "deepseek/deepseek-v4.1-flash:batch";
/** Batch slug for a review: explicit `batchModel`, else `<model>:batch` if known to exist, else the default. */
export declare function resolveBatchModel(reviewModel: string, batchModel: string | undefined): string;
/** Validates a per-request timeout; returns an error message or undefined when valid. */
export declare function checkRequestTimeoutMs(v: unknown): string | undefined;
export type ConfigInput = Partial<Omit<Config, 'provider' | 'sandbox' | 'review' | 'explore' | 'app'>> & {
    provider?: Partial<ProviderRules>;
    sandbox?: Partial<Sandbox>;
    review?: Partial<Config['review']>;
    explore?: Partial<Explore>;
    app?: Partial<AppLane>;
};
export declare const DEFAULT_RECORD_STEP_CAP = 40;
export declare const DEFAULT_EXPLORE: Explore;
export declare const DEFAULT_APP: AppLane;
export declare const DEFAULT_SANDBOX: Sandbox;
export declare function defineConfig(input: ConfigInput): ConfigInput;
/** Keep only non-blank string expected-state markers; all-dropped means unconfigured. */
export declare function sanitizeExpectation(input: unknown): AppExpectation | undefined;
/**
 * Which severities fail the review status. `review.severityGate` is the
 * consumer-facing alias over `severity` — 'risk' fails on bug|risk,
 * 'bug' on bugs only; unset → the `severity` list is authoritative.
 */
export declare function resolveBlockSeverities(config: Config): string[];
/**
 * Inline-comment cap: `ARGUS_MAX_COMMENTS` (the action's `max-comments`
 * input) wins when it parses as a non-negative integer — it's set by the
 * workflow author, so an untrusted PR config can't reach it (`review`
 * isn't on the untrusted allowlist). Anything else → `review.maxComments`.
 */
export declare function resolveMaxComments(env: Record<string, string | undefined>, config: Config): number;
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
