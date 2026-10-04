#!/usr/bin/env node
// GitHub App manifest for the Argus onboarding Worker (docs/self-host-app.md).
// No dependencies, no network, no secrets: it only prints JSON or writes a
// local HTML form that you open in your own browser to run GitHub's manifest
// flow. Nothing here creates an App by itself.
//
//   node app/register/manifest.mjs --worker-url https://argus.example.com
//   node app/register/manifest.mjs --worker-url https://argus.example.com --html register.html [--org my-org]

import { writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const HOMEPAGE_URL = 'https://github.com/duketopceo/Argus'
export const DEFAULT_REDIRECT_URL = 'http://localhost:3000/argus-registered'
export const DEFAULT_EVENTS = ['installation', 'installation_repositories']
// Must stay equal to INSTALLATION_PERMISSIONS in app/worker/src/auth.ts
// (tests/unit/github-app-manifest.test.ts enforces it).
export const DEFAULT_PERMISSIONS = {
  metadata: 'read',
  contents: 'write',
  pull_requests: 'write',
  workflows: 'write',
}

/** Validate the Worker's public https origin and return `<origin>/webhook`. */
export function webhookUrl(workerUrl) {
  let u
  try {
    u = new URL(workerUrl)
  } catch {
    throw new Error(`--worker-url is not a URL: ${workerUrl}`)
  }
  if (u.protocol !== 'https:') throw new Error('--worker-url must be https')
  if (u.username || u.password || u.search || u.hash) throw new Error('--worker-url must not carry credentials, a query or a fragment')
  const base = u.pathname.replace(/\/+$/, '')
  if (base.endsWith('/webhook')) throw new Error('--worker-url is the base URL; /webhook is added for you')
  return `${u.origin}${base}/webhook`
}

export function buildManifest({ workerUrl, name = 'argus-onboarding', redirectUrl = DEFAULT_REDIRECT_URL }) {
  if (name.length === 0 || name.length > 34) throw new Error('--name must be 1 to 34 characters')
  return {
    name,
    url: HOMEPAGE_URL,
    hook_attributes: { url: webhookUrl(workerUrl), active: true },
    redirect_url: redirectUrl,
    public: false,
    default_events: [...DEFAULT_EVENTS],
    default_permissions: { ...DEFAULT_PERMISSIONS },
  }
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function registrationForm(manifest, org) {
  if (org !== undefined && !/^[A-Za-z0-9-]+$/.test(org)) throw new Error('--org must be a GitHub organization login')
  const action = org ? `https://github.com/organizations/${org}/settings/apps/new` : 'https://github.com/settings/apps/new'
  return `<!doctype html>
<meta charset="utf-8">
<title>Register the Argus onboarding App</title>
<form method="post" action="${action}">
  <p>This posts the manifest to GitHub, which shows a confirmation page. Nothing is created until you click Create there.</p>
  <input type="hidden" name="manifest" value="${esc(JSON.stringify(manifest))}">
  <button type="submit">Continue to GitHub</button>
</form>
`
}

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const v = argv[i + 1]
    if (!a.startsWith('--') || v === undefined) throw new Error(`bad argument: ${a}`)
    out[a.slice(2)] = v
    i++
  }
  return out
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const a = parseArgs(process.argv.slice(2))
    if (!a['worker-url']) throw new Error('usage: manifest.mjs --worker-url https://<host> [--name N] [--redirect-url U] [--html FILE] [--org ORG]')
    const manifest = buildManifest({
      workerUrl: a['worker-url'],
      ...(a.name !== undefined && { name: a.name }),
      ...(a['redirect-url'] !== undefined && { redirectUrl: a['redirect-url'] }),
    })
    if (a.html) {
      writeFileSync(a.html, registrationForm(manifest, a.org))
      console.error(`wrote ${a.html}; open it in your browser`)
    } else {
      console.log(JSON.stringify(manifest, null, 2))
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e))
    process.exit(2)
  }
}
