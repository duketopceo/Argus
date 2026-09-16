import { pathToFileURL } from 'node:url';
export const DEFAULT_RECORD_STEP_CAP = 40;
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
    code_model: 'deepseek/deepseek-v4.1-flash',
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
};
export function defineConfig(input) {
    return input;
}
/** Positive-integer config values fall back to their default, floored. */
function posInt(v, dflt) {
    return v !== undefined && Number.isFinite(v) && v >= 1 ? Math.floor(v) : dflt;
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
    sandbox.memory = typeof raw.memory === 'string' && raw.memory !== '' ? raw.memory : DEFAULT_SANDBOX.memory;
    sandbox.cpus = typeof raw.cpus === 'string' && raw.cpus !== '' ? raw.cpus : DEFAULT_SANDBOX.cpus;
    sandbox.maxProbes = posInt(sandbox.maxProbes, DEFAULT_SANDBOX.maxProbes);
    sandbox.timeoutMs = posInt(sandbox.timeoutMs, DEFAULT_SANDBOX.timeoutMs);
    sandbox.pidsLimit = posInt(sandbox.pidsLimit, DEFAULT_SANDBOX.pidsLimit);
    const resolved = { ...defaults, ...input, provider, sandbox };
    resolved.recordStepCap = posInt(resolved.recordStepCap, DEFAULT_RECORD_STEP_CAP);
    if (resolved.heal !== 'a0')
        resolved.heal = 'local';
    return resolved;
}
export async function loadConfig(cwd) {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const names = ['argus-reviewer.config', 'vision-e2e.config'];
    for (const name of names) {
        for (const ext of ['.ts', '.json']) {
            const file = path.join(cwd, `${name}${ext}`);
            try {
                const stat = await fs.stat(file);
                if (!stat.isFile())
                    continue;
                if (ext === '.json') {
                    const raw = await fs.readFile(file, 'utf8');
                    return resolveConfig(JSON.parse(raw));
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
                return resolveConfig(exported);
            }
            catch (e) {
                const code = e.code;
                if (code === 'ENOENT')
                    continue;
                throw e;
            }
        }
    }
    return resolveConfig();
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
