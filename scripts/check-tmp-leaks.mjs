#!/usr/bin/env node
/**
 * Runs the vitest suite (or the args given) against the REAL OS tmpdir and
 * fails if it left any new entries behind. The suite's global setup redirects
 * TMPDIR to a per-run root it deletes, so the expected diff is empty.
 *
 *   node scripts/check-tmp-leaks.mjs [vitest args...]
 */
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'

const snap = () => new Set(readdirSync(tmpdir()))
const before = snap()
// Spawn the vitest JS entry with this Node — `npx` is a .cmd shim that
// cannot be spawned without a shell on Windows.
const vitest = createRequire(import.meta.url).resolve('vitest/vitest.mjs')
const r = spawnSync(process.execPath, [vitest, 'run', ...process.argv.slice(2)], { stdio: 'inherit' })
const leaked = [...snap()].filter((n) => !before.has(n) && /^(argus|nanoid|idx-|render-brand)/i.test(n))
if (leaked.length > 0) {
  console.error(`tmp leak: ${leaked.length} new entries in ${tmpdir()}:\n  ${leaked.slice(0, 20).join('\n  ')}`)
  process.exit(1)
}
console.log(`no tmp leaks (${tmpdir()})`)
process.exit(r.status ?? 1)
