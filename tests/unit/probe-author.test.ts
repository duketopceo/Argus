import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  buildProbeMessages,
  parseProbe,
  probeImportsSafe,
  PROBE_CONTENT_CAP,
} from '../../src/probe/author.js'
import { detectHarness } from '../../src/probe/harness.js'

describe('detectHarness', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'argus-harness-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  const writePkg = (pkg: object) =>
    writeFile(join(dir, 'package.json'), JSON.stringify(pkg), 'utf8')

  it('detects vitest from devDeps and invokes the installed binary', async () => {
    await writePkg({ devDependencies: { vitest: '^3' } })
    const h = await detectHarness(dir)
    expect(h?.kind).toBe('vitest')
    expect(h?.runCmd('tests/x.test.ts')).toEqual([
      'node',
      'node_modules/vitest/vitest.mjs',
      'run',
      'tests/x.test.ts',
    ])
  })

  it('detects jest and bypasses collection filters with --runTestsByPath', async () => {
    await writePkg({ devDependencies: { jest: '^30' } })
    const h = await detectHarness(dir)
    expect(h?.kind).toBe('jest')
    expect(h?.runCmd('t/x.test.ts')).toContain('--runTestsByPath')
    expect(h?.runCmd('t/x.test.ts')).toContain('--cacheDirectory=/tmp/jest')
  })

  it('detects node --test and preserves loader flags from scripts.test', async () => {
    await writePkg({ scripts: { test: 'node --import tsx --test tests/' } })
    const h = await detectHarness(dir)
    expect(h?.kind).toBe('node-test')
    expect(h?.runCmd('t/x.test.ts')).toEqual(['node', '--import', 'tsx', '--test', 't/x.test.ts'])
  })

  it('parses loader flags in space and equals forms', async () => {
    await writePkg({ scripts: { test: 'node --import=tsx --experimental-strip-types --test' } })
    const h = await detectHarness(dir)
    expect(h?.runCmd('t/x.test.ts')).toEqual([
      'node',
      '--import',
      'tsx',
      '--experimental-strip-types',
      '--test',
      't/x.test.ts',
    ])
  })

  it('returns undefined when no supported harness exists', async () => {
    await writePkg({ scripts: { test: 'echo none' } })
    expect(await detectHarness(dir)).toBeUndefined()
    const missing = join(dir, 'nowhere')
    expect(await detectHarness(missing)).toBeUndefined()
  })
})

describe('harness classify', () => {
  const classifyOf = async (pkg: object, dir: string) => {
    await writeFile(join(dir, 'package.json'), JSON.stringify(pkg), 'utf8')
    return (await detectHarness(dir))!.classify
  }
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'argus-classify-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('vitest: failed test vs not-collected vs load-error vs clean', async () => {
    const classify = await classifyOf({ devDependencies: { vitest: '^3' } }, dir)
    expect(classify({ exitCode: 1, stdout: ' Test Files  1 failed (1)\n Tests  1 failed', stderr: '' })).toBe('failed-test')
    expect(classify({ exitCode: 1, stdout: '', stderr: 'No test files found, exiting with code 1' })).toBe('not-collected')
    expect(classify({ exitCode: 1, stdout: '', stderr: 'SyntaxError: bad' })).toBe('load-error')
    expect(classify({ exitCode: 0, stdout: ' Test Files  1 passed', stderr: '' })).toBe('clean')
  })

  it('jest: failed vs not-collected vs clean', async () => {
    const classify = await classifyOf({ devDependencies: { jest: '^30' } }, dir)
    expect(classify({ exitCode: 1, stdout: '', stderr: 'Tests:       1 failed, 2 passed' })).toBe('failed-test')
    expect(classify({ exitCode: 1, stdout: '', stderr: 'No tests found, exiting with code 1' })).toBe('not-collected')
    expect(classify({ exitCode: 0, stdout: '', stderr: 'Tests: 2 passed' })).toBe('clean')
  })

  it('node --test: TAP not ok vs extension load error', async () => {
    const classify = await classifyOf({ scripts: { test: 'node --test' } }, dir)
    expect(classify({ exitCode: 1, stdout: 'not ok 1 - boom\n# fail 1', stderr: '' })).toBe('failed-test')
    expect(classify({ exitCode: 1, stdout: '', stderr: 'ERR_UNKNOWN_FILE_EXTENSION' })).toBe('load-error')
    expect(classify({ exitCode: 0, stdout: 'ok 1\n# pass 1', stderr: '' })).toBe('clean')
  })

  it('a load failure that still prints failure counts classifies as load-error', async () => {
    // Vitest counts an unloadable suite as "Test Files 1 failed" — a probe
    // that can't import must never read as a reproduced test failure.
    const vitest = await classifyOf({ devDependencies: { vitest: '^3' } }, dir)
    expect(
      vitest({
        exitCode: 1,
        stdout: ' Test Files  1 failed (1)\n Tests  1 failed',
        stderr: 'Error: Cannot find module "./missing"',
      }),
    ).toBe('load-error')
    const nodeTest = await classifyOf({ scripts: { test: 'node --test' } }, dir)
    expect(
      nodeTest({ exitCode: 1, stdout: 'not ok 1 - probe\n# fail 1', stderr: 'SyntaxError: x' }),
    ).toBe('load-error')
  })

  it('exit 0 can never classify as a failure — probe output is attacker-printable', async () => {
    const vitest = await classifyOf({ devDependencies: { vitest: '^3' } }, dir)
    expect(vitest({ exitCode: 0, stdout: 'Tests  1 failed', stderr: '' })).toBe('clean')
    const jest = await classifyOf({ devDependencies: { jest: '^30' } }, dir)
    expect(jest({ exitCode: 0, stdout: '', stderr: 'Tests: 1 failed' })).toBe('clean')
    const nodeTest = await classifyOf({ scripts: { test: 'node --test' } }, dir)
    expect(nodeTest({ exitCode: 0, stdout: 'not ok 1 - forged', stderr: '' })).toBe('clean')
  })
})

