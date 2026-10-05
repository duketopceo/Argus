import { pathToFileURL } from 'node:url'

import { DEFAULT_REVIEW_EXCLUDE } from './review/scope.js'
import { isReviewProfile, type ReviewProfile } from './review/packs.js'
import type { Trust } from './trust.js'
import { JEV_DEFAULT_MODEL } from './vision/decisions.js'

export interface ProviderRules {
  only?: string[]
  ignore?: string[]
  order?: string[]
  allow_fallbacks?: boolean
  require_parameters?: boolean
}

export interface Target {
  command: string
  url: string
  readyTimeoutMs: number
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
  enabled: boolean
  /**
   * Docker image probes run in — trusted maintainer config (a custom image
   * extends the sandbox's trusted computing base). Default undefined →
   * resolved at probe time as `node:<host Node major>-slim`, because native
   * `node_modules` are ABI-bound to the Node version that installed them.
   */
  image: string | undefined
  /** Max probes authored/executed per code-review run. Default 3. */
  maxProbes: number
  /** Hard wall-clock timeout per probe in milliseconds. Default 120_000. */
  timeoutMs: number
  /** Container memory limit (`--memory`). Default '2g'. */
  memory: string
  /** Container CPU limit (`--cpus`). Default '2'. */
  cpus: string
  /** Container PID limit (`--pids-limit`). Default 256. */
  pidsLimit: number
  /**
   * When true, probes run on fork PRs without further approval. When false,
   * fork PRs require a head-bound `argus-probe` label (the labeled event must
   * postdate the head's pushed_at) or a MEMBER/OWNER/COLLABORATOR
   * author_association. Same-repo PRs are unaffected either way.
   */
  allowForks: boolean
}

/**
 * Exploratory lane (roadmap E2.U4): free runtime capture today
 * (console/pageerror/failed-request taps render as `observed` findings),
 * bounded act policy later. Opt-in — `enabled` defaults to false. On
 * untrusted checkouts the whole block is stripped by the config allowlist.
 */
export interface Explore {
  /** Master switch for capture + act. Default false. */
  enabled: boolean
  /** Step cap for the exploratory act policy (U4b). Default 20. */
  maxSteps: number
  /** Model budget for the act policy (U4b). Unset = bounded by run budget. */
  budgetUsd: number | undefined
}

/**
 * Verified expected state for `verify --app`: at least one of these must
 * hold for the lane to pass — a page that merely loads is never a pass.
 * All configured conditions are ANDed.
 */
export interface AppExpectation {
  /** Substring that must appear in the a11y tree (case-insensitive). */
  text?: string
  /** Regex source the final page URL must match. */
  url?: string
  /** Playwright/CSS selector that must resolve at least one node. */
  selector?: string
}

/**
 * `verify --app` lane (follow-through U3): a bounded natural-language task
 * run on the ExploreLoop substrate. Opt-in — the lane is selected by the
 * `--app` flag and this block supplies the task contract. Without `task`
 * and at least one `expected` marker the lane records `blocked`.
 */
export interface AppLane {
  /** Natural-language task the lane must accomplish. */
  task: string | undefined
  /** Expected-state marker(s) the lane verifies deterministically. */
  expected: AppExpectation | undefined
  /** Step cap for the task loop. Unset → explore.maxSteps. */
  maxSteps: number | undefined
  /** Lane USD budget. Unset = bounded by run budget. */
  budgetUsd: number | undefined
  /** Wall-clock cap in ms. Unset → lane default (120s). */
  timeoutMs: number | undefined
}

