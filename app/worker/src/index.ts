import { createOnboardingHandler } from './onboard.js'
import { handleWebhook, type Env } from './webhook.js'

export { handleWebhook, MAX_BODY_BYTES, type Env, type WebhookDeps, type WebhookEvent } from './webhook.js'
export { createReplayGuard, type ReplayGuard } from './replay.js'
export { verifySignature, signatureFor } from './verify.js'
export { handleInstallationEvent, createOnboardingHandler, WORST_CASE_PER_REPO, type OnboardResult, type RepoResult } from './onboard.js'

interface ExecutionContextLike {
  waitUntil(p: Promise<unknown>): void
}

export default {
  // The onboarding work runs under waitUntil so GitHub gets its 202 well inside
  // its 10 s delivery timeout; handlers catch their own errors per repo.
  fetch: (request: Request, env: Env, ctx?: ExecutionContextLike): Promise<Response> =>
    handleWebhook(request, env, {
      onEvent: createOnboardingHandler(env, ctx ? { defer: (p) => ctx.waitUntil(p) } : {}),
    }),
}
