import { redact } from './redact.js'

export { redact } from './redact.js'

/**
 * Minimal permissions for the onboarding App (plan KTD4). `metadata: read` is
 * implicit on every installation token; `workflows: write` exists solely
 * because the onboarding PR writes under .github/workflows/. No secrets,
 * actions, checks or administration. Phase 3 checks live in a separate App.
 */
export const INSTALLATION_PERMISSIONS = {
  metadata: 'read',
  contents: 'write',
  pull_requests: 'write',
  workflows: 'write',
} as const

const API = 'https://api.github.com'
const NAME_RE = /^[A-Za-z0-9_.-]+$/
const enc = new TextEncoder()

export class GitHubAuthError extends Error {
  constructor(message: string, secrets: readonly (string | undefined)[] = []) {
    super(redact(message, secrets))
    this.name = 'GitHubAuthError'
  }
}

export interface AuthEnv {
  APP_ID?: string
  PRIVATE_KEY?: string
}

export interface AuthDeps {
  fetch?: typeof fetch
  /** Unix seconds. */
  now?: () => number
}

export interface InstallationTarget {
  installationId: number
  owner: string
  repo: string
}

export interface InstallationToken {
  token: string
  expiresAt: string
}

function b64u(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function derLen(n: number): number[] {
  if (n < 0x80) return [n]
  const bytes: number[] = []
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff)
  return [0x80 | bytes.length, ...bytes]
}

/** Wrap a PKCS#1 RSAPrivateKey (what GitHub downloads) as PKCS#8 for WebCrypto. */
function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array<ArrayBuffer> {
  const version = [0x02, 0x01, 0x00]
  const algId = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]
  const octet = [0x04, ...derLen(pkcs1.length)]
  const inner = version.length + algId.length + octet.length + pkcs1.length
  const head = [0x30, ...derLen(inner), ...version, ...algId, ...octet]
  const out = new Uint8Array(head.length + pkcs1.length)
  out.set(head, 0)
  out.set(pkcs1, head.length)
  return out
}

/** Import an App private key (PKCS#8, or GitHub's PKCS#1 PEM) as a non-extractable RS256 signing key. */
export async function importPrivateKey(pem: string): Promise<CryptoKey> {
  try {
    const text = pem.replace(/\\n/g, '\n')
    const m = /-----BEGIN (RSA )?PRIVATE KEY-----([\s\S]+?)-----END \1?PRIVATE KEY-----/.exec(text)
    if (!m) throw new Error('no PEM block')
    const der = Uint8Array.from(atob((m[2] ?? '').replace(/\s+/g, '')), (c) => c.charCodeAt(0))
    const pkcs8 = m[1] ? pkcs1ToPkcs8(der) : (der as Uint8Array<ArrayBuffer>)
    return await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
  } catch {
    // The underlying error can quote key material; drop it entirely.
    throw new GitHubAuthError('PRIVATE_KEY could not be imported (expected an RSA PEM, PKCS#8 or PKCS#1)')
  }
}

/** RS256 App JWT: iat backdated 60 s for clock skew, exp 9 min ahead (GitHub max is 10). */
export async function createAppJwt(appId: string, key: CryptoKey, nowSec: number = Math.floor(Date.now() / 1000)): Promise<string> {
  if (!/^\d+$/.test(appId)) throw new GitHubAuthError('APP_ID must be numeric')
  const header = b64u(enc.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })))
  const payload = b64u(enc.encode(JSON.stringify({ iat: nowSec - 60, exp: nowSec + 9 * 60, iss: appId })))
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(`${header}.${payload}`)))
  return `${header}.${payload}.${b64u(sig)}`
}

/**
 * Exchange the App JWT for an installation token scoped to ONE repository and
 * the minimal permission set. The token is returned to the caller and held
 * only in memory for the duration of one delivery: it is never cached,
 * persisted or logged, and every error path is redacted.
 */
export async function getInstallationToken(env: AuthEnv, target: InstallationTarget, deps: AuthDeps = {}): Promise<InstallationToken> {
  const secrets = [env.PRIVATE_KEY]
  const { installationId, owner, repo } = target
  if (!env.APP_ID || !env.PRIVATE_KEY) throw new GitHubAuthError('APP_ID and PRIVATE_KEY must be configured')
  if (!Number.isSafeInteger(installationId) || installationId <= 0) throw new GitHubAuthError('invalid installation id')
  if (!NAME_RE.test(owner) || !NAME_RE.test(repo) || repo === '.' || repo === '..') throw new GitHubAuthError('invalid owner/repo')

  const doFetch = deps.fetch ?? fetch
  const nowSec = deps.now ? deps.now() : Math.floor(Date.now() / 1000)
  const jwt = await createAppJwt(env.APP_ID, await importPrivateKey(env.PRIVATE_KEY), nowSec)
  const redactions = [...secrets, jwt]

  let res: Response
  try {
    res = await doFetch(`${API}/app/installations/${installationId}/access_tokens`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${jwt}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'user-agent': 'argus-app-worker',
        'x-github-api-version': '2022-11-28',
      },
      body: JSON.stringify({ repositories: [repo], permissions: INSTALLATION_PERMISSIONS }),
    })
  } catch (e) {
    throw new GitHubAuthError(`installation token request failed: ${e instanceof Error ? e.message : 'network error'}`, redactions)
  }

  const text = await res.text().catch(() => '')
  if (!res.ok) throw new GitHubAuthError(`installation token request returned ${res.status}: ${text.slice(0, 300)}`, redactions)

  let data: { token?: unknown; expires_at?: unknown; permissions?: Record<string, unknown>; repositories?: { name?: unknown }[] }
  try {
    data = JSON.parse(text)
  } catch {
    throw new GitHubAuthError('installation token response was not JSON', redactions)
  }
  const token = typeof data.token === 'string' ? data.token : ''
  const redactAll = [...redactions, token]
  if (!token || typeof data.expires_at !== 'string') throw new GitHubAuthError('installation token response malformed', redactAll)

  // Defense in depth: never hand back a token broader than we asked for.
  const granted = data.permissions ?? {}
  for (const k of Object.keys(granted)) {
    if (!(k in INSTALLATION_PERMISSIONS)) throw new GitHubAuthError(`token carries unrequested permission "${k}"`, redactAll)
  }
  if (data.repositories && (data.repositories.length !== 1 || data.repositories[0]?.name !== repo)) {
    throw new GitHubAuthError('token is not scoped to exactly the requested repository', redactAll)
  }
  return { token, expiresAt: data.expires_at }
}
