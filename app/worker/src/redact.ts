const PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(?:ghs|ghp|gho|ghu|ghr)_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{10,}/g,
  /\beyJ[\w-]*\.[\w-]+\.[\w-]*/g, // JWT-shaped (App JWTs, OIDC)
  /\bBearer\s+[^\s"',;]+/gi,
  /\bsha256=[0-9a-f]{64}\b/g,
]

/** Scrub credential-shaped strings, plus any exact secret values the caller knows. */
export function redact(text: string, secrets: readonly (string | undefined)[] = []): string {
  let out = text
  for (const s of secrets) if (s && s.length >= 6) out = out.split(s).join('[REDACTED]')
  for (const re of PATTERNS) out = out.replace(re, '[REDACTED]')
  return out
}
