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
})
