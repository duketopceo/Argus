import { pathToFileURL } from 'node:url';
import { DEFAULT_REVIEW_EXCLUDE } from './review/scope.js';
import { isReviewProfile } from './review/packs.js';
import { JEV_DEFAULT_MODEL } from './vision/decisions.js';
export const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
export const MAX_REQUEST_TIMEOUT_MS = 900_000;
export const DEFAULT_BATCH_MODEL = 'deepseek/deepseek-v4.1-flash:batch';
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
]);
/** Batch slug for a review: explicit `batchModel`, else `<model>:batch` if known to exist, else the default. */
export function resolveBatchModel(reviewModel, batchModel) {
    if (batchModel !== undefined && batchModel !== '')
        return batchModel;
    const base = reviewModel.replace(/:batch$/, '');
    return KNOWN_BATCH_BASES.has(base) ? `${base}:batch` : DEFAULT_BATCH_MODEL;
}
/** Validates a per-request timeout; returns an error message or undefined when valid. */
export function checkRequestTimeoutMs(v) {
    return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= MAX_REQUEST_TIMEOUT_MS
        ? undefined
        : `requestTimeoutMs must be an integer from 1 to ${MAX_REQUEST_TIMEOUT_MS} (ms), got ${String(v)}`;
}
export const DEFAULT_RECORD_STEP_CAP = 40;
/** Built-in per-run spend cap (USD) when nothing else is configured. */
export const DEFAULT_BUDGET_USD = 1;
/** Logged by every paid command when the cap was explicitly disabled. */
export const UNCAPPED_WARNING = 'warning: spend cap disabled (budgetUsd/ARGUS_BUDGET_USD = 0): this run is UNCAPPED; model spend is unbounded';
/** Parse ARGUS_BUDGET_USD / the `budget-usd` action input: `0` = unlimited. */
export function parseBudgetSetting(raw) {
    if (raw === undefined || raw.trim() === '')
        return { kind: 'unset' };
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0)
        return { kind: 'invalid' };
    return n === 0 ? { kind: 'unlimited' } : { kind: 'cap', usd: n };
}
/**
 * Apply an env/action budget setting. Returns the new cap (`undefined` =
 * unlimited) or `'keep'` when the setting is unset/invalid.
 */
export function applyBudgetSetting(s) {
    if (s.kind === 'cap')
        return s.usd;
    if (s.kind === 'unlimited')
        return undefined;
    return 'keep';
}
export const DEFAULT_EXPLORE = {
    enabled: false,
    maxSteps: 20,
    budgetUsd: undefined,
};
export const DEFAULT_APP = {
    task: undefined,
    expected: undefined,
    maxSteps: undefined,
    budgetUsd: undefined,
    timeoutMs: undefined,
};
export const DEFAULT_SANDBOX = {
    enabled: false,
    image: undefined,
    maxProbes: 3,
    timeoutMs: 120_000,
    memory: '2g',
    cpus: '2',
    pidsLimit: 256,
    allowForks: false,
};
const defaults = {
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
};
export function defineConfig(input) {
    return input;
}
/** Positive-integer config values fall back to their default, floored. */
function posInt(v, dflt) {
    return v !== undefined && Number.isFinite(v) && v >= 1 ? Math.floor(v) : dflt;
}
/** Probability config values (must be in [0,1]) fall back to their default. */
function prob01(v, dflt) {
    return v !== undefined && Number.isFinite(v) && v >= 0 && v <= 1 ? v : dflt;
}
/** Optional positive-integer config values stay undefined when absent or wrong-typed. */
function optPosInt(v) {
    return v !== undefined && Number.isInteger(v) && v >= 1 ? v : undefined;
}
/** Keep only non-blank string expected-state markers; all-dropped means unconfigured. */
export function sanitizeExpectation(input) {
    if (typeof input !== 'object' || input === null)
        return undefined;
    const raw = input;
    // Whitespace-only markers are vacuous — a `' '` needle matches every
    // accessibility tree. Trim at the boundary so they drop like ''.
    const marker = (v) => typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
    const expected = {};
    const text = marker(raw.text);
    if (text !== undefined)
        expected.text = text;
    const url = marker(raw.url);
    if (url !== undefined)
        expected.url = url;
    const selector = marker(raw.selector);
    if (selector !== undefined)
        expected.selector = selector;
    return expected.text === undefined && expected.url === undefined && expected.selector === undefined
        ? undefined
        : expected;
}
/**
 * Which severities fail the review status. `review.severityGate` is the
 * consumer-facing alias over `severity` — 'risk' fails on bug|risk,
 * 'bug' on bugs only; unset → the `severity` list is authoritative.
 */
