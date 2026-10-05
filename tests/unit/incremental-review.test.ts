import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { main } from '../../src/cli.js'
import type { VisionClient } from '../../src/engine/loop.js'
import { parseMention } from '../../src/mention.js'
import type { CallCost, CallKind } from '../../src/vision/cost.js'
import type { JsonSchema, Message } from '../../src/vision/openrouter.js'
import type { ProviderRules } from '../../src/config.js'

const MIN_ENV = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' }

const HEAD = 'a'.repeat(40)
const PREV = 'b'.repeat(40)
const MERGE_BASE = 'c'.repeat(40)

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
    const cost: CallCost = {
      model: opts.model,
      provider: 'stub',
      tokens: 10,
      costUsd: 0.001,
      kind: opts.kind ?? 'code',
    }
    return { id: 'stub', content: next.content, cost, model: opts.model }
  }
}

const PASS = JSON.stringify({ summary: 'ok', verdict: 'pass', findings: [] })

/** Minimal git repo so readCheckoutSha / the secrets lane's base probe run. */
async function materializeRepo(dir: string, reportDir: string): Promise<void> {
  const git = (args: string[]) =>
    execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args])
  execFileSync('git', ['-C', dir, 'init', '-b', 'main'])
  await writeFile(join(dir, 'src.ts'), 'export const value = 1\n')
  await writeFile(
    join(dir, 'argus-reviewer.config.json'),
    JSON.stringify({ decisionModel: '', reportDir }),
  )
  git(['add', '-A'])
  git(['commit', '-m', 'head'])
}

const response = (body: unknown) =>
  ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
  }) as Response

const NOT_FOUND = { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) } as Response

interface FetchRoutes {
  /** Sticky-comment body when a baseline marker exists; undefined → no marker. */
  stickyBody?: string
  /** compare(status) for the candidate..head call; '404' maps to undefined. */
  compareStatus?: string
  /** Files the compare call returns on incremental verification. */
  compareFiles?: { filename: string; patch: string }[]
  compareCommits?: number
  /** Whether the candidate SHA carries the argus-reviewer commit status. */
  reviewedStatus?: boolean
  /** Files the pulls/files fallback returns. */
  prFiles?: { filename: string; patch: string }[]
}

/**
 * Route api.github.com calls the way a real PR-context run does:
 * /pulls (meta + merge-base compare), /issues/comments (sticky baseline),
 * /commits/<sha>/status (the forge check), /compare (incremental files).
 */
function stubGitHub(routes: FetchRoutes) {
  const seen: string[] = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = String(input)
    seen.push(url)
    if (url.includes('/issues/1/comments')) {
      return response(
        routes.stickyBody !== undefined ? [{ body: routes.stickyBody }] : [{ body: 'plain comment' }],
      )
    }
    // Commit-status check — the candidate SHA (PREV) and, on the
    // equal-to-head path, HEAD itself.
    if (/^https:\/\/api\.github\.com\/repos\/o\/r\/commits\/[0-9a-f]+\/status/.test(url)) {
      return response({
        statuses:
          routes.reviewedStatus === true ? [{ context: 'argus-reviewer', state: 'success' }] : [],
      })
    }
    if (url.includes('/compare/')) {
      if (url.includes(`/compare/${PREV}`)) {
        if (routes.compareStatus === '404') return NOT_FOUND
        return response({
          status: routes.compareStatus ?? 'ahead',
          total_commits: routes.compareCommits ?? 2,
          merge_base_commit: { sha: PREV },
          files: routes.compareFiles ?? [
            { filename: 'src/new.ts', patch: '@@ -0,0 +1 @@\n+export const n = 1' },
          ],
        })
      }
      // fetchPrMeta's merge-base derivation.
      return response({ merge_base_commit: { sha: MERGE_BASE } })
    }
    if (url.includes('/pulls/1/files')) {
      return response(
        routes.prFiles ?? [
          { filename: 'src.ts', patch: '@@ -1 +1 @@\n-old\n+new' },
          { filename: 'src/old.ts', patch: '@@ -1 +1 @@\n-a\n+b' },
        ],
      )
    }
    if (url.includes('/pulls/1')) {
      return response({
        head: { sha: HEAD, repo: { fork: false } },
        base: { sha: 'f'.repeat(40), ref: 'main' },
        author_association: 'MEMBER',
        labels: [],
      })
    }
    if (url.includes('/check-runs')) return response({ check_runs: [] })
    throw new Error(`unexpected fetch: ${url}`)
  })
  return seen
}

