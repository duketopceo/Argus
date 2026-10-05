import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadLocalDiff, main } from '../../src/cli.js'
import type { VisionClient } from '../../src/engine/loop.js'
import type { CallCost, CallKind } from '../../src/vision/cost.js'
import type { JsonSchema, Message } from '../../src/vision/openrouter.js'
import type { ProviderRules } from '../../src/config.js'

const MIN_ENV = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' }

class StubClient implements VisionClient {
  calls: { kind: CallKind | undefined; model: string; messages: Message[] }[] = []
  constructor(private queue: { content: string }[]) {}
  async complete(opts: {
    model: string
    messages: Message[]
    schema?: JsonSchema
    provider?: ProviderRules
    kind?: CallKind
  }): Promise<{ id: string; content: string; cost: CallCost; model: string }> {
    this.calls.push({ kind: opts.kind, model: opts.model, messages: opts.messages })
    const next = this.queue.shift()
    if (next === undefined) throw new Error('StubClient queue exhausted')
    const cost: CallCost = { model: opts.model, provider: 'stub', tokens: 10, costUsd: 0.001, kind: opts.kind ?? 'code' }
    return { id: 'stub', content: next.content, cost, model: opts.model }
  }
}

/**
 * Build a git repo at `dir`: baseFiles committed on `main`, headFiles
 * committed on `feature` (checked out), dirtyFiles left uncommitted.
 */
function materializeRepo(
  dir: string,
  baseFiles: Record<string, string>,
  headFiles: Record<string, string>,
  dirtyFiles: Record<string, string> = {},
): void {
  const git = (args: string[]) =>
    execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args])
  const write = (files: Record<string, string>) => {
    for (const [name, content] of Object.entries(files)) {
      execFileSync('mkdir', ['-p', join(dir, name, '..')])
      execFileSync('sh', ['-c', `cat > ${join(dir, name)}`], { input: content })
    }
  }
  execFileSync('git', ['-C', dir, 'init', '-b', 'main'])
  write(baseFiles)
  git(['add', '-A'])
  git(['commit', '--allow-empty', '-m', 'base'])
  git(['checkout', '-b', 'feature'])
  write(headFiles)
  git(['add', '-A'])
  git(['commit', '--allow-empty', '-m', 'head'])
  write(dirtyFiles) // uncommitted — lands via `git diff <merge-base>` (worktree)
}

const PASS = { content: JSON.stringify({ summary: 'ok', verdict: 'pass', findings: [] }) }

async function writeConfig(cwd: string, reportDir: string): Promise<void> {
  // decisionModel '' disables adjudication — deterministic regex-only lane.
  await writeFile(
    join(cwd, 'argus-reviewer.config.json'),
    JSON.stringify({ decisionModel: '', reportDir }),
  )
}

describe('loadLocalDiff', () => {
  it('resolves base, diffs merge-base vs the working tree', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'argus-local-'))
    materializeRepo(
      dir,
      { 'src/a.ts': 'export const a = 1\n' },
      { 'src/a.ts': 'export const a = 2\n' },
      { 'src/dirty.ts': 'export const dirty = 1\n' },
    )
    const res = await loadLocalDiff(dir, 'main')
    expect('error' in res).toBe(false)
    if ('error' in res) return
    // Committed head change AND the uncommitted file are both present.
    expect(res.files.map((f) => f.filename).sort()).toEqual(['src/a.ts', 'src/dirty.ts'])
    expect(res.meta.isFork).toBe(false)
    expect(res.meta.headSha).toMatch(/^[0-9a-f]{40}$/)
    expect(res.meta.baseSha).toMatch(/^[0-9a-f]{40}$/)
    expect(res.diff).toContain('+export const dirty = 1')
  })

  it('returns a clean error when the base ref does not resolve', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'argus-local-'))
    materializeRepo(dir, { 'a.ts': 'x\n' }, { 'a.ts': 'y\n' })
    const res = await loadLocalDiff(dir, 'no-such-ref')
    expect('error' in res).toBe(true)
    if ('error' in res) expect(res.error).toContain('no-such-ref')
  })
})