export function resolveBlockSeverities(config) {
    if (config.review.severityGate === 'risk')
        return ['bug', 'risk'];
    if (config.review.severityGate === 'bug')
        return ['bug'];
    return config.severity ?? ['bug'];
}
/**
 * Inline-comment cap: `ARGUS_MAX_COMMENTS` (the action's `max-comments`
 * input) wins when it parses as a non-negative integer — it's set by the
 * workflow author, so an untrusted PR config can't reach it (`review`
 * isn't on the untrusted allowlist). Anything else → `review.maxComments`.
 */
export function resolveMaxComments(env, config) {
    const raw = env.ARGUS_MAX_COMMENTS?.trim();
    // ^\d+$ — Number() would also accept '0x10', '1e2', ' 4 ', 'Infinity'.
    if (raw !== undefined && /^\d+$/.test(raw)) {
        return Number(raw);
    }
    return config.review.maxComments;
}
export function resolveConfig(input = {}) {
    const provider = { ...defaults.provider, ...(input.provider ?? {}) };
    // Wrong-typed sandbox values (e.g. `sandbox: true`, `enabled: 'yes'`,
    // `memory: 2048`) degrade silently to defaults — the lane is opt-in and a
    // mis-typed flag must never feed docker argv or self-enable.
    const raw = typeof input.sandbox === 'object' && input.sandbox !== null ? input.sandbox : {};
    const sandbox = { ...defaults.sandbox, ...raw };
    sandbox.enabled = raw.enabled === true;
    sandbox.allowForks = raw.allowForks === true;
    sandbox.image = typeof raw.image === 'string' && raw.image !== '' ? raw.image : undefined;
    sandbox.memory =
        typeof raw.memory === 'string' && raw.memory !== '' ? raw.memory : DEFAULT_SANDBOX.memory;
    sandbox.cpus = typeof raw.cpus === 'string' && raw.cpus !== '' ? raw.cpus : DEFAULT_SANDBOX.cpus;
    sandbox.maxProbes = posInt(sandbox.maxProbes, DEFAULT_SANDBOX.maxProbes);
    sandbox.timeoutMs = posInt(sandbox.timeoutMs, DEFAULT_SANDBOX.timeoutMs);
    sandbox.pidsLimit = posInt(sandbox.pidsLimit, DEFAULT_SANDBOX.pidsLimit);
    // Same wrong-typed degrade as sandbox — a mis-typed flag must never
    // self-enable the lane.
    const rawExplore = typeof input.explore === 'object' && input.explore !== null ? input.explore : {};
    const explore = { ...defaults.explore, ...rawExplore };
    explore.enabled = rawExplore.enabled === true;
    explore.maxSteps = posInt(explore.maxSteps, DEFAULT_EXPLORE.maxSteps);
    explore.budgetUsd =
        typeof explore.budgetUsd === 'number' &&
            Number.isFinite(explore.budgetUsd) &&
            explore.budgetUsd > 0
            ? explore.budgetUsd
            : undefined;
    // Same wrong-typed degrade for the app lane contract — a mis-typed
    // marker must never self-author a passing condition.
    const rawApp = typeof input.app === 'object' && input.app !== null ? input.app : {};
    const app = { ...defaults.app, ...rawApp };
    app.task = typeof app.task === 'string' && app.task.trim() !== '' ? app.task : undefined;
    app.expected = sanitizeExpectation(app.expected);
    app.maxSteps = optPosInt(rawApp.maxSteps);
    app.timeoutMs = optPosInt(rawApp.timeoutMs);
    app.budgetUsd =
        typeof app.budgetUsd === 'number' && Number.isFinite(app.budgetUsd) && app.budgetUsd > 0
            ? app.budgetUsd
            : undefined;
    const rawReview = typeof input.review === 'object' && input.review !== null ? input.review : {};
    const review = { ...defaults.review, ...rawReview };
    // Thresholds must be probabilities — anything else (NaN, >1,
    // negative) would silently suppress or flood the confidence-model lanes.
    review.secretsThreshold = prob01(review.secretsThreshold, defaults.review.secretsThreshold);
    review.maxComments =
        typeof review.maxComments === 'number' &&
            Number.isInteger(review.maxComments) &&
            review.maxComments >= 0
            ? review.maxComments
            : defaults.review.maxComments;
    if (review.severityGate !== 'bug' && review.severityGate !== 'risk') {
        review.severityGate = undefined;
    }
    if (review.triage !== 'off' && review.triage !== 'annotate' && review.triage !== 'route') {
        review.triage = defaults.review.triage;
    }
    if (typeof review.lowRiskModel !== 'string' || review.lowRiskModel === '') {
        review.lowRiskModel = undefined;
    }
    review.findingThreshold = prob01(review.findingThreshold, defaults.review.findingThreshold);
    // Advisory-only escape hatch — only literal `false` opts out; anything
    // else (mis-typed values included) keeps the default-true posture.
    review.requestChanges = review.requestChanges !== false;
    // Unknown profile names are rejected at config load — a typo silently
    // disabling a lens is worse than dropping it. Non-array input means the
    // field was mis-typed entirely and also drops to the empty default.
    review.profiles = Array.isArray(rawReview.profiles)
        ? [...new Set(rawReview.profiles.filter(isReviewProfile))]
        : [];
    review.exclude =
        Array.isArray(rawReview.exclude) &&
            rawReview.exclude.every((g) => typeof g === 'string' && g !== '')
            ? [...rawReview.exclude]
            : [...DEFAULT_REVIEW_EXCLUDE];
    review.mode = review.mode === 'batch' ? 'batch' : 'realtime';
    review.batchTimeoutMs = posInt(review.batchTimeoutMs, defaults.review.batchTimeoutMs);
    if (typeof review.batchModel !== 'string' || review.batchModel.trim() === '') {
        review.batchModel = undefined;
    }
    if (rawReview.requestTimeoutMs !== undefined) {
        const bad = checkRequestTimeoutMs(rawReview.requestTimeoutMs);
        if (bad !== undefined)
            throw new Error(`review.${bad}`);
    }
    const resolved = { ...defaults, ...input, provider, sandbox, explore, app, review };
    // 0 = explicit unlimited; anything not a finite non-negative number
    // (mis-typed, negative, null) degrades to the default cap, never to unlimited.
    const rawBudget = input.budgetUsd;
    resolved.budgetUsd =
        rawBudget === undefined
            ? DEFAULT_BUDGET_USD
            : typeof rawBudget === 'number' && Number.isFinite(rawBudget) && rawBudget >= 0
                ? rawBudget === 0
                    ? undefined
                    : rawBudget
                : DEFAULT_BUDGET_USD;
    const rawReviewBudget = input.codeReviewBudgetUsd;
    resolved.codeReviewBudgetUsd =
        typeof rawReviewBudget === 'number' && Number.isFinite(rawReviewBudget) && rawReviewBudget > 0
            ? rawReviewBudget
            : rawReviewBudget === 0
                ? undefined
                : resolved.budgetUsd;
    resolved.recordStepCap = posInt(resolved.recordStepCap, DEFAULT_RECORD_STEP_CAP);
    // Retention is a non-negative integer (0 = keep none) — a mis-typed or
    // negative bound degrades to unset, never to "keep everything".
    resolved.reportRetention =
        typeof resolved.reportRetention === 'number' &&
            Number.isInteger(resolved.reportRetention) &&
            resolved.reportRetention >= 0
            ? resolved.reportRetention
            : undefined;
    if (resolved.heal !== 'a0')
        resolved.heal = 'local';
    if (resolved.a0 !== undefined) {
        // A0 bounds degrade like every other numeric knob — a hostile or
        // mis-typed cap must not become unlimited tasks or no timeout.
        const a0 = resolved.a0;
        resolved.a0 = {
            url: typeof a0.url === 'string' && a0.url !== '' ? a0.url : undefined,
            maxTasks: optPosInt(a0.maxTasks),
            timeoutMs: optPosInt(a0.timeoutMs),
        };
    }
    // '' is the documented opt-out — an empty slug would send a broken
    // model id to the decisions endpoint on every adjudication call.
    if (resolved.decisionModel === '')
        resolved.decisionModel = undefined;
    return resolved;
}
/**
 * Config keys honored on untrusted checkouts — policy-free fields only.
 * Everything else (exec-bearing fields, model/budget/provider selection,
 * severity/verdict policy, credentials maps, network endpoints, write
 * locations) is ignored: the review policy over hostile code must not be
 * authored by that code.
 */