export interface Config {
  model: string
  escalation_model: string
  /**
   * Optional specialist model for grounding-correction retries (e.g. a
   * ui-tars-class model that returns bare coordinates). Used only when the
   * primary model's proposed point resolves to the wrong element.
   */
  grounding_model: string | undefined
  /**
   * Optional code review model. Used by `argus-reviewer code-review` to review
   * PR diffs and post findings. Defaults to the primary `model` if not set.
   */
  code_model: string | undefined
  /**
   * OpenRouter Decisions API model for typed adjudication (the confidence model). Defaults
   * to the pinned `typesafe/jev-1.13-20260917` — alias slugs like
   * `~typesafe/jev-latest` drift silently and thresholds are calibrated
   * to a version. Set to `''` to disable adjudication (regex-only mode).
   */
  decisionModel: string | undefined
  /**
   * Hard budget for the `argus-reviewer code-review` lane. Unset follows
   * `budgetUsd` (default $1/run); `0` runs the review lane uncapped. After
   * resolveConfig `undefined` means explicitly unlimited.
   */
  codeReviewBudgetUsd: number | undefined
  provider: ProviderRules
  /**
   * Per-run spend cap in USD. Default `DEFAULT_BUDGET_USD` ($1). `0` is the
   * explicit unlimited switch (every command logs a warning). After
   * resolveConfig `undefined` means explicitly unlimited — never "unset".
   */
  budgetUsd: number | undefined
  target: Target | undefined
  cacheDir: string | undefined
  /** Directory scanned by `argus-reviewer run` for *.test.* files. */
  testsDir: string | undefined
  /** Directory for JUnit XML + JSON run report output. */
  reportDir: string | undefined
  /**
   * How many `verify` run manifests the local history keeps
   * (`<reportDir>/manifests/*.json`) — the dashboard/TUI run list reads it.
   * `0` disables archival; unset defaults to 20 at write time.
   */
  reportRetention: number | undefined
  /**
   * Named secrets for `td.type(name, { secret: true })`. The value is typed
   * locally and never sent to the model — the model only resolves the field.
   */
  secrets: Record<string, string> | undefined
  /**
   * Optional module path (resolved from cwd) whose default export is invoked
   * with the Playwright `Page` after the driver launches and before any
   * navigation — the seam for `page.route` mocks, tenant seeding, and other
   * pre-navigation setup.
   */
  pageSetup: string | undefined
  /**
   * OpenRouter request metadata. `trace` is sent in the request body and
   * can be used to attribute spend by repo, PR, or run. `headers` are
   * sent verbatim with every OpenRouter request (e.g. HTTP-Referer, X-Title).
   */
  openrouter: { trace?: Record<string, string>; headers?: Record<string, string> } | undefined
  /**
   * Browser engine for Playwright: `chromium`, `firefox`, or `webkit`.
   * Defaults to `chromium`.
   */
  browser: 'chromium' | 'firefox' | 'webkit' | undefined
  /**
   * Hard limit in milliseconds for Playwright cleanup (context + browser close).
   * Prevents a hung browser from keeping the runner or test suite alive.
   * Defaults to 30 seconds.
   */
  browserTimeoutMs: number | undefined
  /**
   * Severity levels that block a pre-merge status. Defaults to `['bug']` so
   * `risk`/`nit`/`q` findings are surfaced but do not fail the status.
   */
  severity: string[] | undefined
  /**
   * Log verbosity — 'debug'|'info'|'warn'|'error'. ARGUS_DEBUG=1 forces
   * 'debug'. Default 'warn'.
   */
  logLevel: 'debug' | 'info' | 'warn' | 'error' | undefined
  /**
   * Repo globs naming the app surface the tests exercise (e.g. 'ui/src/**').
   * Diff-aware invalidation marks flow caches stale when the diff touches
   * files in this surface's dependency cone.
   */
  sourceGlobs: string[] | undefined
  /** Path (repo-relative) for the generated repo index. Default 'argus.index.json'. */
  indexPath: string | undefined
  /** Base ref for diff invalidation (e.g. 'origin/main'); unset = working tree. */
  diffBase: string | undefined
  /**
   * Max actions `argus-reviewer record` will take before giving up on `done`.
   * Real multi-action flows need headroom — defaults to 40; `record
   * --max-steps <n>` overrides.
   */
  recordStepCap: number | undefined
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
  a0:
    | { url: string | undefined; maxTasks: number | undefined; timeoutMs: number | undefined }
    | undefined
  /**
   * Failure escalation for `run`. 'local' (default) heals via the vision
   * model only. 'a0' additionally sends each failed test to Agent Zero for an
   * autonomous second opinion — it clicks through the app and reports whether
   * the app or the expectation is wrong.
   */
  heal: 'local' | 'a0' | undefined
  /**
   * Committed-recording policy for flow heals. `healWriteback: 'pr'` turns
   * each model heal into a write-back proposal — a reviewable PR updating
   * `tests/argus/flows/*.json` in CI, a working-tree write locally — so
   * replayed recordings survive across runs. Relocation fields only; a heal
   * that rewrote the action payload is suppressed. Default 'off'. The key is
   * not on the untrusted allowlist — a fork PR's config cannot opt itself in.
   */
  flow: { healWriteback: 'off' | 'pr' }
  /**
   * Sandbox probe lane for `code-review` (Phase B.2). Always populated after
   * `resolveConfig` — `enabled: false` by default so the lane is opt-in.
   */
  sandbox: Sandbox
  /**
   * Exploratory lane. Always populated after `resolveConfig` —
   * `enabled: false` by default so capture is opt-in.
   */
  explore: Explore
  /**
   * `verify --app` task lane. Always populated after `resolveConfig` —
   * every field unset by default so the lane blocks on missing contract
   * rather than inventing one.
   */
  app: AppLane
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
    secretsThreshold: number
    maxComments: number
    severityGate: 'bug' | 'risk' | undefined
    triage: 'off' | 'annotate' | 'route'
    lowRiskModel: string | undefined
    findingThreshold: number
    requestChanges: boolean
    profiles: ReviewProfile[]
    /**
     * Glob list of changed paths kept out of the review input. A configured
     * list replaces the defaults (generated, fixture, golden, vendored
     * paths); `[]` excludes nothing.
     */
    exclude: string[]
    /**
     * `realtime` (default) calls the chat API per chunk. `batch` submits all
     * chunks through OpenRouter's async Batch API (cheaper, slower: minutes),
     * falling back to realtime on failure or timeout.
     */
    mode: 'realtime' | 'batch'
    /**
     * Poll deadline for a batch, ms. Must sit inside the CI job timeout
     * (the shipped workflow's is 15 minutes) with room left for a realtime
     * fallback. Default 480000.
     */
    batchTimeoutMs: number
    /**
     * Model for `mode: 'batch'`, a `:batch` slug (the base slug is what is
     * sent). Separate from `code_model` because not every realtime model has
     * a batch endpoint. Unset: `<review model>:batch` when that slug is known
     * to exist, else DEFAULT_BATCH_MODEL.
     */
    batchModel: string | undefined
    /**
     * Per-request timeout for realtime review calls, ms (1..900000,
     * default 120000). Reasoning models need more than the default.
     */
    requestTimeoutMs: number
  }
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 120_000
export const MAX_REQUEST_TIMEOUT_MS = 900_000
export const DEFAULT_BATCH_MODEL = 'deepseek/deepseek-v4.1-flash:batch'

