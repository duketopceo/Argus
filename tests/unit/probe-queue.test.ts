import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { resolveConfig } from '../../src/config.js'
import type { ExecFn, ExecResult } from '../../src/detect.js'
import type { PrMeta } from '../../src/evidence/ci.js'
import type { VisionClient } from '../../src/engine/loop.js'
import type { RepoIndex } from '../../src/index/scan.js'
import {
  findExemplarTest,
  isSafeRepoPath,
  runProbeLane,
  selectProbeTargets,
  type LinkedFinding,
  type ProbeLaneOptions,
} from '../../src/probe/queue.js'
import { Ledger } from '../../src/vision/ledger.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function finding(file: string, severity = 'bug', status = 'not_exercised' as const): LinkedFinding {
  return {
    file,
    severity,
    message: `${severity} in ${file}`,
    evidence: { status, detail: 'no test' },
  }
}

const META: PrMeta = {
  headSha: 'head1',
  baseSha: 'base1',
  isFork: false,
  authorAssociation: 'MEMBER',
  labels: [],
  pushedAt: '2026-09-15T10:00:00Z',
  labelApprovedAt: undefined,
}

const PROBE_JSON = JSON.stringify({
  filename: 'probe-x.test.ts',
  content:
    "import { describe, it } from 'vitest'\ndescribe('probe', () => { it('reproduces', () => {}) })",
  reasoning: 'asserts correct bound',
})

function client(complete?: () => Promise<{ content: string }>): VisionClient {
  return {
    complete: async () => ({
      id: 'x',
      content: complete ? (await complete()).content : PROBE_JSON,
      cost: { model: 'm', provider: 'p', tokens: 10, costUsd: 0.001, kind: 'code' as const },
      model: 'm',
    }),
  }
}

interface ExecScript {
  /** head probe outcome */
  head?: ExecResult
  /** base probe outcome */
  base?: ExecResult
  dockerDown?: boolean
  /** throws on the head run */
  headThrows?: boolean
}

