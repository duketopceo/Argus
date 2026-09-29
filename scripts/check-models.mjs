#!/usr/bin/env node
/**
 * Verify every OpenRouter slug documented in docs/models.md still exists in
 * the live catalog. Runs weekly via .github/workflows/model-catalog.yml —
 * the "verified" table must not silently rot when OpenRouter renames or
 * retires a model.
 *
 * The catalog endpoint is public (no key). Slugs are extracted from
 * backticked `owner/model` spans, so prose backticks like `code_model`
 * (no slash) never match.
 */
import { readFile } from 'node:fs/promises'

const DOC = new URL('../docs/models.md', import.meta.url)
// owner/model with optional :variant — model part carries no '/', so a
// backticked path like `src/review/packs.ts` can't parse as a slug.
const SLUG = /`([a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*)`/gi
// Jev adjudication slugs resolve on the typesafe Decisions API, not the
// OpenRouter catalog — there is nothing for this check to verify.
const SKIP_PREFIXES = ['typesafe/']

const md = await readFile(DOC, 'utf8')
const slugs = [
  ...new Set(
    [...md.matchAll(SLUG)]
      .map((m) => m[1])
      .filter((s) => !SKIP_PREFIXES.some((p) => s.startsWith(p))),
  ),
]
if (slugs.length === 0) {
  console.error('check-models: no slugs found in docs/models.md — the extraction regex is broken')
  process.exit(1)
}

const res = await fetch('https://openrouter.ai/api/v1/models')
if (!res.ok) {
  console.error(`check-models: OpenRouter /models returned ${res.status}`)
  process.exit(1)
}
const { data } = await res.json()
const live = new Set((data ?? []).map((m) => m.id))

let failed = false
for (const slug of slugs) {
  // `slug:variant` (e.g. `:free`) — the catalog lists the base id.
  const base = slug.split(':')[0]
  if (live.has(base)) {
    console.log(`  ok      ${slug}`)
  } else {
    console.error(`  MISSING ${slug} — update docs/models.md`)
    failed = true
  }
}
process.exit(failed ? 1 : 0)