/**
 * Base slugs measured to have an OpenRouter `:batch` endpoint (reviewer
 * bake-off, 2026-10-03). The realtime default deepseek-v4-flash has none.
 */
const KNOWN_BATCH_BASES = new Set([
  'google/gemini-2.5-flash-lite',
  'deepseek/deepseek-v4.1-flash',
  'z-ai/glm-5.3',
  'z-ai/glm-5.3-flash',
  'openai/gpt-oss-120b',
])

/** Batch slug for a review: explicit `batchModel`, else `<model>:batch` if known to exist, else the default. */
export function resolveBatchModel(reviewModel: string, batchModel: string | undefined): string {
  if (batchModel !== undefined && batchModel !== '') return batchModel
  const base = reviewModel.replace(/:batch$/, '')
  return KNOWN_BATCH_BASES.has(base) ? `${base}:batch` : DEFAULT_BATCH_MODEL
}

/** Validates a per-request timeout; returns an error message or undefined when valid. */
export function checkRequestTimeoutMs(v: unknown): string | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= MAX_REQUEST_TIMEOUT_MS
    ? undefined
    : `requestTimeoutMs must be an integer from 1 to ${MAX_REQUEST_TIMEOUT_MS} (ms), got ${String(v)}`
}

export type ConfigInput = Partial<Omit<Config, 'provider' | 'sandbox' | 'review' | 'explore' | 'app'>> & {
  provider?: Partial<ProviderRules>
  sandbox?: Partial<Sandbox>
  review?: Partial<Config['review']>
  explore?: Partial<Explore>
  app?: Partial<AppLane>
}

