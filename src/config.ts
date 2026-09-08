import { pathToFileURL } from 'node:url'

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

export interface Config {
  model: string
  escalation_model: string
  provider: ProviderRules
  budgetUsd: number | undefined
  target: Target | undefined
  cacheDir: string | undefined
  /** Directory scanned by `vision-e2e run` for *.test.* files. */
  testsDir: string | undefined
  /** Directory for JUnit XML + JSON run report output. */
  reportDir: string | undefined
  /**
   * Named secrets for `td.type(name, { secret: true })`. The value is typed
   * locally and never sent to the model — the model only resolves the field.
   */
  secrets: Record<string, string> | undefined
}

export type ConfigInput = Partial<Omit<Config, 'provider'>> & { provider?: Partial<ProviderRules> }

const defaults: Config = {
  model: 'qwen/qwen3.7-flash',
  escalation_model: 'moonshotai/kimi-k2.5',
  provider: {
    ignore: ['siliconflow', 'novitaai', 'atlascloud', 'streamlake', 'chutes'],
  },
  budgetUsd: undefined,
  target: undefined,
  cacheDir: undefined,
  testsDir: undefined,
  reportDir: undefined,
  secrets: undefined,
}

export function resolveConfig(input: ConfigInput = {}): Config {
  const provider: ProviderRules = { ...defaults.provider, ...(input.provider ?? {}) }
  return {
    ...defaults,
    ...input,
    provider,
  }
}

export async function loadConfig(cwd: string): Promise<Config> {
  const fs = await import('node:fs/promises')
  const path = await import('node:path')

  for (const ext of ['.ts', '.json']) {
    const file = path.join(cwd, `vision-e2e.config${ext}`)
    try {
      const stat = await fs.stat(file)
      if (!stat.isFile()) continue

      if (ext === '.json') {
        const raw = await fs.readFile(file, 'utf8')
        return resolveConfig(JSON.parse(raw) as ConfigInput)
      }

      const mod = (await import(pathToFileURL(file).href)) as {
        default?: ConfigInput
      } & ConfigInput
      const exported = mod.default ?? mod
      return resolveConfig(exported as ConfigInput)
    } catch (e: unknown) {
      const code = (e as { code?: string }).code
      if (code === 'ENOENT') continue
      throw e
    }
  }

  return resolveConfig()
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
