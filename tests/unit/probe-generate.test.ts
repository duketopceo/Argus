import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resolveConfig } from '../../src/config.js'
import type { ExecFn, ExecResult } from '../../src/detect.js'
import type { PrMeta } from '../../src/evidence/ci.js'
import type { VisionClient } from '../../src/engine/loop.js'
import type { RepoIndex } from '../../src/index/scan.js'
import {
  buildGenerateMessages,
  isDocsOnlyDiff,
  parseGeneratedSpecs,
  runGenerateLane,
  type GenerateLaneOptions,
} from '../../src/probe/generate.js'
import { Ledger } from '../../src/vision/ledger.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const META: PrMeta = {
  title: undefined,
  body: undefined,
  headSha: 'head1234abcd',
  baseSha: 'base1',
  baseRef: 'main',
  isFork: false,
  authorAssociation: 'MEMBER',
  labels: [],
  pushedAt: '2026-09-15T10:00:00Z',
  labelApprovedAt: undefined,
}

const DIFF =
  '--- src/util.ts\n@@ -1,2 +1,4 @@\n export const f = (n:number) => n + 1\n+export const g = (n:number) => n * 2\n'

const SPEC_OK = {
  filename: 'util-double.test.ts',
  content:
    "import { describe, it, expect } from 'vitest'\n" +
    "import { g } from '../src/util'\n" +
    "describe('g', () => { it('doubles', () => { expect(g(2)).toBe(4) }) })",
  reasoning: 'covers the new g() helper',
}

function genResponse(specs: unknown[] = [SPEC_OK], note = ''): string {
  return JSON.stringify({ specs, note })
}

function client(content?: string): VisionClient & { calls: number } {
  const c = {
    calls: 0,
    complete: async () => {
      c.calls++
      return {
        id: 'x',
        content: content ?? genResponse(),
        cost: { model: 'm', provider: 'p', tokens: 10, costUsd: 0.001, kind: 'code' as const },
        model: 'm',
      }
    },
  }
  return c
}

interface Script {
  /** per-spec sandbox result keyed by docker run order; default green */
  run?: ExecResult
  dockerDown?: boolean
}

function scriptedExec(script: Script): ExecFn {
  return async (cmd, args) => {
    if (cmd === 'docker' && args[0] === 'version') {
      return script.dockerDown
        ? { code: 1, stdout: '', stderr: 'no daemon' }
        : { code: 0, stdout: '24', stderr: '' }
    }
    if (cmd === 'docker' && args[0] === 'run' && args.includes('--entrypoint')) {
      return { code: 0, stdout: '', stderr: '' }
    }
    if (cmd === 'docker' && args[0] === 'run') {
      return script.run ?? { code: 0, stdout: ' Test Files  1 passed', stderr: '' }
    }
    return { code: 0, stdout: '', stderr: '' }
  }
}

async function makeRepo(): Promise<{ cwd: string; reportDir: string; index: RepoIndex }> {
  const cwd = await mkdtemp(join(tmpdir(), 'argus-gen-'))
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
  over: Partial<GenerateLaneOptions> = {},
): GenerateLaneOptions {
  return {
    cwd,
    reportDir,
    testsDir: 'tests',
    diff: DIFF,
    changedPaths: ['src/util.ts'],
    sandbox: resolveConfig({ sandbox: { enabled: true } }).sandbox,
    meta: META,
    token: 'tok',
    repo: 'a/b',
    pr: '7',
    client: client(),
    model: 'm',
    provider: undefined,
    ledger: new Ledger(undefined),
    budgetUsd: undefined,
    maxSpecs: 3,
    index,
    exec,
    ...over,
  }
}

/** GitHub API stub for the createFilesPr write path. */
function stubGithub(handlers: Record<string, { status: number; body: unknown }>) {
  const calls: { method: string; url: string; body?: unknown }[] = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    const key = `${method} ${url.split('api.github.com')[1]}`
    const hit = handlers[key] ?? handlers[`${method} ${url}`] ?? handlers[url]
    if (hit === undefined) return new Response('{}', { status: 404 })
    return new Response(JSON.stringify(hit.body), { status: hit.status })
  })
  return calls
}

const GH_WRITE_OK = (headSha: string): Record<string, { status: number; body: unknown }> => ({
  'GET /repos/a/b/git/ref/heads/main': { status: 200, body: { object: { sha: 'base' } } },
  'POST /repos/a/b/git/refs': { status: 201, body: {} },
  [`PUT /repos/a/b/contents/${encodeURIComponent('tests/util-double.test.ts')}`]: {
    status: 201,
    body: {},
  },
  [`GET /repos/a/b/pulls?head=a%3Aargus%2Fgenerated-tests-${headSha}&state=open`]: {
    status: 200,
    body: [],
  },
  'POST /repos/a/b/pulls': {
    status: 201,
    body: { html_url: 'https://github.com/a/b/pull/11' },
  },
})

// ---------------------------------------------------------------------------