export const DEFAULT_RECORD_STEP_CAP = 40

/** Built-in per-run spend cap (USD) when nothing else is configured. */
export const DEFAULT_BUDGET_USD = 1

/** Logged by every paid command when the cap was explicitly disabled. */
export const UNCAPPED_WARNING =
  'warning: spend cap disabled (budgetUsd/ARGUS_BUDGET_USD = 0): this run is UNCAPPED; model spend is unbounded'

export type BudgetSetting =
  | { kind: 'unset' }
  | { kind: 'invalid' }
  | { kind: 'unlimited' }
  | { kind: 'cap'; usd: number }

/** Parse ARGUS_BUDGET_USD / the `budget-usd` action input: `0` = unlimited. */
export function parseBudgetSetting(raw: string | undefined): BudgetSetting {
  if (raw === undefined || raw.trim() === '') return { kind: 'unset' }
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return { kind: 'invalid' }
  return n === 0 ? { kind: 'unlimited' } : { kind: 'cap', usd: n }
}

/**
 * Apply an env/action budget setting. Returns the new cap (`undefined` =
 * unlimited) or `'keep'` when the setting is unset/invalid.
 */
export function applyBudgetSetting(s: BudgetSetting): number | undefined | 'keep' {
  if (s.kind === 'cap') return s.usd
  if (s.kind === 'unlimited') return undefined
  return 'keep'
}

export const DEFAULT_EXPLORE: Explore = {
  enabled: false,
  maxSteps: 20,
  budgetUsd: undefined,
}

export const DEFAULT_APP: AppLane = {
  task: undefined,
  expected: undefined,
  maxSteps: undefined,
  budgetUsd: undefined,
  timeoutMs: undefined,
}

export const DEFAULT_SANDBOX: Sandbox = {
  enabled: false,
  image: undefined,
  maxProbes: 3,
  timeoutMs: 120_000,
  memory: '2g',
  cpus: '2',
  pidsLimit: 256,
  allowForks: false,
}

const defaults: Config = {
  model: 'google/gemini-2.5-flash-lite',
  escalation_model: 'moonshotai/kimi-k2.5',
  grounding_model: undefined,
  code_model: 'deepseek/deepseek-v4-flash',
  decisionModel: JEV_DEFAULT_MODEL,
  codeReviewBudgetUsd: undefined,
  provider: {
    ignore: ['siliconflow', 'novitaai', 'atlascloud', 'streamlake', 'chutes'],
  },
  budgetUsd: DEFAULT_BUDGET_USD,
  target: undefined,
  cacheDir: undefined,
  testsDir: undefined,
  reportDir: undefined,
  reportRetention: undefined,
  secrets: undefined,
  pageSetup: undefined,
  openrouter: undefined,
  browser: 'chromium',
  browserTimeoutMs: 30_000,
  severity: ['bug'],
  logLevel: undefined,
  sourceGlobs: undefined,
  indexPath: undefined,
  diffBase: undefined,
  recordStepCap: DEFAULT_RECORD_STEP_CAP,
  a0: undefined,
  heal: 'local',
  flow: { healWriteback: 'off' },
  sandbox: { ...DEFAULT_SANDBOX },
  explore: { ...DEFAULT_EXPLORE },
  app: { ...DEFAULT_APP },
  review: {
    secretsThreshold: 0.3,
    maxComments: 20,
    severityGate: undefined,
    triage: 'annotate',
    lowRiskModel: undefined,
    findingThreshold: 1.0,
    requestChanges: true,
    profiles: [],
    exclude: [...DEFAULT_REVIEW_EXCLUDE],
    mode: 'realtime',
    batchTimeoutMs: 480_000,
    batchModel: undefined,
    requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
  },
}

export function defineConfig(input: ConfigInput): ConfigInput {
  return input
}

/** Positive-integer config values fall back to their default, floored. */
function posInt(v: number | undefined, dflt: number): number {
  return v !== undefined && Number.isFinite(v) && v >= 1 ? Math.floor(v) : dflt
}

/** Probability config values (must be in [0,1]) fall back to their default. */
function prob01(v: number | undefined, dflt: number): number {
  return v !== undefined && Number.isFinite(v) && v >= 0 && v <= 1 ? v : dflt
}