describe('code-review --base', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reviews the local diff with zero GitHub calls; report binds to the worktree', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'argus-local-'))
    materializeRepo(
      repo,
      { 'src/a.ts': 'export const a = 1\n' },
      { 'src/a.ts': 'export const a = 2\n', 'cfg.env': 'api_key = "demo0123456789abcdef"\n' },
      { 'src/dirty.ts': 'export const dirty = 7\n' },
    )
    const reportDir = join(repo, 'report')
    await writeConfig(repo, reportDir)
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const client = new StubClient([
      {
        content: JSON.stringify({
          summary: 'found a bug',
          verdict: 'needs_changes',
          findings: [
            { file: 'src/dirty.ts', line: 1, severity: 'bug', category: 'correctness', message: 'L1: bug' },
          ],
        }),
      },
    ])
    // No GITHUB_TOKEN / GITHUB_REPOSITORY — any api.github.com call fails.
    const code = await main(['code-review', '--base', 'main', '--report-dir', reportDir], {
      cwd: repo,
      env: { ...MIN_ENV, OPENROUTER_API_KEY: 'test-key' },
      out: () => {},
      err: () => {},
      createClient: () => client,
    })
    expect(code).toBe(0)
    expect(fetchSpy).not.toHaveBeenCalled()
    const report = JSON.parse(await readFile(join(reportDir, 'code-review.json'), 'utf8'))
    expect(report.skipped).toBe(false)
    expect(report.verdict).toBe('needs_changes')
    // The dirty worktree file reached the model — dirty checkouts are covered.
    expect(report.findings.some((f: { file: string }) => f.file === 'src/dirty.ts')).toBe(true)
    // The secrets lane ran on the materialized diff (no second shell-out).
    expect(report.secretsScan.records).toHaveLength(1)
    expect(report.headBinding.source).toBe('local')
    expect(report.headBinding.status).toBe('not_applicable')
    expect(report.headBinding.detail).toContain('working tree')
    expect(report.diffRange.base).toBe('main')
    expect(report.diffRange.headSha).toMatch(/^[0-9a-f]{40}$/)
    expect(report.diffRange.baseSha).toMatch(/^[0-9a-f]{40}$/)
    const live = await readFile(join(repo, '.argus-reviewer-cache', 'live.ndjson'), 'utf8')
    expect(live).toContain('local diff')
  })

  it('passes clean on an empty diff with zero model calls', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'argus-local-'))
    materializeRepo(repo, { 'a.ts': 'x\n' }, {})
    const reportDir = join(repo, 'report')
    // No config file — any file written inside the repo is itself an
    // untracked local change and would (correctly) enter the diff.
    // HEAD == merge-base(main, HEAD) → empty diff.
    const code = await main(['code-review', '--base', 'main', '--report-dir', reportDir], {
      cwd: repo,
      env: { ...MIN_ENV, OPENROUTER_API_KEY: 'test-key' },
      out: () => {},
      err: () => {},
      createClient: () => {
        throw new Error('model must not be constructed on an empty diff')
      },
    })
    expect(code).toBe(0)
    const report = JSON.parse(await readFile(join(reportDir, 'code-review.json'), 'utf8'))
    expect(report.skipped).toBe(true)
    expect(report.ok).toBe(true)
    expect(report.verdict).toBe('pass')
    expect(report.findings).toHaveLength(0)
    expect(report.diffRange.base).toBe('main')
  })

  it('exits 2 with a usage error on an unresolvable base — zero spend', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'argus-local-'))
    materializeRepo(repo, { 'a.ts': 'x\n' }, { 'a.ts': 'y\n' })
    const reportDir = join(repo, 'report')
    await writeConfig(repo, reportDir)
    const err: string[] = []
    const code = await main(['code-review', '--base', 'nope', '--report-dir', reportDir], {
      cwd: repo,
      env: { ...MIN_ENV, OPENROUTER_API_KEY: 'test-key' },
      out: () => {},
      err: (l) => err.push(l),
      createClient: () => {
        throw new Error('model must not be constructed on a bad base ref')
      },
    })
    expect(code).toBe(2)
    expect(err.join('\n')).toContain('nope')
  })

  it('rejects --base combined with --fixture', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'argus-local-'))
    materializeRepo(repo, { 'a.ts': 'x\n' }, { 'a.ts': 'y\n' })
    const err: string[] = []
    const code = await main(
      ['code-review', '--base', 'main', '--fixture', repo],
      { cwd: repo, env: MIN_ENV, out: () => {}, err: (l) => err.push(l) },
    )
    expect(code).toBe(2)
    expect(err.join('\n')).toContain('--fixture')
  })

  it('ARGUS_DIFF_BASE selects local mode only when no PR context exists', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'argus-local-'))
    materializeRepo(repo, { 'a.ts': 'x\n' }, { 'a.ts': 'y\n' })
    const reportDir = join(repo, 'report')
    await writeConfig(repo, reportDir)
    const client = new StubClient([PASS])
    const code = await main(['code-review', '--report-dir', reportDir], {
      cwd: repo,
      env: { ...MIN_ENV, OPENROUTER_API_KEY: 'test-key', ARGUS_DIFF_BASE: 'main' },
      out: () => {},
      err: () => {},
      createClient: () => client,
    })
    expect(code).toBe(0)
    expect(client.calls).toHaveLength(1)
    const report = JSON.parse(await readFile(join(reportDir, 'code-review.json'), 'utf8'))
    expect(report.headBinding.source).toBe('local')
    expect(report.diffRange.base).toBe('main')
  })

  it('does not let ARGUS_DIFF_BASE hijack a real PR review', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'argus-local-'))
    materializeRepo(repo, { 'a.ts': 'x\n' }, { 'a.ts': 'y\n' })
    const reportDir = join(repo, 'report')
    await writeConfig(repo, reportDir)
    const urls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        urls.push(url)
        if (url.includes('/pulls/7/files')) {
          return new Response(
            JSON.stringify([{ filename: 'a.ts', patch: '@@ -1 +1 @@\n-x\n+y', status: 'modified' }]),
          )
        }
        if (url.endsWith('/pulls/7')) {
          return new Response(
            JSON.stringify({
              head: { sha: 'a'.repeat(40), repo: { fork: false } },
              base: { sha: 'b'.repeat(40), ref: 'main' },
              author_association: 'OWNER',
              labels: [],
            }),
          )
        }
        if (url.includes('/compare/')) {
          return new Response(JSON.stringify({ merge_base_commit: { sha: 'b'.repeat(40) } }))
        }
        if (url.includes('/check-runs')) {
          return new Response(JSON.stringify({ check_runs: [] }))
        }
        return new Response('not found', { status: 404 })
      }),
    )
    const client = new StubClient([PASS])
    const code = await main(['code-review', '--report-dir', reportDir], {
      cwd: repo,
      env: {
        ...MIN_ENV,
        OPENROUTER_API_KEY: 'test-key',
        GITHUB_TOKEN: 'ghp_test',
        // The action's diff-base input is flow-lane invalidation — it must
        // not flip this real PR review into local mode.
        ARGUS_DIFF_BASE: 'main',
        ARGUS_REVIEWER_TRACE: JSON.stringify({ repo: 'o/r', pr: '7' }),
      },
      out: () => {},
      err: () => {},
      createClient: () => client,
    })
    expect(code).toBe(0)
    // PR mode ran: files came from the API, not the local merge-base diff.
    expect(urls.some((u) => u.includes('/pulls/7/files'))).toBe(true)
    const report = JSON.parse(await readFile(join(reportDir, 'code-review.json'), 'utf8'))
    expect(report.headBinding.source).toBe('github')
    expect(report.diffRange).toBeUndefined()
  })
})
