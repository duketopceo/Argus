import { pathToFileURL } from 'node:url'

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
   * OpenRouter Decisions API model for typed adjudication (Jev). Defaults
   * to the pinned `typesafe/jev-1.13-20260917` — alias slugs like
   * `~typesafe/jev-latest` drift silently and thresholds are calibrated
   * to a version. Set to `''` to disable adjudication (regex-only mode).
   */
  decisionModel: string | undefined
  /**
   * Hard budget for the `argus-reviewer code-review` lane. When set, the
   * review stops early if the cumulative OpenRouter cost exceeds this cap.
   */
  codeReviewBudgetUsd: number | undefined
  provider: ProviderRules
  budgetUsd: number | undefined
  target: Target | undefined
  cacheDir: string | undefined
  /** Directory scanned by `argus-reviewer run` for *.test.* files. */
  testsDir: string | undefined
  /** Directory for JUnit XML + JSON run report output. */
  reportDir: string | undefined
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
   * `heal: 'a0'`). `url` is the instance base URL — leave unset to let the
   * `a0` CLI resolve it (saved host, AGENT_ZERO_HOST, Docker discovery).
   * Least-privilege scoping (browser vs full desktop) is configured on the
   * instance's gateway, not here.
   */
  a0: { url: string | undefined } | undefined
  /**
   * Failure escalation for `run`. 'local' (default) heals via the vision
   * model only. 'a0' additionally sends each failed test to Agent Zero for an
   * autonomous second opinion — it clicks through the app and reports whether
   * the app or the expectation is wrong.
   */
  heal: 'local' | 'a0' | undefined
  /**
   * Sandbox probe lane for `code-review` (Phase B.2). Always populated after
   * `resolveConfig` — `enabled: false` by default so the lane is opt-in.
   */
  sandbox: Sandbox
  /**
   * Code-review policy knobs. Always populated after `resolveConfig`.
   * `secretsThreshold`: Jev `noul` probability at/above which a
   * secret-shaped diff literal is reported as a finding (below →
   * suppressed but audit-recorded). Default 0.3 — tune after dogfooding.
   * `maxComments`: cap on inline review comments posted per run
   * (default 20) — overflow is summarized count-only in the sticky.
   * `severityGate`: consumer-facing alias over `severity` — 'bug'
   * fails on bugs only, 'risk' fails on bug|risk. Unset → `severity`
   * list is authoritative.
   * `triage`: Jev pre-review lane — 'off' no call, 'annotate' (default)
   * records risk/deep-review/area into the report + sticky, 'route'
   * additionally swaps the code model to `lowRiskModel` on low-risk
   * diffs. Jev routes/annotates, never gates — coverage is constant.
   * `lowRiskModel`: the cheap code-model slug 'route' falls to; unset →
   * route keeps `code_model` (annotate-equivalent).
   * `findingThreshold`: P(false-positive) required to suppress a nit/q
   * finding after Jev adjudication — 1.0 (default) is annotate-only,
   * lowering it suppresses progressively more low-confidence nits.
   * bug/risk are never suppressed.
   */
  review: {
    secretsThreshold: number
    maxComments: number
    severityGate: 'bug' | 'risk' | undefined
    triage: 'off' | 'annotate' | 'route'
    lowRiskModel: string | undefined
    findingThreshold: number
  }
}

export type ConfigInput = Partial<Omit<Config, 'provider' | 'sandbox' | 'review'>> & {
  provider?: Partial<ProviderRules>
  sandbox?: Partial<Sandbox>
  review?: Partial<Config['review']>
}

export const DEFAULT_RECORD_STEP_CAP = 40

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
  code_model: 'deepseek/deepseek-v4.1-flash',
  decisionModel: JEV_DEFAULT_MODEL,
  codeReviewBudgetUsd: undefined,
  provider: {
    ignore: ['siliconflow', 'novitaai', 'atlascloud', 'streamlake', 'chutes'],
  },
  budgetUsd: undefined,
  target: undefined,
  cacheDir: undefined,
  testsDir: undefined,
  reportDir: undefined,
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
  sandbox: { ...DEFAULT_SANDBOX },
  review: {
    secretsThreshold: 0.3,
    maxComments: 20,
    severityGate: undefined,
    triage: 'annotate',
    lowRiskModel: undefined,
    findingThreshold: 1.0,
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
  const rawReview = typeof input.review === 'object' && input.review !== null ? input.review : {}
  const review = { ...defaults.review, ...rawReview }
  // Thresholds must be probabilities — anything else (NaN, >1,
  // negative) would silently suppress or flood the Jev lanes.
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
  const resolved: Config = { ...defaults, ...input, provider, sandbox, review }
  resolved.recordStepCap = posInt(resolved.recordStepCap, DEFAULT_RECORD_STEP_CAP)
  if (resolved.heal !== 'a0') resolved.heal = 'local'
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
          opts.note?.(`config: ${name}.ts ignored — untrusted checkouts load JSON config only`)
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
              `config: ${name}.json loaded untrusted — honoring ${[...UNTRUSTED_CONFIG_KEYS].join(', ')} only`,
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