/** Optional positive-integer config values stay undefined when absent or wrong-typed. */
function optPosInt(v: number | undefined): number | undefined {
  return v !== undefined && Number.isInteger(v) && v >= 1 ? v : undefined
}

/** Keep only non-blank string expected-state markers; all-dropped means unconfigured. */
export function sanitizeExpectation(input: unknown): AppExpectation | undefined {
  if (typeof input !== 'object' || input === null) return undefined
  const raw = input as Record<string, unknown>
  // Whitespace-only markers are vacuous — a `' '` needle matches every
  // accessibility tree. Trim at the boundary so they drop like ''.
  const marker = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined
  const expected: AppExpectation = {}
  const text = marker(raw.text)
  if (text !== undefined) expected.text = text
  const url = marker(raw.url)
  if (url !== undefined) expected.url = url
  const selector = marker(raw.selector)
  if (selector !== undefined) expected.selector = selector
  return expected.text === undefined && expected.url === undefined && expected.selector === undefined
    ? undefined
    : expected
}

/**
 * Which severities fail the review status. `review.severityGate` is the
 * consumer-facing alias over `severity` — 'risk' fails on bug|risk,
 * 'bug' on bugs only; unset → the `severity` list is authoritative.
 */
export function resolveBlockSeverities(config: Config): string[] {
  if (config.review.severityGate === 'risk') return ['bug', 'risk']
  if (config.review.severityGate === 'bug') return ['bug']
  return config.severity ?? ['bug']
}

/**
 * Inline-comment cap: `ARGUS_MAX_COMMENTS` (the action's `max-comments`
 * input) wins when it parses as a non-negative integer — it's set by the
 * workflow author, so an untrusted PR config can't reach it (`review`
 * isn't on the untrusted allowlist). Anything else → `review.maxComments`.
 */
export function resolveMaxComments(
  env: Record<string, string | undefined>,
  config: Config,
): number {
  const raw = env.ARGUS_MAX_COMMENTS?.trim()
  // ^\d+$ — Number() would also accept '0x10', '1e2', ' 4 ', 'Infinity'.
  if (raw !== undefined && /^\d+$/.test(raw)) {
    return Number(raw)
  }
  return config.review.maxComments
}

