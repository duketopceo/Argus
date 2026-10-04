import { handleWebhook, type Env } from './webhook.js'

export { handleWebhook, MAX_BODY_BYTES, type Env, type WebhookDeps, type WebhookEvent } from './webhook.js'
export { createReplayGuard, type ReplayGuard } from './replay.js'
export { verifySignature, signatureFor } from './verify.js'

export default {
  fetch: (request: Request, env: Env): Promise<Response> => handleWebhook(request, env),
}