function runReview(cwd: string, reportDir: string, client: StubClient, args: string[] = [], env: Record<string, string> = {}) {
  return main(['code-review', '--report-dir', reportDir, ...args], {
    cwd,
    env: {
      ...MIN_ENV,
      GITHUB_REPOSITORY: 'o/r',
      GITHUB_TOKEN: 'token',
      OPENROUTER_API_KEY: 'test-key',
      ARGUS_REVIEWER_TRACE: JSON.stringify({ repo: 'o/r', pr: '1' }),
      ...env,
    },
    out: () => undefined,
    err: () => undefined,
    createClient: () => client,
  })
}

const STICKY = (sha: string) =>
  `<!-- argus-reviewer -->\n### Argus: passed\n...\n<!-- argus:last-reviewed-sha:${sha} -->`

describe('parseMention — review full', () => {
  it('captures the full arg on review', () => {
    expect(parseMention('@argus review full')).toEqual({ name: 'review', arg: 'full' })
    expect(parseMention('@argus review')).toEqual({ name: 'review' })
    expect(parseMention('@argus review nonsense')).toEqual({ name: 'review', arg: 'nonsense' })
  })
})

describe('code-review — incremental baseline', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('honors a verified baseline: covers only base..head, names the range', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'argus-inc-'))
    const reportDir = join(cwd, 'report')
    await materializeRepo(cwd, reportDir)
    const seen = stubGitHub({
      stickyBody: STICKY(PREV),
      reviewedStatus: true,
      compareStatus: 'ahead',
      compareCommits: 2,
    })
    const client = new StubClient([{ content: PASS }])
    const code = await runReview(cwd, reportDir, client)
    expect(code).toBe(0)
    // The incremental diff came from compare — the pulls/files endpoint never ran.
    expect(seen.some((u) => u.includes('/pulls/1/files'))).toBe(false)
    expect(seen.some((u) => u.includes(`/compare/${PREV}...${HEAD}`))).toBe(true)
    const report = JSON.parse(await readFile(join(reportDir, 'code-review.json'), 'utf8'))
    expect(report.incremental).toEqual({ since: PREV, commits: 2 })
    expect(report.diffRange).toEqual({ base: 'last-reviewed', baseSha: PREV, headSha: HEAD })
    expect(report.reviewedHeadSha).toBe(HEAD)
    expect(client.calls.length).toBeGreaterThan(0)
    const prompt = JSON.stringify(client.calls.map((c) => c.messages))
    expect(prompt).toContain('src/new.ts')
    expect(prompt).not.toContain('src/old.ts')
  })

  it('equal-to-head: informational skip, no model calls, marker preserved', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'argus-inc-'))
    const reportDir = join(cwd, 'report')
    await materializeRepo(cwd, reportDir)
    stubGitHub({ stickyBody: STICKY(HEAD), reviewedStatus: true })
    const client = new StubClient([])
    const code = await runReview(cwd, reportDir, client)
    expect(code).toBe(0)
    const report = JSON.parse(await readFile(join(reportDir, 'code-review.json'), 'utf8'))
    expect(report.skipped).toBe(true)
    expect(report.summary).toContain('unchanged')
    // The baseline survives the informational run — the next push diffs from it.
    expect(report.reviewedHeadSha).toBe(HEAD)
    expect(report.incremental).toEqual({ since: HEAD, commits: 0 })
    expect(client.calls).toHaveLength(0)
  })

  it('forged marker: ancestor SHA with no Argus status falls back to the full diff', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'argus-inc-'))
    const reportDir = join(cwd, 'report')
    await materializeRepo(cwd, reportDir)
    const seen = stubGitHub({
      stickyBody: STICKY(PREV),
      reviewedStatus: false, // the PR author edited the comment — no Argus run exists there
      compareStatus: 'ahead',
    })
    const client = new StubClient([{ content: PASS }])
    const errs: string[] = []
    const code = await main(['code-review', '--report-dir', reportDir], {
      cwd,
      env: {
        ...MIN_ENV,
        GITHUB_REPOSITORY: 'o/r',
        GITHUB_TOKEN: 'token',
        OPENROUTER_API_KEY: 'test-key',
        ARGUS_REVIEWER_TRACE: JSON.stringify({ repo: 'o/r', pr: '1' }),
      },
      out: () => undefined,
      err: (l: string) => errs.push(l),
      createClient: () => client,
    })
    expect(code).toBe(0)
    expect(seen.some((u) => u.includes('/pulls/1/files'))).toBe(true)
    const report = JSON.parse(await readFile(join(reportDir, 'code-review.json'), 'utf8'))
    expect(report.incremental.rejected).toContain('no Argus commit status')
    expect(report.incremental.since).toBeUndefined()
    expect(report.diffRange.baseSha).toBe(MERGE_BASE)
    expect(errs.some((l) => l.includes('forged'))).toBe(true)
  })

  it('force-push: a diverged stored SHA falls back to the full diff', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'argus-inc-'))
    const reportDir = join(cwd, 'report')
    await materializeRepo(cwd, reportDir)
    const seen = stubGitHub({
      stickyBody: STICKY(PREV),
      reviewedStatus: true,
      compareStatus: 'diverged',
    })
    const client = new StubClient([{ content: PASS }])
    const code = await runReview(cwd, reportDir, client)
    expect(code).toBe(0)
    expect(seen.some((u) => u.includes('/pulls/1/files'))).toBe(true)
    const report = JSON.parse(await readFile(join(reportDir, 'code-review.json'), 'utf8'))
    expect(report.incremental.rejected).toContain('not an ancestor')
  })

  it('unreachable in a shallow clone: full diff with a named reason', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'argus-inc-'))
    const reportDir = join(cwd, 'report')
    await materializeRepo(cwd, reportDir)
    stubGitHub({ stickyBody: STICKY(PREV), compareStatus: '404' })
    const client = new StubClient([{ content: PASS }])
    const code = await runReview(cwd, reportDir, client)
    expect(code).toBe(0)
    const report = JSON.parse(await readFile(join(reportDir, 'code-review.json'), 'utf8'))
    expect(report.incremental.rejected).toContain('unreachable')
  })

  it('no marker on the sticky: full diff, no rejection record', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'argus-inc-'))
    const reportDir = join(cwd, 'report')
    await materializeRepo(cwd, reportDir)
    stubGitHub({ stickyBody: '<!-- argus-reviewer -->\n### Argus: passed\n' })
    const client = new StubClient([{ content: PASS }])
    const code = await runReview(cwd, reportDir, client)
    expect(code).toBe(0)
    const report = JSON.parse(await readFile(join(reportDir, 'code-review.json'), 'utf8'))
    expect(report.incremental).toBeUndefined()
    expect(report.reviewedHeadSha).toBe(HEAD)
  })

  it.each([
    { args: ['--full'], env: {} },
    { args: [] as string[], env: { ARGUS_REVIEW_FULL: '1' } },
  ])(
    '--full and ARGUS_REVIEW_FULL bypass the baseline entirely ($args / $env)',
    async ({ args, env }) => {
      const cwd = await mkdtemp(join(tmpdir(), 'argus-inc-'))
      const reportDir = join(cwd, 'report')
      await materializeRepo(cwd, reportDir)
      const seen = stubGitHub({ stickyBody: STICKY(PREV), reviewedStatus: true })
      const client = new StubClient([{ content: PASS }])
      const code = await runReview(cwd, reportDir, client, args, env)
      expect(code).toBe(0)
      // Forced full: the sticky baseline is never even read.
      expect(seen.some((u) => u.includes('/issues/1/comments'))).toBe(false)
      const report = JSON.parse(await readFile(join(reportDir, 'code-review.json'), 'utf8'))
      expect(report.incremental).toBeUndefined()
    },
  )
})
