const enc = new TextEncoder()
const SIG_RE = /^sha256=([0-9a-f]{64})$/

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

function hmacKey(secret: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage])
}

/**
 * Verify X-Hub-Signature-256 over the raw body bytes. Uses WebCrypto's
 * HMAC verify, which compares in constant time. Never throws.
 */
export async function verifySignature(secret: string, body: Uint8Array<ArrayBuffer>, header: string | null): Promise<boolean> {
  if (!secret || !header) return false
  const m = SIG_RE.exec(header)
  if (!m || !m[1]) return false
  try {
    const key = await hmacKey(secret, 'verify')
    return await crypto.subtle.verify('HMAC', key, hexToBytes(m[1]), body)
  } catch {
    return false
  }
}

/** Compute the header value GitHub would send (used by tests and tooling). */
export async function signatureFor(secret: string, body: string | Uint8Array<ArrayBuffer>): Promise<string> {
  const key = await hmacKey(secret, 'sign')
  const data: Uint8Array<ArrayBuffer> = typeof body === 'string' ? enc.encode(body) : body
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, data))
  return 'sha256=' + Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('')
}