const UNTRUSTED_CONFIG_KEYS = new Set(['logLevel', 'sourceGlobs']);
function filterUntrustedConfig(input) {
    const out = {};
    for (const [key, value] of Object.entries(input)) {
        if (UNTRUSTED_CONFIG_KEYS.has(key))
            out[key] = value;
    }
    return out;
}
export async function loadConfig(cwd, opts) {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const untrusted = opts.trust === 'untrusted';
    // cacheDir is the documented CLI default '.argus-reviewer-cache' — normalize
    // it to an absolute path here so engine record/replay persistence (gated on
    // config.cacheDir) writes where every other consumer already falls back to.
    const finish = async (input = {}) => {
        const config = resolveConfig(input);
        const cacheDir = path.resolve(cwd, config.cacheDir ?? '.argus-reviewer-cache');
        if (untrusted) {
            // A hostile PR can commit the default path as a symlink and redirect
            // cache writes outside the checkout — fail closed before writers run.
            let isSymlink = false;
            try {
                isSymlink = (await fs.lstat(cacheDir)).isSymbolicLink();
            }
            catch (e) {
                if (e.code !== 'ENOENT')
                    throw e;
            }
            if (isSymlink) {
                throw new Error(`untrusted cache directory must not be a symlink: ${cacheDir}`);
            }
        }
        config.cacheDir = cacheDir;
        return config;
    };
    const names = ['argus-reviewer.config', 'vision-e2e.config'];
    for (const name of names) {
        if (untrusted) {
            // Surface skipped .ts candidates — otherwise a hostile config (or a
            // legit consumer debugging "why is my config ignored") is invisible.
            try {
                if ((await fs.stat(path.join(cwd, `${name}.ts`))).isFile()) {
                    opts.note?.(`config: ${name}.ts ignored – untrusted checkouts load JSON config only`);
                }
            }
            catch {
                // no .ts candidate — nothing to note
            }
        }
        // .ts is tried before .json, so an untrusted checkout must skip the .ts
        // candidate *before* it can shadow a committed .json — importing it
        // executes arbitrary code beside the runner's secrets (#58).
        for (const ext of untrusted ? ['.json'] : ['.ts', '.json']) {
            const file = path.join(cwd, `${name}${ext}`);
            try {
                const stat = await fs.stat(file);
                if (!stat.isFile())
                    continue;
                if (ext === '.json') {
                    const raw = await fs.readFile(file, 'utf8');
                    const parsed = JSON.parse(raw);
                    if (untrusted) {
                        opts.note?.(`config: ${name}.json loaded untrusted – honoring ${[...UNTRUSTED_CONFIG_KEYS].join(', ')} only`);
                        return finish(filterUntrustedConfig(parsed));
                    }
                    return finish(parsed);
                }
                // Always transpile .ts to a temp .mjs rather than importing natively:
                // Node's built-in type stripping resolves the module type from the
                // *consumer's* package.json, so a CommonJS consumer makes ESM config
                // fail with 'Cannot use import statement'. The transpiled file is
                // written next to the config (removed after import) so relative
                // imports and node_modules resolution behave like the original file;
                // the package self-import is rewritten to this module's own index so
                // global/npx installs resolve it too.
                const ts = await import('typescript');
                const { readFile, writeFile, rm } = await import('node:fs/promises');
                const { join, dirname } = await import('node:path');
                const source = await readFile(file, 'utf8');
                const js = ts
                    .transpileModule(source, {
                    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
                })
                    .outputText.replace(/(['"])argus-reviewer-e2e\1/g, 
                // package.json exports '.' → dist/api.js (sibling of this file)
                JSON.stringify(new URL('./api.js', import.meta.url).href));
                const out = join(dirname(file), `.argus-config-${process.pid}-${Date.now()}.mjs`);
                let mod;
                try {
                    await writeFile(out, js, 'utf8');
                    mod = (await import(pathToFileURL(out).href));
                }
                finally {
                    await rm(out, { force: true }).catch(() => undefined);
                }
                const exported = mod.default ?? mod;
                return finish(exported);
            }
            catch (e) {
                const code = e.code;
                if (code === 'ENOENT')
                    continue;
                throw e;
            }
        }
    }
    return finish();
}
/**
 * Provider slugs the harness recognizes for `provider.only/ignore/order`
 * (KTD4). Unknown slugs warn but do not fail — OpenRouter's catalog changes
 * faster than this list, so validation is fail-open by design.
 */
export const KNOWN_PROVIDER_SLUGS = new Set([
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
]);
/** Slugs in the provider rules that are not recognized; callers warn, not fail. */
export function unknownProviderSlugs(provider) {
    const slugs = [...(provider.only ?? []), ...(provider.ignore ?? []), ...(provider.order ?? [])];
    return slugs.filter((slug) => !KNOWN_PROVIDER_SLUGS.has(slug.toLowerCase()));
}
