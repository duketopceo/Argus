import { generateKeyPairSync, verify as nodeVerify, type KeyObject } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  createAppJwt,
  importPrivateKey,
  getInstallationToken,
  redact,
  INSTALLATION_PERMISSIONS,
  GitHubAuthError,
} from '../src/auth.js'

// Throwaway key generated at test runtime; never written to disk or committed.
const kp = generateKeyPairSync('rsa', { modulusLength: 2048 })
const pkcs8 = kp.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
const pkcs1 = kp.privateKey.export({ type: 'pkcs1', format: 'pem' }) as string

const b64u = (s: string) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'))

describe('importPrivateKey', () => {
  it('imports PKCS#8', async () => {
    const k = await importPrivateKey(pkcs8)
    expect(k.type).toBe('private')
    expect(k.extractable).toBe(false)
  })
  it("imports GitHub's PKCS#1 download format", async () => {
    const k = await importPrivateKey(pkcs1)
    expect(k.type).toBe('private')
  })
  it('accepts a secret with escaped newlines', async () => {
    const k = await importPrivateKey(pkcs8.replace(/\n/g, '\\n'))
    expect(k.type).toBe('private')
  })
  it('rejects garbage without echoing it', async () => {
    const bad = '-----BEGIN PRIVATE KEY-----\nQUJDREVGR0hJSktMTU5PUA==\n-----END PRIVATE KEY-----'
    const err = await importPrivateKey(bad).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GitHubAuthError)
    expect(String((err as Error).message)).not.toContain('QUJDREVG')
    await expect(importPrivateKey('nope')).rejects.toBeInstanceOf(GitHubAuthError)
  })
})

describe('createAppJwt', () => {
  const now = 1_800_000_000
  it('has RS256 header and correct claims', async () => {
    const jwt = await createAppJwt('12345', await importPrivateKey(pkcs8), now)
    const [h, p] = jwt.split('.') as [string, string, string]
    expect(b64u(h)).toEqual({ alg: 'RS256', typ: 'JWT' })
    const claims = b64u(p)
    expect(claims.iss).toBe('12345')
    expect(claims.iat).toBe(now - 60)
    expect(claims.exp).toBeGreaterThan(now)
    expect(claims.exp - now).toBeLessThan(600)
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600)
  })
  it('signature verifies with the public key (and not a tampered payload)', async () => {
    const jwt = await createAppJwt('12345', await importPrivateKey(pkcs1), now)
    const [h, p, s] = jwt.split('.') as [string, string, string]
    const pub: KeyObject = kp.publicKey
    expect(nodeVerify('sha256', Buffer.from(`${h}.${p}`), pub, Buffer.from(s, 'base64url'))).toBe(true)
    expect(nodeVerify('sha256', Buffer.from(`${h}.${p}x`), pub, Buffer.from(s, 'base64url'))).toBe(false)
  })
  it('rejects a non-numeric app id', async () => {
    await expect(createAppJwt('12;3', await importPrivateKey(pkcs8), now)).rejects.toBeInstanceOf(GitHubAuthError)
  })
})