function scriptedExec(
  script: ExecScript,
  wtDir?: { path: string },
): { exec: ExecFn; calls: string[][] } {
  const calls: string[][] = []
  const exec: ExecFn = async (cmd, args) => {
    calls.push([cmd, ...args])
    if (cmd === 'docker' && args[0] === 'version') {
      return script.dockerDown
        ? { code: 1, stdout: '', stderr: 'no daemon' }
        : { code: 0, stdout: '24', stderr: '' }
    }
    if (cmd === 'docker' && args[0] === 'run' && args.includes('--entrypoint')) {
      // mount smoke check (identified by the test entrypoint, not a bare
      // 'test' substring — real probe commands can legitimately carry one)
      return { code: 0, stdout: '', stderr: '' }
    }
    if (cmd === 'git' && args.includes('cat-file')) return { code: 0, stdout: '', stderr: '' }
    if (cmd === 'git' && args.includes('worktree') && args.includes('add')) {
      await mkdir(args[args.indexOf('--detach') + 1] ?? '', { recursive: true })
      return { code: 0, stdout: '', stderr: '' }
    }
    if (cmd === 'git' && args.includes('worktree') && args.includes('remove')) {
      return { code: 0, stdout: '', stderr: '' }
    }
    if (cmd === 'docker' && args[0] === 'run') {
      const mountIdx = args.indexOf('-v')
      const mount = args[mountIdx + 1] ?? ''
      const isBase = wtDir !== undefined && mount.startsWith(wtDir.path)
      if (isBase) return script.base ?? { code: 0, stdout: 'Test Files  1 passed', stderr: '' }
      if (script.headThrows) throw new Error('spawn docker ENOENT')
      return (
        script.head ?? { code: 1, stdout: 'Test Files  1 failed (1)\n Tests  1 failed', stderr: '' }
      )
    }
    if (cmd === 'docker' && args[0] === 'rm') return { code: 0, stdout: '', stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  }
  return { exec, calls }
}

async function makeRepo(): Promise<{ cwd: string; reportDir: string; index: RepoIndex }> {
  const cwd = await mkdtemp(join(tmpdir(), 'argus-queue-'))
  await writeFile(
    join(cwd, 'package.json'),
    JSON.stringify({ devDependencies: { vitest: '^3' } }),
    'utf8',
  )
  await mkdir(join(cwd, 'src'), { recursive: true })
  await writeFile(join(cwd, 'src', 'util.ts'), 'export const f = (n:number) => n + 1', 'utf8')
  await mkdir(join(cwd, 'tests'), { recursive: true })
  await writeFile(join(cwd, 'tests', 'a.test.ts'), "import { describe } from 'vitest'", 'utf8')
  const reportDir = join(cwd, 'argus-reviewer-report')
  await mkdir(reportDir, { recursive: true })
  const index: RepoIndex = {
    schemaVersion: 1 as never,
    generatedAt: '',
    root: cwd,
    entries: [
      { path: 'src/util.ts', imports: [], importedBy: [], contentHash: 'x' },
      { path: 'tests/a.test.ts', imports: [], importedBy: [], contentHash: 'y' },
    ],
  }
  return { cwd, reportDir, index }
}

function laneOpts(
  cwd: string,
  reportDir: string,
  index: RepoIndex,
  exec: ExecFn,
  over: Partial<ProbeLaneOptions> = {},
): ProbeLaneOptions {
  return {
    cwd,
    reportDir,
    sandbox: resolveConfig({ sandbox: { enabled: true } }).sandbox,
    meta: META,
    token: 't',
    client: client(),
    model: 'm',
    provider: undefined,
    ledger: new Ledger(undefined),
    budgetUsd: undefined,
    severityGates: ['bug'],
    index,
    exec,
    ...over,
  }
}

// ---------------------------------------------------------------------------

describe('selectProbeTargets', () => {
  it('keeps not_exercised blocking-severity findings, capped', () => {
    const fs = [
      finding('src/a.ts'),
      finding('src/b.ts', 'nit'),
      { ...finding('src/c.ts'), evidence: { status: 'exercised' as const, detail: '' } },
      finding('src/d.ts'),
      {
        file: undefined,
        severity: 'bug',
        message: 'x',
        evidence: { status: 'not_exercised' as const, detail: '' },
      },
    ]
    const out = selectProbeTargets(fs, ['bug'], 3)
    expect(out.map((f) => f.file)).toEqual(['src/a.ts', 'src/d.ts'])
  })

  it('drops findings whose file path is unsafe — traversal is never read', () => {
    const fs = [
      finding('../../etc/passwd'),
      finding('/abs/path.ts'),
      finding('src/..\\win.ts'),
      finding('src/safe.ts'),
    ]
    const out = selectProbeTargets(fs, ['bug'], 10)
    expect(out.map((f) => f.file)).toEqual(['src/safe.ts'])
  })

  it('U9 — a confident triage area reorders candidates toward the flagged subsystem', () => {
    const fs = [
      finding('src/readme/gen.ts'),
      finding('src/auth/session.ts'),
      finding('src/util/misc.ts'),
    ]
    const out = selectProbeTargets(fs, ['bug'], 10, { area: 'auth', confidence: 0.9 })
    expect(out[0]!.file).toBe('src/auth/session.ts')
    expect(out).toHaveLength(3)
  })

  it('U9 — ordering decides the cap winner, not just the sort', () => {
    const fs = [finding('src/util/misc.ts'), finding('src/billing/charge.ts')]
    const out = selectProbeTargets(fs, ['bug'], 1, { area: 'billing', confidence: 0.9 })
    expect(out.map((f) => f.file)).toEqual(['src/billing/charge.ts'])
  })

  it('U9 — no signal, low confidence, or no path match keeps original order', () => {
    const fs = [finding('src/a.ts'), finding('src/b.ts')]
    expect(selectProbeTargets(fs, ['bug'], 10).map((f) => f.file)).toEqual(['src/a.ts', 'src/b.ts'])
    expect(
      selectProbeTargets(fs, ['bug'], 10, { area: 'auth', confidence: 0.3 }).map((f) => f.file),
    ).toEqual(['src/a.ts', 'src/b.ts'])
    expect(
      selectProbeTargets(fs, ['bug'], 10, { area: 'auth', confidence: 0.9 }).map((f) => f.file),
    ).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('U9 — metadata.ts does not hit the data area (segment-prefix match)', () => {
    const fs = [finding('src/metadata.ts'), finding('src/data/seed.ts')]
    const out = selectProbeTargets(fs, ['bug'], 1, { area: 'data', confidence: 0.9 })
    expect(out[0]!.file).toBe('src/data/seed.ts')
  })
})

describe('isSafeRepoPath', () => {
  it('rejects absolute, backslash, and ..-traversal paths', () => {
    for (const bad of ['/etc/passwd', '../x', 'a/../../b', 'a\\b', '..']) {
      expect(isSafeRepoPath(bad), bad).toBe(false)
    }
    for (const ok of ['src/a.ts', 'tests/deep/x.test.ts', 'a']) {
      expect(isSafeRepoPath(ok), ok).toBe(true)
    }
  })
})

describe('findExemplarTest', () => {
  it('prefers same-dir, then top-level, then any test', () => {
    const index = {
      entries: [
        { path: 'tests/a.test.ts', imports: [], importedBy: [], contentHash: '' },
        { path: 'src/deep/b.test.ts', imports: [], importedBy: [], contentHash: '' },
      ],
    } as unknown as RepoIndex
    expect(findExemplarTest(index, 'src/deep/x.ts')).toBe('src/deep/b.test.ts')
    expect(findExemplarTest(index, 'tests/z.ts')).toBe('tests/a.test.ts')
    expect(findExemplarTest(index, 'lib/y.ts')).toBe('tests/a.test.ts')
    expect(findExemplarTest(undefined, 'lib/y.ts')).toBeUndefined()
  })
})

describe('runProbeLane', () => {
  let cwd: string
  let reportDir: string
  let index: RepoIndex
  beforeEach(async () => {
    ;({ cwd, reportDir, index } = await makeRepo())
  })
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true })
  })

  it('upgrades to reproduced on fail-head ∧ clean-base (KTD6)', async () => {
    const wt = { path: join(reportDir, 'probes-base') }
    const { exec } = scriptedExec(
      {
        head: { code: 1, stdout: ' Test Files  1 failed\n Tests  1 failed', stderr: '' },
        base: { code: 0, stdout: ' Test Files  1 passed', stderr: '' },
      },
      wt,
    )
    const fs = [finding('src/util.ts')]
    const res = await runProbeLane(fs, laneOpts(cwd, reportDir, index, exec))
    expect(fs[0]?.evidence.status).toBe('reproduced')
    expect(res?.records[0]?.outcome).toBe('reproduced')
    expect(res?.records[0]?.headOutcome).toBe('failed-test')
    expect(res?.records[0]?.baseOutcome).toBe('clean')
  })

  it('does NOT upgrade when the probe fails on base too (probe bug)', async () => {
    const wt = { path: join(reportDir, 'probes-base') }
    const { exec } = scriptedExec(
      {
        head: { code: 1, stdout: ' Test Files  1 failed\n Tests  1 failed', stderr: '' },
        base: { code: 1, stdout: ' Test Files  1 failed\n Tests  1 failed', stderr: '' },
      },
      wt,
    )
    const fs = [finding('src/util.ts')]
    const res = await runProbeLane(fs, laneOpts(cwd, reportDir, index, exec))
    expect(fs[0]?.evidence.status).toBe('not_exercised')
    expect(res?.records[0]?.outcome).toBe('load-error')
    expect(res?.records[0]?.detail).toContain('base')
  })

  it('records clean when the probe passes on head', async () => {
    const wt = { path: join(reportDir, 'probes-base') }
    const { exec } = scriptedExec(
      { head: { code: 0, stdout: ' Test Files  1 passed', stderr: '' } },
      wt,
    )
    const fs = [finding('src/util.ts')]
    const res = await runProbeLane(fs, laneOpts(cwd, reportDir, index, exec))
    expect(fs[0]?.evidence.status).toBe('not_exercised')
    expect(res?.records[0]?.outcome).toBe('clean')
  })

  it('records error when the sandbox spawn rejects', async () => {
    const wt = { path: join(reportDir, 'probes-base') }
    const { exec } = scriptedExec({ headThrows: true }, wt)
    const fs = [finding('src/util.ts')]
    const res = await runProbeLane(fs, laneOpts(cwd, reportDir, index, exec))
    expect(res?.records[0]?.outcome).toBe('error')
    expect(fs[0]?.evidence.status).toBe('not_exercised')
  })

  it('respects maxProbes', async () => {
    const wt = { path: join(reportDir, 'probes-base') }
    const { exec } = scriptedExec({}, wt)
    const fs = [
      finding('src/util.ts'),
      finding('src/util.ts'),
      finding('src/util.ts'),
      finding('src/util.ts'),
    ]
    const res = await runProbeLane(
      fs,
      laneOpts(cwd, reportDir, index, exec, {
        sandbox: resolveConfig({ sandbox: { enabled: true, maxProbes: 2 } }).sandbox,
      }),
    )
    expect(res?.records).toHaveLength(2)
  })

  it('does nothing when disabled — zero authoring calls', async () => {
    let authored = 0
    const { exec } = scriptedExec({})
    const fs = [finding('src/util.ts')]
    const out = await runProbeLane(
      fs,
      laneOpts(cwd, reportDir, index, exec, {
        sandbox: resolveConfig({ sandbox: { enabled: false } }).sandbox,
        client: client(async () => {
          authored++
          return { content: PROBE_JSON }
        }),
      }),
    )
    expect(out).toBeUndefined()
    expect(authored).toBe(0)
  })

  it('skips with a reason when the fork gate denies', async () => {
    const { exec } = scriptedExec({})
    const fs = [finding('src/util.ts')]
    const out = await runProbeLane(
      fs,
      laneOpts(cwd, reportDir, index, exec, {
        meta: { ...META, isFork: true, authorAssociation: 'NONE' },
      }),
    )
    expect(out?.records).toHaveLength(0)
    expect(out?.skipReason).toContain('fork gate')
    expect(fs[0]?.evidence.status).toBe('not_exercised')
  })

  it('skips with a reason when docker is down', async () => {
    const { exec } = scriptedExec({ dockerDown: true })
    const out = await runProbeLane([finding('src/util.ts')], laneOpts(cwd, reportDir, index, exec))
    expect(out?.records).toHaveLength(0)
    expect(out?.skipReason).toContain('docker')
  })

  it('skips with a reason when no harness is detected', async () => {
    await writeFile(
      join(cwd, 'package.json'),
      JSON.stringify({ scripts: { test: 'echo x' } }),
      'utf8',
    )
    const { exec } = scriptedExec({})
    const out = await runProbeLane([finding('src/util.ts')], laneOpts(cwd, reportDir, index, exec))
    expect(out?.records).toHaveLength(0)
    expect(out?.skipReason).toContain('harness')
  })

  it('maps a not-collected probe instead of reproducing', async () => {
    const wt = { path: join(reportDir, 'probes-base') }
    const { exec } = scriptedExec(
      {
        head: { code: 1, stdout: '', stderr: 'No test files found, exiting with code 1' },
        base: { code: 0, stdout: ' Test Files  1 passed', stderr: '' },
      },
      wt,
    )
    const fs = [finding('src/util.ts')]
    const res = await runProbeLane(fs, laneOpts(cwd, reportDir, index, exec))
    expect(res?.records[0]?.outcome).toBe('not-collected')
    expect(fs[0]?.evidence.status).toBe('not_exercised')
  })

  it('stops authoring when the shared budget is spent', async () => {
    let authored = 0
    const wt = { path: join(reportDir, 'probes-base') }
    const { exec } = scriptedExec({}, wt)
    const ledger = new Ledger(0.0005)
    ledger.recordCall({ model: 'm', provider: 'p', tokens: 1, costUsd: 0.001, kind: 'code' })
    const fs = [finding('src/util.ts'), finding('src/util.ts')]
    const res = await runProbeLane(
      fs,
      laneOpts(cwd, reportDir, index, exec, {
        ledger,
        budgetUsd: 0.0005,
        client: client(async () => {
          authored++
          return { content: PROBE_JSON }
        }),
      }),
    )
    expect(authored).toBe(0)
    expect(res?.records).toHaveLength(0)
    expect(ledger.budgetExceeded).toBe(false)
  })

  it('records error when authoring returns an unsafe probe', async () => {
    const wt = { path: join(reportDir, 'probes-base') }
    const { exec } = scriptedExec({}, wt)
    const fs = [finding('src/util.ts')]
    const res = await runProbeLane(
      fs,
      laneOpts(cwd, reportDir, index, exec, {
        client: client(async () => ({
          content: JSON.stringify({ filename: '../evil.test.ts', content: 'x', reasoning: '' }),
        })),
      }),
    )
    expect(res?.records[0]?.outcome).toBe('error')
    expect(res?.records[0]?.detail).toContain('authoring failed')
    expect(fs[0]?.evidence.status).toBe('not_exercised')
  })

  it('fork PRs ignore PR-supplied allowForks/image — the gate still denies (P0)', async () => {
    const { exec } = scriptedExec({})
    const fs = [finding('src/util.ts')]
    const out = await runProbeLane(
      fs,
      laneOpts(cwd, reportDir, index, exec, {
        // PR-controlled config tries to self-approve — must be ignored.
        sandbox: resolveConfig({
          sandbox: { enabled: true, allowForks: true, image: 'evil:latest', memory: '99g' },
        }).sandbox,
        meta: { ...META, isFork: true, authorAssociation: 'NONE' },
      }),
    )
    expect(out?.records).toHaveLength(0)
    expect(out?.skipReason).toContain('fork gate')
  })

  it('continues to later targets when one authoring call throws', async () => {
    const wt = { path: join(reportDir, 'probes-base') }
    const { exec } = scriptedExec({}, wt)
    let calls = 0
    const fs = [finding('src/util.ts'), finding('src/util.ts')]
    const res = await runProbeLane(
      fs,
      laneOpts(cwd, reportDir, index, exec, {
        client: client(async () => {
          calls++
          if (calls === 1) throw new Error('openrouter 500')
          return { content: PROBE_JSON }
        }),
      }),
    )
    expect(res?.records).toHaveLength(2)
    expect(res?.records[0]?.outcome).toBe('error')
    expect(res?.records[0]?.detail).toContain('openrouter 500')
    // Second target still authored and ran (default script: fail-head ∧ clean-base).
    expect(res?.records[1]?.outcome).toBe('reproduced')
  })

  it('never overwrites an existing test file — exclusive create fails closed', async () => {
    const wt = { path: join(reportDir, 'probes-base') }
    const { exec } = scriptedExec({}, wt)
    // Pre-plant a file at the path the probe would take: exemplar is
    // tests/a.test.ts → probe writes tests/argus-probe-probe-x.test.ts.
    const collision = join(cwd, 'tests', 'argus-probe-probe-x.test.ts')
    await writeFile(collision, '// real consumer test', 'utf8')
    const res = await runProbeLane([finding('src/util.ts')], laneOpts(cwd, reportDir, index, exec))
    expect(res?.records[0]?.outcome).toBe('error')
    expect(res?.records[0]?.detail).toContain('probe write failed')
    const { readFile } = await import('node:fs/promises')
    expect(await readFile(collision, 'utf8')).toBe('// real consumer test')
  })

  it('head failure with no base records error, never reproduced', async () => {
    const { exec } = scriptedExec({
      head: { code: 1, stdout: ' Test Files  1 failed\n Tests  1 failed', stderr: '' },
    })
    const fs = [finding('src/util.ts')]
    const res = await runProbeLane(
      fs,
      laneOpts(cwd, reportDir, index, exec, { meta: { ...META, baseSha: undefined } }),
    )
    expect(res?.records[0]?.outcome).toBe('error')
    expect(res?.records[0]?.detail).toContain('base checkout unavailable')
    expect(fs[0]?.evidence.status).toBe('not_exercised')
  })
})
