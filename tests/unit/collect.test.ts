import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { collect } from '../../scripts/collect.mjs'
import { archiveManifest } from '../../src/report/manifest.js'
import { fixtureManifest } from '../fixtures/manifest.js'

let dir = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'argus-collect-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, JSON.stringify(value), 'utf8')
}

type SanitizedManifest = {
  runId: string
  lanes: Record<string, { lane: string; status: string; reason?: string; summary?: string }>
}

async function workspaceOf(root: string) {
  const state = await collect(root)
  expect(state).toHaveProperty('workspace')
  return state.workspace as {
    reportDir: string
    runs: SanitizedManifest[]
    current: SanitizedManifest | undefined
    corrupt: number
    degraded?: string
  }
}

describe('collect workspace', () => {
  it('returns an empty workspace when no report dir exists', async () => {
    const w = await workspaceOf(dir)
    expect(w.runs).toEqual([])
    expect(w.current).toBeUndefined()
    expect(w.corrupt).toBe(0)
  })

  it('reads run-manifest.json from the configured reportDir', async () => {
    await writeJson(join(dir, 'argus-reviewer.config.json'), {
      repo: 'x/y',
      reportDir: 'custom-out',
    })
    await writeJson(
      join(dir, 'custom-out', 'run-manifest.json'),
      fixtureManifest({ runId: 'run-custom' }),
    )
    const w = await workspaceOf(dir)
    expect(w.reportDir).toBe(join(dir, 'custom-out'))
    expect(w.current?.runId).toBe('run-custom')
    expect(Object.keys(w.current?.lanes ?? {})).toEqual(['review', 'flow', 'app', 'a0'])
  })

  it('falls back to the newest valid archive when the current manifest is corrupt', async () => {
    const reports = join(dir, 'argus-reviewer-report')
    await mkdir(reports, { recursive: true })
    await writeFile(join(reports, 'run-manifest.json'), '{"schemaVersion":', 'utf8')
    await writeJson(join(reports, 'manifests', '2026-09-30-00-old.json'), fixtureManifest({ runId: 'run-old' }))
    await writeJson(join(reports, 'manifests', '2026-09-30-01-new.json'), fixtureManifest({ runId: 'run-new' }))
    const w = await workspaceOf(dir)
    expect(w.current?.runId).toBe('run-new')
    expect(w.degraded).toBeTruthy()
    // runs are the archive directory in name order (timestamp-prefixed → chronological).
    expect(w.runs.map((r) => r.runId)).toEqual(['run-old', 'run-new'])
  })

  it('uses the latest archive as current when no run-manifest.json exists', async () => {
    const reports = join(dir, 'argus-reviewer-report')
    await writeJson(join(reports, 'manifests', '2026-09-29-00.json'), fixtureManifest({ runId: 'run-a' }))
    await writeJson(join(reports, 'manifests', '2026-09-30-00.json'), fixtureManifest({ runId: 'run-b' }))
    const w = await workspaceOf(dir)
    expect(w.current?.runId).toBe('run-b')
    expect(w.degraded).toBeUndefined()
    expect(w.runs).toHaveLength(2)
  })

  it('counts corrupt archives and skips invalid shapes without losing valid runs', async () => {
    const reports = join(dir, 'argus-reviewer-report')
    await writeJson(join(reports, 'run-manifest.json'), fixtureManifest({ runId: 'run-ok' }))
    await mkdir(join(reports, 'manifests'), { recursive: true })
    await writeFile(join(reports, 'manifests', 'garbage.json'), 'not json{', 'utf8')
    await writeJson(join(reports, 'manifests', 'bad-shape.json'), { schemaVersion: 99 })
    await writeJson(join(reports, 'manifests', '2026-09-30-00-valid.json'), fixtureManifest({ runId: 'run-valid' }))
    const w = await workspaceOf(dir)
    expect(w.current?.runId).toBe('run-ok')
    expect(w.corrupt).toBe(2)
    // runs is the archive dir; the current manifest reports separately.
    expect(w.runs.map((r) => r.runId)).toEqual(['run-valid'])
  })

  it('masks secret-shaped strings in lane evidence', async () => {
    const m = fixtureManifest()
    m.lanes.flow.reason = 'provider key sk-or-v1-abcdef12345 rejected'
    await writeJson(join(dir, 'argus-reviewer-report', 'run-manifest.json'), m)
    const w = await workspaceOf(dir)
    expect(w.current?.lanes.flow?.reason).toBe('provider key ••• rejected')
  })

  it('masks bearer tokens, JWTs, and userinfo credentials in lane evidence', async () => {
    const m = fixtureManifest()
    // The JWT is concatenated at runtime — a literal three-segment token in
    // the file trips secret scanners even though it's a deliberate fake.
    m.lanes.flow.reason =
      'auth failed: Bearer abcdefghijklmnop and ' +
      `eyJhbGciOiJIUzI1NiJ9.${'eyJzdWIiOiIxMjM0In0'}.signaturepart` +
      ' and https://user:passw0rd@host/x'
    await writeJson(join(dir, 'argus-reviewer-report', 'run-manifest.json'), m)
    const w = await workspaceOf(dir)
    const reason = w.current?.lanes.flow?.reason ?? ''
    expect(reason).not.toContain('abcdefghijklmnop')
    expect(reason).not.toContain('eyJhbGciOiJIUzI1NiJ9')
    expect(reason).not.toContain('passw0rd')
    expect(reason).toContain('•••')
  })

  it('deduplicates overlapping polls — concurrent collect(root) shares one sweep', async () => {
    const reports = join(dir, 'argus-reviewer-report')
    await writeJson(join(reports, 'run-manifest.json'), fixtureManifest({ runId: 'run-x' }))
    const [a, b, c] = await Promise.all([collect(dir), collect(dir), collect(dir)])
    // The dedup returns the same in-flight result — identical object.
    expect(b).toBe(a)
    expect(c).toBe(a)
    expect(a.workspace.current?.runId).toBe('run-x')
  })

  it('re-reads an archive whose mtime changed — the cache must not serve stale content', async () => {
    const reports = join(dir, 'argus-reviewer-report')
    const archive = join(reports, 'manifests', '2026-09-30-00.json')
    await writeJson(archive, fixtureManifest({ runId: 'run-v1' }))
    const first = await workspaceOf(dir)
    expect(first.runs[0]?.runId).toBe('run-v1')
    // Rewrite with a newer mtime — the next poll must reflect it.
    const { utimes } = await import('node:fs/promises')
    await writeJson(archive, fixtureManifest({ runId: 'run-v2' }))
    const now = new Date()
    await utimes(archive, now, now)
    const second = await workspaceOf(dir)
    expect(second.runs[0]?.runId).toBe('run-v2')
  })
})

