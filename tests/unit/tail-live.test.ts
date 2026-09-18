import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendFileSync, renameSync, writeFileSync } from 'node:fs'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// @ts-expect-error plain-node helper — no type declarations
import { createLiveTailer } from '../../scripts/tail-live.mjs'

const line = (msg: string): string =>
  `${JSON.stringify({ ts: Date.now(), source: 'code-review', level: 'info', msg })}\n`

describe('createLiveTailer', () => {
  it('emits nothing for a nonexistent file', async () => {
    const seen: unknown[] = []
    const t = createLiveTailer('/nonexistent/live.ndjson', { onLine: (e) => seen.push(e) })
    await t.poll()
    expect(seen).toHaveLength(0)
  })

  it('seeds recent history on first poll, then emits only new lines', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'argus-tail-'))
    const p = join(dir, 'live.ndjson')
    writeFileSync(p, line('old-1') + line('old-2'))
    const seen: { msg: string }[] = []
    const t = createLiveTailer(p, { onLine: (e) => seen.push(e) })
    await t.poll()
    expect(seen.map((e) => e.msg)).toEqual(['old-1', 'old-2'])
    appendFileSync(p, line('new-1'))
    await t.poll()
    expect(seen.map((e) => e.msg)).toEqual(['old-1', 'old-2', 'new-1'])
  })

  it('holds a partial last line until the newline arrives', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'argus-tail-'))
    const p = join(dir, 'live.ndjson')
    writeFileSync(p, line('complete'))
    const seen: { msg: string }[] = []
    const t = createLiveTailer(p, { onLine: (e) => seen.push(e) })
    await t.poll()
    appendFileSync(p, JSON.stringify({ ts: 1, source: 's', level: 'info', msg: 'partial' }))
    await t.poll()
    expect(seen.map((e) => e.msg)).toEqual(['complete'])
    appendFileSync(p, '\n')
    await t.poll()
    expect(seen.map((e) => e.msg)).toEqual(['complete', 'partial'])
  })

  it('skips malformed lines (concurrent partial writes)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'argus-tail-'))
    const p = join(dir, 'live.ndjson')
    writeFileSync(p, 'not json\n' + line('good'))
    const seen: { msg: string }[] = []
    const t = createLiveTailer(p, { onLine: (e) => seen.push(e) })
    await t.poll()
    expect(seen.map((e) => e.msg)).toEqual(['good'])
  })

  it('re-seeds after atomic rotation (new inode) without duplicating', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'argus-tail-'))
    const p = join(dir, 'live.ndjson')
    writeFileSync(p, line('pre-rotation'))
    const seen: { msg: string }[] = []
    const t = createLiveTailer(p, { onLine: (e) => seen.push(e) })
    await t.poll()
    // live.ts rotates via tmp-file + rename → the path gets a new inode.
    writeFileSync(`${p}.tmp`, line('rotated-1'))
    renameSync(`${p}.tmp`, p)
    appendFileSync(p, line('rotated-2'))
    await t.poll()
    // Post-rotation content is re-seeded once — pre-rotation line is not
    // re-emitted and rotated-1/2 are not duplicated.
    expect(seen.map((e) => e.msg)).toEqual(['pre-rotation', 'rotated-1', 'rotated-2'])
  })

  it('recovers when the file is truncated under it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'argus-tail-'))
    const p = join(dir, 'live.ndjson')
    writeFileSync(p, line('a') + line('b') + line('c'))
    const seen: { msg: string }[] = []
    const t = createLiveTailer(p, { onLine: (e) => seen.push(e) })
    await t.poll()
    writeFileSync(p, line('fresh')) // same inode, smaller size → offset resets
    await t.poll()
    expect(seen.map((e) => e.msg)).toEqual(['a', 'b', 'c', 'fresh'])
  })
})

describe('debug() live-dir routing', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubEnv('ARGUS_DEBUG', '1')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('writes to the configured live dir after setLiveDir', async () => {
    const custom = await mkdtemp(join(tmpdir(), 'argus-live-'))
    const { debug, setLiveDir } = await import('../../src/debug.js')
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    setLiveDir(custom)
    debug('code-review', 'routed')
    errSpy.mockRestore()
    const content = await import('node:fs/promises').then((fs) =>
      fs.readFile(join(custom, 'live.ndjson'), 'utf8'),
    )
    expect(JSON.parse(content.trim()).msg).toBe('routed')
    setLiveDir(undefined)
  })
})

describe('collect() live + review data', () => {
  it('includes recent live lines and the review summary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'argus-collect-'))
    await mkdir(join(root, '.argus-reviewer-cache'), { recursive: true })
    await mkdir(join(root, 'argus-reviewer-report'), { recursive: true })
    writeFileSync(
      join(root, '.argus-reviewer-cache', 'live.ndjson'),
      line('stage one') + line('stage two'),
    )
    await writeFile(
      join(root, 'argus-reviewer-report', 'code-review.json'),
      JSON.stringify({
        verdict: 'needs_changes',
        findings: [{ file: 'a.ts' }, { file: 'b.ts' }],
        visionCostUsd: 0.0123,
        tokens: 4000,
        model: 'test/model',
      }),
    )
    const { collect } = await import('../../scripts/collect.mjs')
    const state = await collect(root)
    expect(state.live.map((e: { msg: string }) => e.msg)).toEqual(['stage one', 'stage two'])
    expect(state.review).toMatchObject({
      verdict: 'needs_changes',
      findings: 2,
      model: 'test/model',
      tokens: 4000,
    })
  })

  it('returns empty live/review when artifacts are absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'argus-collect-'))
    const { collect } = await import('../../scripts/collect.mjs')
    const state = await collect(root)
    expect(state.live).toEqual([])
    expect(state.review).toBeUndefined()
  })
})
