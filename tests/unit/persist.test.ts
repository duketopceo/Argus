import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ProbeRecord } from '../../src/probe/queue.js'
import {
  decodeProbePayload,
  encodeProbePayload,
  PERSIST_MARKER,
  persistProbes,
  selectPersistable,
} from '../../src/probe/persist.js'

const record = (overrides: Partial<ProbeRecord> = {}): ProbeRecord => ({
  file: 'argus-probe-x.test.ts',
  findingFile: 'src/x.ts',
  findingLine: 12,
  outcome: 'reproduced',
  durationMs: 1,
  costUsd: 0,
  tokens: 0,
  detail: 'reproduced',
  ...overrides,
})

const ctx = { err: (_line: string) => undefined }

describe('selectPersistable', () => {
  it('selects reproduced probes with serialized content + a safe path', () => {
    const probes = selectPersistable([
      record({ path: 'tests/argus-probe-x.test.ts', content: 'test("x", () => {})' }),
      record({ outcome: 'clean' }),
      record({ path: undefined, content: 'x' }),
      record({ path: 'tests/argus-probe-y.test.ts', content: '' }),
    ])
    expect(probes.map((p) => p.path)).toEqual(['tests/argus-probe-x.test.ts'])
    expect(probes[0]?.file).toBe('argus-probe-x.test.ts')
    expect(probes[0]?.findingFile).toBe('src/x.ts')
  })

  it('rejects unsafe paths and non-probe filenames', () => {
    for (const path of [
      '../evil.ts',
      '/abs/evil.ts',
      'tests/evil..ts',
      'tests/regression.test.ts',
      'tests\\win.ts',
    ]) {
      const probes = selectPersistable([record({ path, content: 'x' })])
      expect(probes, path).toEqual([])
    }
  })

  it('caps at three probes and drops oversized content', () => {
    const big = 'x'.repeat(12 * 1024 + 1)
    const probes = selectPersistable([
      record({ path: 'tests/argus-probe-a.test.ts', content: 'a' }),
      record({ path: 'tests/argus-probe-big.test.ts', content: big }),
      record({ path: 'tests/argus-probe-b.test.ts', content: 'b' }),
      record({ path: 'tests/argus-probe-c.test.ts', content: 'c' }),
      record({ path: 'tests/argus-probe-d.test.ts', content: 'd' }),
    ])
    expect(probes.map((p) => p.path)).toEqual([
      'tests/argus-probe-a.test.ts',
      'tests/argus-probe-b.test.ts',
      'tests/argus-probe-c.test.ts',
    ])
  })
})

describe('encodeProbePayload / decodeProbePayload', () => {
  const records = [
    record({ path: 'tests/argus-probe-x.test.ts', content: 'test("x", () => {})' }),
  ]

  it('round-trips through the marker comment', () => {
    const marker = encodeProbePayload(records, 'abc123')
    expect(marker).toBeDefined()
    expect(marker).toContain(PERSIST_MARKER)
    const decoded = decodeProbePayload(`## argus\nsome text\n${marker}\nmore`)
    expect(decoded?.head).toBe('abc123')
    expect(decoded?.probes).toEqual([
      {
        path: 'tests/argus-probe-x.test.ts',
        content: 'test("x", () => {})',
        file: 'argus-probe-x.test.ts',
        findingFile: 'src/x.ts',
      },
    ])
  })

  it('returns undefined when nothing is persistable', () => {
    expect(encodeProbePayload(undefined, 'x')).toBeUndefined()
    expect(encodeProbePayload([record({ outcome: 'error' })], 'x')).toBeUndefined()
    expect(decodeProbePayload('no marker here')).toBeUndefined()
  })

  it('rejects tampered or malformed payloads', () => {
    expect(decodeProbePayload(`${PERSIST_MARKER}not-b64!! -->`)).toBeUndefined()
    expect(decodeProbePayload(`${PERSIST_MARKER}${Buffer.from('{bad json').toString('base64')} -->`)).toBeUndefined()
    // Wrong version.
    const wrongV = Buffer.from(JSON.stringify({ v: 2, probes: [] })).toString('base64')
    expect(decodeProbePayload(`${PERSIST_MARKER}${wrongV} -->`)).toBeUndefined()
    // Path traversal in the payload fails closed.
    const evil = Buffer.from(
      JSON.stringify({ v: 1, probes: [{ path: '../evil.ts', content: 'x' }] }),
    ).toString('base64')
    expect(decodeProbePayload(`${PERSIST_MARKER}${evil} -->`)).toBeUndefined()
    // Two markers — ambiguous, fail closed.
    const marker = encodeProbePayload(records, 'x') ?? ''
    expect(decodeProbePayload(`${marker}\n${marker}`)).toBeUndefined()
    // Unterminated marker.
    expect(decodeProbePayload(PERSIST_MARKER)).toBeUndefined()
  })
})

