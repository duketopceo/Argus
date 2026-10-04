import { describe, expect, it } from 'vitest'
import { handleWebhook, MAX_BODY_BYTES, createReplayGuard, signatureFor, verifySignature } from '../src/index.js'

// Published by GitHub: docs.github.com "Validating webhook deliveries".
const DOC_SECRET = "It's a Secret to Everybody"
const DOC_PAYLOAD = 'Hello, World!'
const DOC_SIG = 'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17'

const SECRET = 'test-webhook-secret'
const env = { WEBHOOK_SECRET: SECRET }

async function req(body: string, opts: { sig?: string | null; type?: string | null; delivery?: string | null; method?: string; path?: string } = {}) {
  const headers = new Headers()
  if (opts.type !== null) headers.set('content-type', opts.type ?? 'application/json')
  if (opts.sig !== null) headers.set('x-hub-signature-256', opts.sig ?? (await signatureFor(SECRET, body)))
  if (opts.delivery !== null) headers.set('x-github-delivery', opts.delivery ?? crypto.randomUUID())
  headers.set('x-github-event', 'ping')
  const init: RequestInit = { method: opts.method ?? 'POST', headers }
  if ((opts.method ?? 'POST') === 'POST') init.body = body
  return new Request('https://worker.example' + (opts.path ?? '/webhook'), init)
}

describe('verifySignature', () => {
  it('accepts the published GitHub test vector', async () => {
    expect(await verifySignature(DOC_SECRET, new TextEncoder().encode(DOC_PAYLOAD), DOC_SIG)).toBe(true)
    expect(await signatureFor(DOC_SECRET, DOC_PAYLOAD)).toBe(DOC_SIG)
  })
  it('rejects a tampered body', async () => {
    expect(await verifySignature(DOC_SECRET, new TextEncoder().encode('Hello, World?'), DOC_SIG)).toBe(false)
  })
  it('rejects malformed headers without throwing', async () => {
    const b = new TextEncoder().encode(DOC_PAYLOAD)
    for (const bad of ['', 'sha256=', 'sha1=abc', DOC_SIG.toUpperCase(), DOC_SIG.slice(0, -2), DOC_SIG + '00', 'sha256=zz' + DOC_SIG.slice(9)]) {
      expect(await verifySignature(DOC_SECRET, b, bad)).toBe(false)
    }
  })
})

describe('handleWebhook', () => {
  it('accepts a valid delivery (202) and passes the event to the handler', async () => {
    const seen: unknown[] = []
    const res = await handleWebhook(await req('{"zen":"x"}', { delivery: 'd-1' }), env, { onEvent: async (e) => void seen.push(e) })
    expect(res.status).toBe(202)
    expect(seen).toEqual([{ event: 'ping', delivery: 'd-1', payload: { zen: 'x' } }])
  })
  it('401 on tampered body', async () => {
    const r = await req('{"a":1}', { sig: await signatureFor(SECRET, '{"a":2}') })
    expect((await handleWebhook(r, env)).status).toBe(401)
  })
  it('401 on missing signature header', async () => {
    expect((await handleWebhook(await req('{}', { sig: null }), env)).status).toBe(401)
  })
  it('401 on wrong signature secret', async () => {
    expect((await handleWebhook(await req('{}', { sig: await signatureFor('other', '{}') }), env)).status).toBe(401)
  })
  it('401 on wrong content type, including form-encoded', async () => {
    for (const type of ['application/x-www-form-urlencoded', 'text/plain', null]) {
      expect((await handleWebhook(await req('{}', { type }), env)).status).toBe(401)
    }
  })
  it('accepts application/json with a charset parameter', async () => {
    expect((await handleWebhook(await req('{}', { type: 'application/json; charset=utf-8' }), env)).status).toBe(202)
  })
  it('401 on oversize body even when correctly signed', async () => {
    const big = '{"x":"' + 'a'.repeat(MAX_BODY_BYTES) + '"}'
    expect((await handleWebhook(await req(big), env)).status).toBe(401)
  })
  it('401 on oversize body with a lying/absent content-length (stream cap)', async () => {
    const big = '{"x":"' + 'a'.repeat(MAX_BODY_BYTES) + '"}'
    const r = await req(big)
    r.headers.delete('content-length')
    expect((await handleWebhook(r, env)).status).toBe(401)
  })
  it('401 on missing delivery id', async () => {
    expect((await handleWebhook(await req('{}', { delivery: null }), env)).status).toBe(401)
  })
  it('401 on a replayed delivery, but only after the first was accepted', async () => {
    const replay = createReplayGuard()
    const deps = { replay }
    expect((await handleWebhook(await req('{}', { delivery: 'same' }), env, deps)).status).toBe(202)
    expect((await handleWebhook(await req('{}', { delivery: 'same' }), env, deps)).status).toBe(401)
    expect((await handleWebhook(await req('{}', { delivery: 'other' }), env, deps)).status).toBe(202)
  })
  it('does not burn a delivery id on an unsigned request', async () => {
    const replay = createReplayGuard()
    expect((await handleWebhook(await req('{}', { delivery: 'x', sig: 'sha256=' + '0'.repeat(64) }), env, { replay })).status).toBe(401)
    expect((await handleWebhook(await req('{}', { delivery: 'x' }), env, { replay })).status).toBe(202)
  })
  it('does not burn a delivery id when the event handler fails — redelivery is accepted', async () => {
    const replay = createReplayGuard()
    let calls = 0
    const onEvent = async () => {
      calls++
      if (calls === 1) throw new Error('transient')
    }
    expect((await handleWebhook(await req('{}', { delivery: 'd-5' }), env, { replay, onEvent })).status).toBe(500)
    // GitHub redelivers the same X-GitHub-Delivery; it must not 401 as a replay.
    expect((await handleWebhook(await req('{}', { delivery: 'd-5' }), env, { replay, onEvent })).status).toBe(202)
    expect(calls).toBe(2)
  })
  it('replay guard expires entries and bounds memory', () => {
    let t = 0
    const g = createReplayGuard({ ttlMs: 1000, maxEntries: 2, now: () => t })
    expect(g.seen('a')).toBe(false)
    expect(g.seen('a')).toBe(true)
    t = 1001
    expect(g.seen('a')).toBe(false)
    g.seen('b')
    g.seen('c')
    expect(g.size()).toBeLessThanOrEqual(2)
  })
  it('404/405 for other paths and methods', async () => {
    expect((await handleWebhook(await req('{}', { path: '/other' }), env)).status).toBe(404)
    expect((await handleWebhook(await req('', { method: 'GET' }), env)).status).toBe(405)
  })
  it('fails closed (500) when WEBHOOK_SECRET is unset', async () => {
    expect((await handleWebhook(await req('{}'), {})).status).toBe(500)
  })
  it('400 on validly signed non-JSON', async () => {
    expect((await handleWebhook(await req('not json'), env)).status).toBe(400)
  })
  it('never logs bodies or secrets', async () => {
    const logs: string[] = []
    const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info }
    for (const k of Object.keys(orig) as (keyof typeof orig)[]) console[k] = (...a: unknown[]) => void logs.push(a.join(' '))
    try {
      await handleWebhook(await req('{"secretish":"BODYMARK"}', { sig: 'sha256=' + '0'.repeat(64) }), env)
      await handleWebhook(await req('{"secretish":"BODYMARK"}'), env)
    } finally {
      Object.assign(console, orig)
    }
    expect(logs.join('\n')).not.toMatch(/BODYMARK|test-webhook-secret/)
  })
})