describe('parseProbe', () => {
  const okProbe = JSON.stringify({
    filename: 'probe-a.test.ts',
    content: "import { f } from '../src/f'\nimport { describe, it } from 'vitest'\ndescribe('x',()=>{})",
    reasoning: 'asserts the correct bound',
  })

  it('accepts a well-formed probe', () => {
    const res = parseProbe(okProbe)
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.probe.filename).toBe('probe-a.test.ts')
      expect(res.probe.reasoning).toBe('asserts the correct bound')
    }
  })

  it('rejects traversal and non-test filenames before any write', () => {
    for (const bad of ['../../evil.test.ts', 'dir/x.test.ts', 'x.ts', '.test.ts', '/abs.test.ts']) {
      const res = parseProbe(JSON.stringify({ filename: bad, content: 'x', reasoning: '' }))
      expect(res.ok, bad).toBe(false)
    }
  })

  it('rejects oversized and empty content', () => {
    expect(
      parseProbe(JSON.stringify({ filename: 'p.test.ts', content: 'x'.repeat(PROBE_CONTENT_CAP + 1), reasoning: '' })).ok,
    ).toBe(false)
    expect(parseProbe(JSON.stringify({ filename: 'p.test.ts', content: '  ', reasoning: '' })).ok).toBe(false)
  })

  it('rejects probes that read secret-looking env vars', () => {
    const res = parseProbe(
      JSON.stringify({
        filename: 'p.test.ts',
        content: 'const k = process.env.OPENROUTER_API_KEY',
        reasoning: '',
      }),
    )
    expect(res.ok).toBe(false)
  })

  it('rejects absolute imports and unparseable output', () => {
    expect(
      parseProbe(JSON.stringify({ filename: 'p.test.ts', content: "import x from '/etc/passwd'", reasoning: '' })).ok,
    ).toBe(false)
    expect(parseProbe('not json').ok).toBe(false)
  })

  it('probeImportsSafe bounds relative imports to the write location', () => {
    const res = parseProbe(okProbe)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    // tests/ → ../src/f stays inside the repo
    expect(probeImportsSafe(res.probe, 'tests/argus-probe-a.test.ts')).toBe(true)
    // a repo-root probe has no parent — ../ escapes the checkout
    expect(probeImportsSafe(res.probe, 'argus-probe-a.test.ts')).toBe(false)
    const escaping = parseProbe(
      JSON.stringify({
        filename: 'p.test.ts',
        content: "import x from '../../../../etc/passwd'",
        reasoning: '',
      }),
    )
    expect(escaping.ok).toBe(true)
    if (escaping.ok) {
      expect(probeImportsSafe(escaping.probe, 'tests/argus-probe-p.test.ts')).toBe(false)
    }
  })
})

describe('buildProbeMessages', () => {
  const harness = { kind: 'vitest' as const, runCmd: () => [], classify: () => 'clean' as const }

  it('includes the finding, file contents, and exemplar', () => {
    const msgs = buildProbeMessages(
      { file: 'src/x.ts', line: 7, severity: 'bug', message: 'off-by-one in loop' },
      'export const x = 1',
      { path: 'tests/a.test.ts', content: 'describe(...)' },
      harness,
    )
    const user = msgs[1]?.content[0]
    expect(user?.type).toBe('text')
    if (user?.type === 'text') {
      expect(user.text).toContain('src/x.ts:7')
      expect(user.text).toContain('off-by-one in loop')
      expect(user.text).toContain('export const x = 1')
      expect(user.text).toContain('tests/a.test.ts')
    }
  })
})