describe('getInstallationToken', () => {
  const TOKEN = 'ghs_' + 'A1b2C3d4'.repeat(5)
  const env = { APP_ID: '4242', PRIVATE_KEY: pkcs8 }
  type Call = { url: string; init: RequestInit }
  function mockFetch(status: number, body: unknown, calls: Call[]): typeof fetch {
    return (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
  }
  const ok = {
    token: TOKEN,
    expires_at: '2026-10-04T12:00:00Z',
    permissions: { metadata: 'read', contents: 'write', pull_requests: 'write', workflows: 'write' },
    repository_selection: 'selected',
    repositories: [{ name: 'repo' }],
  }

  it('restricts repositories to the single repo and requests minimal permissions', async () => {
    const calls: Call[] = []
    const res = await getInstallationToken(env, { installationId: 99, owner: 'octo', repo: 'repo' }, { fetch: mockFetch(201, ok, calls), now: () => 1_800_000_000 })
    expect(res.token).toBe(TOKEN)
    expect(calls).toHaveLength(1)
    const c = calls[0]!
    expect(c.url).toBe('https://api.github.com/app/installations/99/access_tokens')
    expect(c.init.method).toBe('POST')
    const body = JSON.parse(c.init.body as string)
    expect(body).toEqual({ repositories: ['repo'], permissions: INSTALLATION_PERMISSIONS })
    expect(INSTALLATION_PERMISSIONS).toEqual({ metadata: 'read', contents: 'write', pull_requests: 'write', workflows: 'write' })
    const h = new Headers(c.init.headers)
    expect(h.get('authorization')).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/)
    expect(h.get('user-agent')).toBeTruthy()
    expect(h.get('x-github-api-version')).toBe('2022-11-28')
  })
  it('never requests secrets, actions, checks or OpenRouter anything', () => {
    expect(Object.keys(INSTALLATION_PERMISSIONS).sort()).toEqual(['contents', 'metadata', 'pull_requests', 'workflows'])
  })
  it('validates owner/repo/installation before any request', async () => {
    const calls: Call[] = []
    const f = mockFetch(201, ok, calls)
    for (const bad of [
      { installationId: 0, owner: 'o', repo: 'r' },
      { installationId: 1.5, owner: 'o', repo: 'r' },
      { installationId: 1, owner: 'o/x', repo: 'r' },
      { installationId: 1, owner: 'o', repo: '../r' },
      { installationId: 1, owner: 'o', repo: '' },
    ]) {
      await expect(getInstallationToken(env, bad, { fetch: f })).rejects.toBeInstanceOf(GitHubAuthError)
    }
    expect(calls).toHaveLength(0)
  })
  it('refuses a token whose scope is broader than requested', async () => {
    const wide = { ...ok, repositories: [{ name: 'repo' }, { name: 'other' }] }
    await expect(getInstallationToken(env, { installationId: 1, owner: 'o', repo: 'repo' }, { fetch: mockFetch(201, wide, []) })).rejects.toBeInstanceOf(GitHubAuthError)
    const perm = { ...ok, permissions: { ...ok.permissions, secrets: 'write' } }
    await expect(getInstallationToken(env, { installationId: 1, owner: 'o', repo: 'repo' }, { fetch: mockFetch(201, perm, []) })).rejects.toBeInstanceOf(GitHubAuthError)
  })
  it('redacts tokens, JWTs and key material in error paths', async () => {
    const calls: Call[] = []
    const leaky = { message: `bad creds ${TOKEN} Bearer eyJhbGciOi.eyJpc3MiOi.c2ln -----BEGIN PRIVATE KEY-----\nQUJD\n-----END PRIVATE KEY-----` }
    const err = (await getInstallationToken(env, { installationId: 1, owner: 'o', repo: 'r' }, { fetch: mockFetch(401, leaky, calls) }).catch((e: unknown) => e)) as Error
    expect(err).toBeInstanceOf(GitHubAuthError)
    const text = `${err.message}\n${err.stack}\n${JSON.stringify(err)}`
    expect(text).not.toContain(TOKEN)
    expect(text).not.toContain('eyJhbGciOi')
    expect(text).not.toContain('QUJD')
    expect(text).not.toContain('BEGIN PRIVATE')
    expect(err.message).toContain('401')
  })
  it('redacts on network failure too, and never logs the token', async () => {
    const logs: string[] = []
    const orig = { log: console.log, error: console.error, warn: console.warn }
    for (const k of Object.keys(orig) as (keyof typeof orig)[]) console[k] = (...a: unknown[]) => void logs.push(a.join(' '))
    const boom = (async () => {
      throw new Error(`socket reset while sending ${TOKEN}`)
    }) as unknown as typeof fetch
    try {
      const err = (await getInstallationToken(env, { installationId: 1, owner: 'o', repo: 'r' }, { fetch: boom }).catch((e: unknown) => e)) as Error
      expect(err.message).not.toContain(TOKEN)
      await getInstallationToken(env, { installationId: 1, owner: 'o', repo: 'repo' }, { fetch: mockFetch(201, ok, []) })
    } finally {
      Object.assign(console, orig)
    }
    expect(logs.join('\n')).not.toContain(TOKEN)
  })
  it('fails when APP_ID or PRIVATE_KEY is missing', async () => {
    await expect(getInstallationToken({ APP_ID: '1' }, { installationId: 1, owner: 'o', repo: 'r' }, { fetch: mockFetch(201, ok, []) })).rejects.toBeInstanceOf(GitHubAuthError)
  })
})

describe('redact', () => {
  it('scrubs all GitHub token prefixes, JWTs, bearer headers, PEM blocks, and extra secrets', () => {
    const s = 'a ghs_abcdefghijklmnopqrstuvwxyz0123456789 b ghp_abcdefghijklmnopqrstuvwxyz0123456789 c github_pat_11AAAA_bbbbbbbbbbbbbbbbbbbb d eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiIxIn0.c2lnbmF0dXJl e Bearer abc.def f MYSECRET'
    const out = redact(s, ['MYSECRET'])
    expect(out).not.toMatch(/ghs_|ghp_|github_pat_|eyJ|Bearer abc|MYSECRET/)
    expect(out).toContain('[REDACTED]')
  })
})
