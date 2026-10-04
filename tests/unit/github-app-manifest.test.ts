import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// @ts-expect-error plain-node registration helper — no type declarations
import { buildManifest, registrationForm, webhookUrl } from '../../app/register/manifest.mjs'
import { INSTALLATION_PERMISSIONS } from '../../app/worker/src/auth.js'

const ROOT = join(import.meta.dirname, '../..')

describe('GitHub App manifest (U7)', () => {
  const m = buildManifest({ workerUrl: 'https://argus.example.com/' })

  it('subscribes only to installation events and points at <worker>/webhook', () => {
    expect(m.default_events).toEqual(['installation', 'installation_repositories'])
    expect(m.hook_attributes).toEqual({ url: 'https://argus.example.com/webhook', active: true })
    expect(m.public).toBe(false)
  })

  it('requests exactly the permissions the Worker mints tokens with', () => {
    expect(m.default_permissions).toEqual(INSTALLATION_PERMISSIONS)
  })

  it('never asks for secrets, actions, checks, administration or code-read beyond contents', () => {
    expect(Object.keys(m.default_permissions).sort()).toEqual(['contents', 'metadata', 'pull_requests', 'workflows'])
  })

  it('rejects non-https and decorated worker URLs', () => {
    for (const bad of ['http://x.dev', 'https://u:p@x.dev', 'https://x.dev/?a=1', 'https://x.dev/webhook', 'nope'])
      expect(() => webhookUrl(bad), bad).toThrow()
  })

  it('escapes the manifest into the form and validates --org', () => {
    const html = registrationForm(m)
    expect(html).toContain('action="https://github.com/settings/apps/new"')
    expect(html).not.toContain('value="{"')
    expect(registrationForm(m, 'my-org')).toContain('/organizations/my-org/settings/apps/new')
    expect(() => registrationForm(m, '../x')).toThrow()
  })

  it('docs state the same webhook path, events and the 3-repo cap', () => {
    const doc = readFileSync(join(ROOT, 'docs/self-host-app.md'), 'utf8')
    for (const s of ['installation_repositories', '/webhook', 'APP_ID', 'PRIVATE_KEY', 'WEBHOOK_SECRET', '45', 'init --pr'])
      expect(doc, s).toContain(s)
    expect(doc).not.toMatch(/openssl/i)
  })
})
