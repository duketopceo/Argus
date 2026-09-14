// Clean-install consumer smoke test: pack argus-reviewer-e2e, install it into
// fresh consumer projects (CommonJS default and ESM), and verify the generated
// TypeScript config loads. Catches the 0.1.0 class of bug where a consumer's
// package module type broke `.ts` config loading.
//
// Usage: node scripts/consumer-smoke.mjs <path-to-tarball>

import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const tarball = resolve(process.argv[2] ?? '')
if (!process.argv[2]) {
  console.error('usage: node scripts/consumer-smoke.mjs <tarball>')
  process.exit(2)
}

const MODULE_ERRORS = [
  'Cannot use import statement',
  "Cannot find package 'argus-reviewer-e2e'",
  'ERR_UNKNOWN_FILE_EXTENSION',
  'ERR_MODULE_NOT_FOUND',
]

function run(cmd, args, cwd, env = {}) {
  try {
    const out = execFileSync(cmd, args, {
      cwd,
      env: { ...process.env, ...env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { code: 0, out }
  } catch (err) {
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

function assertConfigLoads(cwd, label, env = {}) {
  // `code-review` loads config, then cleanly skips without repo/pr context.
  // Exit 0 + "skipping" proves the generated .ts config parsed and imported.
  const res = run('npx', ['argus-reviewer', 'code-review'], cwd, env)
  for (const marker of MODULE_ERRORS) {
    if (res.out.includes(marker)) {
      console.error(`FAIL ${label}: config load hit module error — ${marker}`)
      console.error(res.out.slice(0, 2000))
      process.exit(1)
    }
  }
  if (res.code !== 0 || !res.out.includes('skipping')) {
    console.error(`FAIL ${label}: expected clean code-review skip, got exit ${res.code}`)
    console.error(res.out.slice(0, 2000))
    process.exit(1)
  }
  console.log(`PASS ${label}: config loads, code-review skips cleanly`)
}

for (const moduleType of ['commonjs', 'module']) {
  const dir = mkdtempSync(join(tmpdir(), `argus-consumer-${moduleType}-`))
  const pkg = { name: 'consumer', version: '0.0.0' }
  if (moduleType === 'module') pkg.type = 'module'
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2))

  const install = run('npm', ['install', tarball, '--no-audit', '--no-fund'], dir)
  if (install.code !== 0) {
    console.error(`FAIL ${moduleType}: npm install tarball`)
    console.error(install.out.slice(0, 2000))
    process.exit(1)
  }

  const init = run('npx', ['argus-reviewer', 'init'], dir)
  if (init.code !== 0) {
    console.error(`FAIL ${moduleType}: init`)
    console.error(init.out.slice(0, 2000))
    process.exit(1)
  }

  assertConfigLoads(dir, moduleType)

  // Leg 2: disable module-syntax detection — the context where the 0.1.0
  // config-load bug bites (Node treats the typeless package as CommonJS and
  // native .ts import either errors or falls into a require(esm) cycle).
  if (moduleType === 'commonjs') {
    assertConfigLoads(dir, 'commonjs/no-detect', {
      NODE_OPTIONS: '--no-experimental-detect-module',
    })
  }
}

console.log('consumer smoke: all checks passed')