describe('archiveManifest', () => {
  it('stores manifests under manifests/ and prunes to the retention bound', async () => {
    const reports = join(dir, 'reports')
    await mkdir(reports, { recursive: true })
    for (const [i, runId] of ['2026-01-a', '2026-02-b', '2026-03-c'].entries()) {
      await archiveManifest(
        reports,
        fixtureManifest({ runId, startedAt: `2026-09-3${i}T00:00:00.000Z` }),
        2,
      )
    }
    const names = (await readdir(join(reports, 'manifests'))).sort()
    expect(names).toEqual(['2026-02-b.json', '2026-03-c.json'])
    const kept = JSON.parse(await readFile(join(reports, 'manifests', '2026-03-c.json'), 'utf8'))
    expect(kept.runId).toBe('2026-03-c')
  })

  it('keeps nothing when retention is 0', async () => {
    const reports = join(dir, 'reports')
    await archiveManifest(reports, fixtureManifest({ runId: 'x' }), 0)
    expect(existsSync(join(reports, 'manifests'))).toBe(false)
  })

  it('sanitizes a hostile runId before it becomes an archive filename', async () => {
    const reports = join(dir, 'reports')
    const m = fixtureManifest({ runId: '../../escape/../evil' })
    await archiveManifest(reports, m, 5)
    const names = await readdir(join(reports, 'manifests'))
    // Sanitized to a single flat name inside the archive dir — no traversal.
    expect(names).toEqual(['..-..-escape-..-evil.json'])
    expect(existsSync(join(dir, 'evil.json'))).toBe(false)
    expect(existsSync(join(reports, 'evil.json'))).toBe(false)
  })
})

describe('collect gh source state (U12)', () => {
  const savedPath = process.env.PATH

  afterEach(() => {
    process.env.PATH = savedPath
  })

  async function fakeGh(script: string): Promise<string> {
    const bin = join(dir, 'bin')
    await mkdir(bin, { recursive: true })
    await writeFile(join(bin, 'gh'), `#!/bin/sh\n${script}\n`, { mode: 0o755 })
    return bin
  }

  it('reports gh missing as a typed state, not an empty PR list', async () => {
    const empty = join(dir, 'empty-bin')
    await mkdir(empty, { recursive: true })
    process.env.PATH = empty
    const state = await collect(dir)
    expect(state.sources.gh.state).toBe('missing')
    expect(state.prs).toEqual([])
  })

  it('reports a signed-out gh as unauthenticated', async () => {
    process.env.PATH = await fakeGh(
      "echo 'To get started with GitHub CLI, please run:  gh auth login' >&2\nexit 4",
    )
    const state = await collect(dir)
    expect(state.sources.gh.state).toBe('unauthenticated')
  })

  it('reports any other gh failure as error with its first line', async () => {
    process.env.PATH = await fakeGh("echo 'HTTP 502: bad gateway' >&2\nexit 1")
    const state = await collect(dir)
    expect(state.sources.gh.state).toBe('error')
    expect(state.sources.gh.detail).toMatch(/HTTP 502/)
  })

  it('reports ok when gh answers', async () => {
    process.env.PATH = `${await fakeGh("echo '[]'")}:${savedPath}`
    const state = await collect(dir)
    expect(state.sources.gh.state).toBe('ok')
  })
})
