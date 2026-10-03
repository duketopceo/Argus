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

// Public test identifier used by the integration suite — not a secret.
export const TEST_WEBHOOK_ID = '__RQ_TESTID__'