export function resolveConfig(input: ConfigInput = {}): Config {
  const provider: ProviderRules = { ...defaults.provider, ...(input.provider ?? {}) }
  // Wrong-typed sandbox values (e.g. `sandbox: true`, `enabled: 'yes'`,
  // `memory: 2048`) degrade silently to defaults — the lane is opt-in and a
  // mis-typed flag must never feed docker argv or self-enable.
  const raw = typeof input.sandbox === 'object' && input.sandbox !== null ? input.sandbox : {}
  const sandbox: Sandbox = { ...defaults.sandbox, ...raw }
  sandbox.enabled = raw.enabled === true
  sandbox.allowForks = raw.allowForks === true
  sandbox.image = typeof raw.image === 'string' && raw.image !== '' ? raw.image : undefined
  sandbox.memory =
    typeof raw.memory === 'string' && raw.memory !== '' ? raw.memory : DEFAULT_SANDBOX.memory
  sandbox.cpus = typeof raw.cpus === 'string' && raw.cpus !== '' ? raw.cpus : DEFAULT_SANDBOX.cpus
  sandbox.maxProbes = posInt(sandbox.maxProbes, DEFAULT_SANDBOX.maxProbes)
  sandbox.timeoutMs = posInt(sandbox.timeoutMs, DEFAULT_SANDBOX.timeoutMs)
  sandbox.pidsLimit = posInt(sandbox.pidsLimit, DEFAULT_SANDBOX.pidsLimit)
  // Same wrong-typed degrade as sandbox — a mis-typed flag must never
  // self-enable the lane.
  const rawExplore =
    typeof input.explore === 'object' && input.explore !== null ? input.explore : {}
  const explore: Explore = { ...defaults.explore, ...rawExplore }
  explore.enabled = rawExplore.enabled === true
  explore.maxSteps = posInt(explore.maxSteps, DEFAULT_EXPLORE.maxSteps)
  explore.budgetUsd =
    typeof explore.budgetUsd === 'number' &&
    Number.isFinite(explore.budgetUsd) &&
    explore.budgetUsd > 0
      ? explore.budgetUsd
      : undefined
  // Same wrong-typed degrade for the app lane contract — a mis-typed
  // marker must never self-author a passing condition.
  const rawApp = typeof input.app === 'object' && input.app !== null ? input.app : {}
  const app: AppLane = { ...defaults.app, ...rawApp }
  app.task = typeof app.task === 'string' && app.task.trim() !== '' ? app.task : undefined
  app.expected = sanitizeExpectation(app.expected)
  app.maxSteps = optPosInt(rawApp.maxSteps)
  app.timeoutMs = optPosInt(rawApp.timeoutMs)
  app.budgetUsd =
    typeof app.budgetUsd === 'number' && Number.isFinite(app.budgetUsd) && app.budgetUsd > 0
      ? app.budgetUsd
      : undefined
  const rawReview = typeof input.review === 'object' && input.review !== null ? input.review : {}
  const review = { ...defaults.review, ...rawReview }
  // Thresholds must be probabilities — anything else (NaN, >1,
  // negative) would silently suppress or flood the confidence-model lanes.
  review.secretsThreshold = prob01(review.secretsThreshold, defaults.review.secretsThreshold)
  review.maxComments =
    typeof review.maxComments === 'number' &&
    Number.isInteger(review.maxComments) &&
    review.maxComments >= 0
      ? review.maxComments
      : defaults.review.maxComments
  if (review.severityGate !== 'bug' && review.severityGate !== 'risk') {
    review.severityGate = undefined
  }
  if (review.triage !== 'off' && review.triage !== 'annotate' && review.triage !== 'route') {
    review.triage = defaults.review.triage
  }
  if (typeof review.lowRiskModel !== 'string' || review.lowRiskModel === '') {
    review.lowRiskModel = undefined
  }
  review.findingThreshold = prob01(review.findingThreshold, defaults.review.findingThreshold)
  // Advisory-only escape hatch — only literal `false` opts out; anything
  // else (mis-typed values included) keeps the default-true posture.
  review.requestChanges = review.requestChanges !== false
  // Unknown profile names are rejected at config load — a typo silently
  // disabling a lens is worse than dropping it. Non-array input means the
  // field was mis-typed entirely and also drops to the empty default.
  review.profiles = Array.isArray(rawReview.profiles)
    ? [...new Set(rawReview.profiles.filter(isReviewProfile))]
    : []
  review.exclude =
    Array.isArray(rawReview.exclude) &&
    rawReview.exclude.every((g) => typeof g === 'string' && g !== '')
      ? [...rawReview.exclude]
      : [...DEFAULT_REVIEW_EXCLUDE]
  review.mode = review.mode === 'batch' ? 'batch' : 'realtime'
  review.batchTimeoutMs = posInt(review.batchTimeoutMs, defaults.review.batchTimeoutMs)
  if (typeof review.batchModel !== 'string' || review.batchModel.trim() === '') {
    review.batchModel = undefined
  }
  if (rawReview.requestTimeoutMs !== undefined) {
    const bad = checkRequestTimeoutMs(rawReview.requestTimeoutMs)
    if (bad !== undefined) throw new Error(`review.${bad}`)
  }
  const resolved: Config = { ...defaults, ...input, provider, sandbox, explore, app, review }
  // 0 = explicit unlimited; anything not a finite non-negative number
  // (mis-typed, negative, null) degrades to the default cap, never to unlimited.
  const rawBudget = input.budgetUsd
  resolved.budgetUsd =
    rawBudget === undefined
      ? DEFAULT_BUDGET_USD
      : typeof rawBudget === 'number' && Number.isFinite(rawBudget) && rawBudget >= 0
        ? rawBudget === 0
          ? undefined
          : rawBudget
        : DEFAULT_BUDGET_USD
  const rawReviewBudget = input.codeReviewBudgetUsd
  resolved.codeReviewBudgetUsd =
    typeof rawReviewBudget === 'number' && Number.isFinite(rawReviewBudget) && rawReviewBudget > 0
      ? rawReviewBudget
      : rawReviewBudget === 0
        ? undefined
        : resolved.budgetUsd
  resolved.recordStepCap = posInt(resolved.recordStepCap, DEFAULT_RECORD_STEP_CAP)
  // Retention is a non-negative integer (0 = keep none) — a mis-typed or
  // negative bound degrades to unset, never to "keep everything".
  resolved.reportRetention =
    typeof resolved.reportRetention === 'number' &&
    Number.isInteger(resolved.reportRetention) &&
    resolved.reportRetention >= 0
      ? resolved.reportRetention
      : undefined
  if (resolved.heal !== 'a0') resolved.heal = 'local'
  // Same wrong-typed degrade: a mis-typed write-back flag must never
  // self-enable a write path.
  const rawFlow: { healWriteback?: unknown } =
    typeof input.flow === 'object' && input.flow !== null ? input.flow : {}
  resolved.flow = { healWriteback: rawFlow.healWriteback === 'pr' ? 'pr' : 'off' }
  if (resolved.a0 !== undefined) {
    // A0 bounds degrade like every other numeric knob — a hostile or
    // mis-typed cap must not become unlimited tasks or no timeout.
    const a0 = resolved.a0
    resolved.a0 = {
      url: typeof a0.url === 'string' && a0.url !== '' ? a0.url : undefined,
      maxTasks: optPosInt(a0.maxTasks),
      timeoutMs: optPosInt(a0.timeoutMs),
    }
  }
  // '' is the documented opt-out — an empty slug would send a broken
  // model id to the decisions endpoint on every adjudication call.
  if (resolved.decisionModel === '') resolved.decisionModel = undefined
  return resolved
}

