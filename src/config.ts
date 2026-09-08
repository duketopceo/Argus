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

      const mod = (await import(pathToFileURL(file).href)) as { default?: ConfigInput } & ConfigInput
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
