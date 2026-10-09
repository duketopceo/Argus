import { readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git'])
// `*.test.ts` outside tests/ is invisible to `npm test` — vitest only globs
// tests/**. Every other *.test.ts file must be on this allowlist with a
// reason, or it silently never runs (a green suite covering nothing).
// To add one: either move it under tests/, or extend this list with a
// comment naming the runner that executes it.
const NON_VITEST_DIRS = [
  'app/worker/test/', // standalone package, runs in the `worker` CI job
  'e2e/', // td-DSL files for `argus run` (testsDir), never vitest
  'evals/', // td-DSL eval suite, run by evals/run.mjs
  'examples/', // consumer-example td-DSL files
  'fixtures/', // td-DSL files captured inside demo fixtures
  'tests/fixtures/', // fixture payloads named *.test.ts, never executed
]

function walk(dir) {
  const out = []
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      if (!SKIP_DIRS.has(ent.name) && !ent.name.startsWith('.')) out.push(...walk(join(dir, ent.name)))
    } else if (ent.name.endsWith('.test.ts')) {
      out.push(join(dir, ent.name))
    }
  }
  return out
}

describe('test-glob coverage invariant', () => {
  it('every *.test.ts outside tests/ is a documented non-vitest target', () => {
    const stray = walk(ROOT)
      .map((p) => relative(ROOT, p).split(sep).join('/'))
      .filter((p) => !p.startsWith('tests/'))
      .filter((p) => !NON_VITEST_DIRS.some((dir) => p.startsWith(dir)))
    expect(
      stray,
      `*.test.ts files outside tests/** run under no runner — move under tests/ or allowlist in NON_VITEST_DIRS: ${stray.join(', ')}`,
    ).toEqual([])
  })

  it('the vitest glob itself is non-empty', () => {
    expect(walk(join(ROOT, 'tests')).length).toBeGreaterThan(0)
  })
})