describe('isDocsOnlyDiff', () => {
  it('recognizes docs-only diffs', () => {
    expect(isDocsOnlyDiff(['README.md', 'docs/guide.md', 'CHANGELOG'])).toBe(true)
    expect(isDocsOnlyDiff(['src/a.ts', 'docs/b.md'])).toBe(false)
    expect(isDocsOnlyDiff(['src/a.ts'])).toBe(false)
    expect(isDocsOnlyDiff([])).toBe(false)
  })
})

describe('parseGeneratedSpecs', () => {
  it('parses a valid spec list', () => {
    const res = parseGeneratedSpecs(genResponse(), 3)
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.specs).toHaveLength(1)
      expect(res.specs[0]?.filename).toBe('util-double.test.ts')
      expect(res.rejected).toEqual([])
    }
  })

  it('rejects unsafe filenames, config-shaped leafs, and forbidden stems', () => {
    const bad = [
      { ...SPEC_OK, filename: '../evil.test.ts' },
      { ...SPEC_OK, filename: 'vitest.config.test.ts' },
      { ...SPEC_OK, filename: 'setup.test.ts' },
      { ...SPEC_OK, filename: 'conftest.test.ts' },
      { ...SPEC_OK, filename: 'sub/dir.test.ts' },
      SPEC_OK,
    ]
    const res = parseGeneratedSpecs(genResponse(bad), 6)
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.specs).toHaveLength(1)
      expect(res.rejected).toHaveLength(5)
      expect(res.rejected.map((r) => r.reason).join(' ')).toContain('forbidden spec stem')
    }
  })

  it('enforces maxSpecs and fails closed on non-array/malformed bodies', () => {
    const three = parseGeneratedSpecs(genResponse([SPEC_OK, SPEC_OK, SPEC_OK]), 1)
    expect(three.ok && three.specs).toHaveLength(1)
    expect(parseGeneratedSpecs('not json', 3).ok).toBe(false)
    expect(parseGeneratedSpecs('{"note":"x"}', 3).ok).toBe(false)
  })

  it('rejects secret-env reads via the shared probe validator', () => {
    const evil = { ...SPEC_OK, content: "const k = process.env.OPENROUTER_API_KEY\nit('x',()=>{})" }
    const res = parseGeneratedSpecs(genResponse([evil]), 3)
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.rejected[0]?.reason).toContain('env')
  })
})

