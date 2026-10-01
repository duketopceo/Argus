export interface Config {
  webhookUrl: string
  retries: number
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  return {
    webhookUrl: env.WEBHOOK_URL ?? '',
    retries: Number(env.RETRIES ?? 3),
  }
}