export interface LoadConfigOpts {
  /**
   * Required — there is no default. Every call site must state the
   * checkout's trust so a missed or future caller can't silently execute
   * config code on a hostile tree (see src/trust.ts).
   */
  trust: Trust
  /** Human-readable note on security-relevant load decisions (e.g. ctx.err). */
  note?: (line: string) => void
}

/**
 * Config keys honored on untrusted checkouts — policy-free fields only.
 * Everything else (exec-bearing fields, model/budget/provider selection,
 * severity/verdict policy, credentials maps, network endpoints, write
 * locations) is ignored: the review policy over hostile code must not be
 * authored by that code.
 */
const UNTRUSTED_CONFIG_KEYS: ReadonlySet<string> = new Set(['logLevel', 'sourceGlobs'])

function filterUntrustedConfig(input: ConfigInput): ConfigInput {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (UNTRUSTED_CONFIG_KEYS.has(key)) out[key] = value
  }
  return out as ConfigInput
}

export async function loadConfig(cwd: string, opts: LoadConfigOpts): Promise<Config> {
  const fs = await import('node:fs/promises')
  const path = await import('node:path')
  const untrusted = opts.trust === 'untrusted'

  // cacheDir is the documented CLI default '.argus-reviewer-cache' — normalize
  // it to an absolute path here so engine record/replay persistence (gated on
  // config.cacheDir) writes where every other consumer already falls back to.
  const finish = async (input: ConfigInput = {}): Promise<Config> => {
    const config = resolveConfig(input)
    const cacheDir = path.resolve(cwd, config.cacheDir ?? '.argus-reviewer-cache')
    if (untrusted) {
      // A hostile PR can commit the default path as a symlink and redirect
      // cache writes outside the checkout — fail closed before writers run.
      let isSymlink = false
      try {
        isSymlink = (await fs.lstat(cacheDir)).isSymbolicLink()
      } catch (e) {
        if ((e as { code?: string }).code !== 'ENOENT') throw e
      }
      if (isSymlink) {
        throw new Error(`untrusted cache directory must not be a symlink: ${cacheDir}`)
      }
    }
    config.cacheDir = cacheDir
    return config
  }

  const names = ['argus-reviewer.config', 'vision-e2e.config']
  for (const name of names) {
    if (untrusted) {
      // Surface skipped .ts candidates — otherwise a hostile config (or a
      // legit consumer debugging "why is my config ignored") is invisible.
      try {
        if ((await fs.stat(path.join(cwd, `${name}.ts`))).isFile()) {
          opts.note?.(`config: ${name}.ts ignored – untrusted checkouts load JSON config only`)
        }
      } catch {
        // no .ts candidate — nothing to note
      }
    }
    // .ts is tried before .json, so an untrusted checkout must skip the .ts
    // candidate *before* it can shadow a committed .json — importing it
    // executes arbitrary code beside the runner's secrets (#58).
    for (const ext of untrusted ? ['.json'] : ['.ts', '.json']) {
      const file = path.join(cwd, `${name}${ext}`)
      try {
        const stat = await fs.stat(file)
        if (!stat.isFile()) continue

        if (ext === '.json') {
          const raw = await fs.readFile(file, 'utf8')
          const parsed = JSON.parse(raw) as ConfigInput
          if (untrusted) {
            opts.note?.(
              `config: ${name}.json loaded untrusted – honoring ${[...UNTRUSTED_CONFIG_KEYS].join(', ')} only`,
            )
            return finish(filterUntrustedConfig(parsed))
          }
          return finish(parsed)
        }

        // Always transpile .ts to a temp .mjs rather than importing natively:
        // Node's built-in type stripping resolves the module type from the
        // *consumer's* package.json, so a CommonJS consumer makes ESM config
        // fail with 'Cannot use import statement'. The transpiled file is
        // written next to the config (removed after import) so relative
        // imports and node_modules resolution behave like the original file;
        // the package self-import is rewritten to this module's own index so
        // global/npx installs resolve it too.
        const ts = await import('typescript')
        const { readFile, writeFile, rm } = await import('node:fs/promises')
        const { join, dirname } = await import('node:path')
        const source = await readFile(file, 'utf8')
        const js = ts
          .transpileModule(source, {
            compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
          })
          .outputText.replace(
            /(['"])argus-reviewer-e2e\1/g,
            // package.json exports '.' → dist/api.js (sibling of this file)
            JSON.stringify(new URL('./api.js', import.meta.url).href),
          )
        const out = join(dirname(file), `.argus-config-${process.pid}-${Date.now()}.mjs`)
        let mod: { default?: ConfigInput } & ConfigInput
        try {
          await writeFile(out, js, 'utf8')
          mod = (await import(pathToFileURL(out).href)) as typeof mod
        } finally {
          await rm(out, { force: true }).catch(() => undefined)
        }
        const exported = mod.default ?? mod
        return finish(exported as ConfigInput)
      } catch (e: unknown) {
        const code = (e as { code?: string }).code
        if (code === 'ENOENT') continue
        throw e
      }
    }
  }

  return finish()
}

/**
 * Provider slugs the harness recognizes for `provider.only/ignore/order`
 * (KTD4). Unknown slugs warn but do not fail — OpenRouter's catalog changes
 * faster than this list, so validation is fail-open by design.
 */
export const KNOWN_PROVIDER_SLUGS: ReadonlySet<string> = new Set([
  'ai21',
  'aion-labs',
  'alibaba',
  'amazon-bedrock',
  'anthropic',
  'atlascloud',
  'azure',
  'bedrock',
  'cerebras',
  'chutes',
  'cloudflare',
  'cohere',
  'coreweave',
  'crusoe',
  'deepinfra',
  'deepseek',
  'featherless',
  'fireworks',
  'friendli',
  'gmicloud',
  'google',
  'google-ai-studio',
  'groq',
  'hyperbolic',
  'inception',
  'inference-net',
  'lambda',
  'mistral',
  'moonshotai',
  'ncompass',
  'nebius',
  'nineteen',
  'novitaai',
  'open-inference',
  'openai',
  'openrouter',
  'parasail',
  'perplexity',
  'phala',
  'relace',
  'sambanova',
  'siliconflow',
  'streamlake',
  'targon',
  'together',
  'ubicloud',
  'venice',
  'wandb',
  'xai',
  'zai',
])

/** Slugs in the provider rules that are not recognized; callers warn, not fail. */
export function unknownProviderSlugs(provider: ProviderRules): string[] {
  const slugs = [...(provider.only ?? []), ...(provider.ignore ?? []), ...(provider.order ?? [])]
  return slugs.filter((slug) => !KNOWN_PROVIDER_SLUGS.has(slug.toLowerCase()))
}