describe('runGenerateLane', () => {
  let cwd: string
  let reportDir: string
  let index: RepoIndex
  beforeEach(async () => {
    ;({ cwd, reportDir, index } = await makeRepo())
  })
  afterEach(async () => {
    vi.unstubAllGlobals()
    await rm(cwd, { recursive: true, force: true })
  })

  it('happy path: green-in-sandbox spec lands on a reviewable PR', async () => {
    const calls = stubGithub(GH_WRITE_OK('head1234'))
    const res = await runGenerateLane(
      laneOpts(cwd, reportDir, index, scriptedExec({})),
    )
    expect(res.skipReason).toBeUndefined()
    expect(res.records[0]?.status).toBe('committed')
    expect(res.records[0]?.validation).toBe('green')
    expect(res.records[0]?.path).toBe('tests/util-double.test.ts')
    expect(res.prUrl).toBe('https://github.com/a/b/pull/11')
    const post = calls.find((c) => c.method === 'POST' && c.url.endsWith('/pulls'))
    const prBody = String((post?.body as { body?: string })?.body ?? '')
    expect(prBody).toContain('tests/util-double.test.ts')
    // The disclosure contract: green-in-container is not safety.
    expect(prBody).toContain('not safety')
    expect(prBody).not.toMatch(/\p{Extended_Pictographic}|\u{FE0F}/u)
    expect(prBody).not.toContain('—')
    // Host write was exclusive-create and removed after the sandbox run.
    await expect(
      import('node:fs/promises').then((fs) => fs.readFile(join(cwd, 'tests', 'util-double.test.ts'), 'utf8')),
    ).rejects.toThrow()
  })

  it('sandbox-red spec is excluded from the PR and recorded as a draft', async () => {
    const calls = stubGithub(GH_WRITE_OK('head1234'))
    const res = await runGenerateLane(
      laneOpts(cwd, reportDir, index, scriptedExec({
        run: { code: 1, stdout: ' Test Files  1 failed\n Tests  1 failed', stderr: '' },
      })),
    )
    expect(res.records[0]?.status).toBe('draft')
    expect(res.records[0]?.validation).toBe('failed')
    expect(res.records[0]?.detail).toContain('failed-test')
    expect(res.prUrl).toBeUndefined()
    // Nothing committed — no PUT ever ran.
    expect(calls.some((c) => c.method === 'PUT')).toBe(false)
  })

  it('docs-only diff skips before any model spend', async () => {
    const c = client()
    const res = await runGenerateLane(
      laneOpts(cwd, reportDir, index, scriptedExec({}), {
        client: c,
        changedPaths: ['README.md', 'docs/x.md'],
      }),
    )
    expect(res.skipReason).toContain('docs-only')
    expect(c.calls).toBe(0)
    expect(res.costUsd).toBe(0)
  })

  it('refuses fork PRs before any model spend', async () => {
    const c = client()
    const res = await runGenerateLane(
      laneOpts(cwd, reportDir, index, scriptedExec({}), {
        client: c,
        meta: { ...META, isFork: true },
      }),
    )
    expect(res.skipReason).toContain('fork')
    expect(c.calls).toBe(0)
  })

  it('no GitHub write context → drafts, no writes', async () => {
    const res = await runGenerateLane(
      laneOpts(cwd, reportDir, index, scriptedExec({}), { token: undefined, repo: undefined }),
    )
    expect(res.records[0]?.status).toBe('draft')
    expect(res.records[0]?.detail).toContain('no GitHub write context')
    expect(res.prUrl).toBeUndefined()
  })

  it('no sandbox → specs ship as clearly-unvalidated drafts on the PR', async () => {
    const calls = stubGithub(GH_WRITE_OK('head1234'))
    const res = await runGenerateLane(
      laneOpts(cwd, reportDir, index, scriptedExec({ dockerDown: true }), {
        sandbox: undefined,
      }),
    )
    expect(res.records[0]?.validation).toBe('unvalidated')
    expect(res.records[0]?.status).toBe('committed')
    const post = calls.find((c) => c.method === 'POST' && c.url.endsWith('/pulls'))
    expect(String((post?.body as { body?: string })?.body)).toContain('NOT sandbox-validated')
  })

  it('empty specs + note reports the skip without a PR', async () => {
    const res = await runGenerateLane(
      laneOpts(cwd, reportDir, index, scriptedExec({}), {
        client: client(genResponse([], 'docs-only diff, nothing behavioral')),
      }),
    )
    expect(res.skipReason).toContain('docs-only')
    expect(res.records).toHaveLength(0)
  })

  it('relative import escaping the repo is rejected, never written', async () => {
    const escapes = {
      ...SPEC_OK,
      content:
        "import { x } from '../../../etc/passwd'\nimport { describe, it } from 'vitest'\ndescribe('x', () => { it('y', () => {}) })",
    }
    const res = await runGenerateLane(
      laneOpts(cwd, reportDir, index, scriptedExec({}), {
        client: client(genResponse([escapes])),
      }),
    )
    expect(res.records[0]?.status).toBe('rejected')
    expect(res.records[0]?.detail).toContain('escapes')
  })

  it('authoring over the schema/config cap lands as rejected records', async () => {
    stubGithub(GH_WRITE_OK('head1234'))
    const res = await runGenerateLane(
      laneOpts(cwd, reportDir, index, scriptedExec({}), {
        maxSpecs: 1,
        client: client(genResponse([SPEC_OK, SPEC_OK])),
      }),
    )
    expect(res.records.filter((r) => r.status === 'rejected')).toHaveLength(1)
    expect(res.records.filter((r) => r.status === 'committed')).toHaveLength(1)
  })

  it('authoring call failure degrades to a skip with zero records', async () => {
    const failing = {
      complete: async () => {
        throw new Error('openrouter 500')
      },
    } as unknown as VisionClient
    const res = await runGenerateLane(
      laneOpts(cwd, reportDir, index, scriptedExec({}), { client: failing }),
    )
    expect(res.skipReason).toContain('authoring call failed')
    expect(res.records).toHaveLength(0)
  })
})

describe('buildGenerateMessages', () => {
  it('carries the leaf contract, testsDir, and the diff', () => {
    const msgs = buildGenerateMessages(DIFF, undefined, { kind: 'vitest', runCmd: (p) => [p], classify: () => 'clean' }, 'tests', 3)
    const text = msgs.map((m) => m.content.map((p) => ('text' in p ? p.text : '')).join('')).join('\n')
    expect(text).toContain('.test.ts')
    expect(text).toContain('tests/')
    expect(text).toContain(DIFF.trim())
    expect(text).toContain('CORRECT post-change behavior')
  })
})

describe('config: review.generateTests', () => {
  it('defaults off and degrades wrong-typed values to the safe defaults', () => {
    const def = resolveConfig({})
    expect(def.review.generateTests).toEqual({ enabled: false, maxSpecs: 3, budgetUsd: undefined })
    const weird = resolveConfig({
      review: { generateTests: { enabled: 'yes' as never, maxSpecs: -1, budgetUsd: 'x' as never } },
    })
    expect(weird.review.generateTests).toEqual({ enabled: false, maxSpecs: 3, budgetUsd: undefined })
  })

  it('honors bounds and clamps maxSpecs at the schema ceiling', () => {
    const cfg = resolveConfig({
      review: { generateTests: { enabled: true, maxSpecs: 50, budgetUsd: 0.5 } },
    })
    expect(cfg.review.generateTests).toEqual({ enabled: true, maxSpecs: 8, budgetUsd: 0.5 })
  })
})