describe('persistProbes', () => {
  afterEach(() => vi.unstubAllGlobals())

  const probe = { path: 'tests/argus-probe-x.test.ts', content: 'test("x",()=>{})', file: 'f' }

  const stubGithub = (handlers: Record<string, { status: number; body: unknown }>) => {
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

  it('creates branch, commits probes, and opens the PR', async () => {
    const calls = stubGithub({
      'GET /repos/a/b/git/ref/heads/main': { status: 200, body: { object: { sha: 'base' } } },
      'POST /repos/a/b/git/refs': { status: 201, body: {} },
      [`PUT /repos/a/b/contents/${encodeURIComponent(probe.path)}`]: { status: 201, body: {} },
      'GET /repos/a/b/pulls?head=a%3Aargus%2Fprobe-regression-pr-7&state=open': {
        status: 200,
        body: [],
      },
      'POST /repos/a/b/pulls': {
        status: 201,
        body: { html_url: 'https://github.com/a/b/pull/9' },
      },
    })
    const res = await persistProbes('a/b', '7', 'main', [probe], 'tok', ctx)
    expect(res.prUrl).toBe('https://github.com/a/b/pull/9')
    expect(res.written).toEqual([probe.path])
    expect(res.skipped).toEqual([])
    expect(res.error).toBeUndefined()
    const put = calls.find((c) => c.method === 'PUT')
    expect((put?.body as { branch: string }).branch).toBe('argus/probe-regression-pr-7')
    const post = calls.find((c) => c.method === 'POST' && c.url.endsWith('/pulls'))
    expect((post?.body as { base: string }).base).toBe('main')
    // U6: the heal note keeps its warning without an emoji or an em-dash.
    const prBody = (post?.body as { body: string }).body
    expect(prBody).toContain('Probe source is model-authored')
    expect(prBody).toContain('review before merging')
    expect(prBody).not.toMatch(/\p{Extended_Pictographic}|\u{FE0F}/u)
    expect(prBody).not.toContain('\u2014')
  })

  it('is idempotent — existing branch, existing file, existing open PR', async () => {
    stubGithub({
      'GET /repos/a/b/git/ref/heads/main': { status: 200, body: { object: { sha: 'base' } } },
      'POST /repos/a/b/git/refs': { status: 422, body: { message: 'exists' } },
      [`PUT /repos/a/b/contents/${encodeURIComponent(probe.path)}`]: {
        status: 422,
        body: { message: 'sha required' },
      },
      'GET /repos/a/b/pulls?head=a%3Aargus%2Fprobe-regression-pr-7&state=open': {
        status: 200,
        body: [{ html_url: 'https://github.com/a/b/pull/9' }],
      },
    })
    const res = await persistProbes('a/b', '7', 'main', [probe], 'tok', ctx)
    expect(res.prUrl).toBe('https://github.com/a/b/pull/9')
    expect(res.written).toEqual([])
    expect(res.skipped).toEqual([probe.path])
  })

  it('fails cleanly when the base ref cannot be resolved', async () => {
    stubGithub({})
    const res = await persistProbes('a/b', '7', 'main', [probe], 'tok', ctx)
    expect(res.error).toContain('base ref')
  })
})
