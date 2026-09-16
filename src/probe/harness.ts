import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Test-harness detection + result classification for the B.2 probe lane
 * (KTD3). v1 is deliberately Node-only: vitest, jest, and `node --test`.
 *
 * Two implementation details carry the weight:
 *  - Positional file args are *filters* intersected with the consumer's
 *    configured include/testMatch/roots, so probes must live where the
 *    runner already looks (the queue writes them beside an exemplar test).
 *  - Invocations bypass `npx` — as `nobody` on a read-only root there is no
 *    writable HOME, so the installed binary is invoked directly and each
 *    runner's cache is redirected into the /tmp tmpfs.
 */

export type ProbeOutcome = 'failed-test' | 'load-error' | 'not-collected' | 'clean'

export interface Harness {
  kind: 'vitest' | 'jest' | 'node-test'
  /** In-container argv running exactly one probe file (path relative to /work). */
  runCmd(probeRelPath: string): string[]
  /** Map captured output to the report vocabulary. */
  classify(res: { exitCode: number; stdout: string; stderr: string }): ProbeOutcome
}

/**
 * Load-failure signatures are checked BEFORE test-failure summaries — a
 * suite that can't import (vitest counts it as "Test Files 1 failed", TAP
 * emits "not ok") must never classify as failed-test, and the exit code
 * binds the result: probe output is attacker-printable, so a forged
 * "N failed" line on a clean exit still classifies clean.
 */
const LOAD_ERROR_RE = /Cannot find module|ERR_UNKNOWN_FILE_EXTENSION|ERR_MODULE_NOT_FOUND|Failed to load|SyntaxError/

const vitestHarness: Harness = {
  kind: 'vitest',
  runCmd: (file) => ['node', 'node_modules/vitest/vitest.mjs', 'run', file],
  classify: ({ exitCode, stdout, stderr }) => {
    const out = `${stdout}\n${stderr}`
    if (exitCode === 0) return 'clean'
    if (LOAD_ERROR_RE.test(out)) return 'load-error'
    if (/no test files? found/i.test(out)) return 'not-collected'
    if (/test files?\s+\d+ failed|tests\s+\d+ failed/i.test(out)) return 'failed-test'
    return 'load-error'
  },
}

const jestHarness: Harness = {
  kind: 'jest',
  runCmd: (file) => [
    'node',
    'node_modules/jest-cli/bin/jest.js',
    '--runTestsByPath',
    '--cacheDirectory=/tmp/jest',
    file,
  ],
  classify: ({ exitCode, stdout, stderr }) => {
    const out = `${stdout}\n${stderr}`
    if (exitCode === 0) return 'clean'
    if (LOAD_ERROR_RE.test(out)) return 'load-error'
    if (/no tests found/i.test(out)) return 'not-collected'
    if (/tests:\s+\d+ failed/i.test(out)) return 'failed-test'
    return 'load-error'
  },
}

/**
 * `node --test` in a TS repo only works because `scripts.test` carries the
 * loader flags (`--import tsx`, `--experimental-strip-types`, `--loader`) —
 * capture them verbatim or the authored .ts probe dies with
 * ERR_UNKNOWN_FILE_EXTENSION. Both `--import tsx` and `--import=tsx` forms.
 */
const NODE_TEST_FLAG_RE =
  /(?:--import|--loader)(?:[\s=])\S+|--experimental-(?:strip|transform)-types/g

function nodeTestHarness(flags: string[]): Harness {
  return {
    kind: 'node-test',
    // --test-reporter=tap pins the format `classify` parses — Node ≥22
    // defaults to the spec reporter (`✖`, not TAP `not ok`) when stdout
    // is a TTY, and real failures would fall through to load-error.
    runCmd: (file) => ['node', ...flags, '--test', '--test-reporter=tap', file],
    classify: ({ exitCode, stdout, stderr }) => {
      const out = `${stdout}\n${stderr}`
      if (exitCode === 0) return 'clean'
      if (LOAD_ERROR_RE.test(out)) return 'load-error'
      if (/^not ok/im.test(out)) return 'failed-test'
      return 'load-error'
    },
  }
}

interface PackageJson {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  scripts?: Record<string, string>
}

/**
 * Detect the consumer's test harness from package.json. Returns undefined
 * when no supported harness exists — the probe lane degrades to a detail
 * note, not a failure.
 */
export async function detectHarness(cwd: string): Promise<Harness | undefined> {
  let pkg: PackageJson
  try {
    pkg = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8')) as PackageJson
  } catch {
    return undefined
  }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies }
  const testScript = pkg.scripts?.test ?? ''

  if (deps['vitest'] !== undefined || /\bvitest\b/.test(testScript)) return vitestHarness
  if (deps['jest'] !== undefined || /\bjest\b/.test(testScript)) return jestHarness
  if (/\bnode\b.*--test|node:test/.test(testScript)) {
    const flags = testScript.match(NODE_TEST_FLAG_RE)?.flatMap((f) => f.split(/[\s=]+/)) ?? []
    return nodeTestHarness(flags)
  }
  return undefined
}
