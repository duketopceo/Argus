import { createReplayGuard, type ReplayGuard } from './replay.js'
import { verifySignature } from './verify.js'

export const MAX_BODY_BYTES = 1024 * 1024

export interface Env {
  WEBHOOK_SECRET?: string
  APP_ID?: string
  PRIVATE_KEY?: string
}

export interface WebhookEvent {
  event: string
  delivery: string
  payload: unknown
}

export interface WebhookDeps {
  replay?: ReplayGuard
  /** Called only after signature, replay and JSON checks pass. U6 plugs in here. */
  onEvent?: (e: WebhookEvent) => Promise<void>
}

const defaultReplay = createReplayGuard()
const DENY = (): Response => new Response(null, { status: 401 })

async function readCapped(request: Request, max: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = request.headers.get('content-length')
  if (declared !== null && !(Number(declared) <= max)) return null
  if (!request.body) return new Uint8Array(0)
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let o = 0
  for (const c of chunks) {
    out.set(c, o)
    o += c.byteLength
  }
  return out
}

/**
 * POST /webhook. Order matters: cheap checks first, HMAC over the raw bytes
 * before any parsing, delivery id recorded only after the signature is good
 * (so unauthenticated callers cannot poison the dedupe window). Every
 * verification failure is a bare 401. Nothing here logs.
 */
export async function handleWebhook(request: Request, env: Env, deps: WebhookDeps = {}): Promise<Response> {
  const url = new URL(request.url)
  if (url.pathname !== '/webhook') return new Response(null, { status: 404 })
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
  if (!env.WEBHOOK_SECRET) return new Response(null, { status: 500 })

  const type = (request.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase()
  if (type !== 'application/json') return DENY()

  const delivery = request.headers.get('x-github-delivery')
  if (!delivery || delivery.length > 128) return DENY()

  const body = await readCapped(request, MAX_BODY_BYTES)
  if (!body) return DENY()

  if (!(await verifySignature(env.WEBHOOK_SECRET, body, request.headers.get('x-hub-signature-256')))) return DENY()

  const replay = deps.replay ?? defaultReplay
  if (replay.seen(delivery)) return DENY()

  let payload: unknown
  try {
    payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body))
  } catch {
    return new Response(null, { status: 400 })
  }

  if (deps.onEvent) {
    try {
      await deps.onEvent({ event: request.headers.get('x-github-event') ?? '', delivery, payload })
    } catch {
      // The event was not processed — release the delivery id so GitHub's
      // redelivery of the same X-GitHub-Delivery is not denied as a replay.
      replay.forget(delivery)
      return new Response(null, { status: 500 }) // detail deliberately dropped
    }
  }
  return new Response(null, { status: 202 })
}
