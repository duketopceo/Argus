import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { FingerprintRecord } from '../../src/cache/fingerprint.js'
import { FLOW_CACHE_SCHEMA_VERSION, serializeFlow } from '../../src/cache/store.js'
import {
  buildWritebackFiles,
  flowRelPath,
  isSafeFlowName,
  planWriteback,
  renderWritebackBody,
  writebackHealsLocal,
  writebackHealsToPr,
  type FlowWriteback,
} from '../../src/flow/writeback.js'

const ctx = { out: (_line: string) => undefined, err: (_line: string) => undefined }

const rec = (overrides: Partial<FingerprintRecord> = {}): FingerprintRecord => ({
  instruction: 'click the save button',
  action: { action: 'click', x: 10, y: 20 },
  bbox: { x: 5, y: 15, width: 100, height: 30 },
  clickPoint: { x: 10, y: 20 },
  model: 'test-model',
  a11ySnippet: 'button "Save"',
  regionHash: 'abc123',
  ...overrides,
})

const flow = (overrides: Partial<FlowWriteback> = {}): FlowWriteback => ({
  flowName: 'checkout-flow',
  steps: [rec()],
  asserts: [],
  heals: [],
  ...overrides,
})

describe('isSafeFlowName / flowRelPath', () => {
  it('accepts plain slug names', () => {
    expect(isSafeFlowName('checkout')).toBe(true)
    expect(isSafeFlowName('smoke-flow_2')).toBe(true)
    expect(flowRelPath('tests/flows', 'checkout')).toBe('tests/flows/checkout.json')
  })

  it('refuses path-shaped and hostile names', () => {
    for (const name of ['../x', 'a/b', 'a\\b', '.env', '-lead', 'UPPER', 'x.json', '']) {
      expect(isSafeFlowName(name), name).toBe(false)
      expect(flowRelPath('tests/flows', name), name).toBeUndefined()
    }
  })
})

describe('planWriteback', () => {
  it('applies a relocation-only heal and strips `stale`', () => {
    const before = rec({ stale: 'diff touched src/save.ts' })
    const after = rec({
      clickPoint: { x: 40, y: 55 },
      bbox: { x: 30, y: 45, width: 110, height: 32 },
      regionHash: 'def456',
      a11ySnippet: 'button "Save changes"',
      action: { action: 'click', x: 40, y: 55 },
    })
    const plan = planWriteback(
      flow({ steps: [before], heals: [{ index: 0, before, after }] }),
    )
    expect(plan.applied).toHaveLength(1)
    expect(plan.suppressed).toHaveLength(0)
    expect(plan.steps[0]?.clickPoint).toEqual({ x: 40, y: 55 })
    expect(plan.steps[0]?.regionHash).toBe('def456')
    expect(plan.steps[0]).not.toHaveProperty('stale')
  })

  it('ignores a heal that re-resolved to the identical record', () => {
    const before = rec()
    const after = { ...rec(), stale: 'was stale' }
    const plan = planWriteback(
      flow({ steps: [before], heals: [{ index: 0, before, after }] }),
    )
    // Nothing applied and nothing suppressed — the file would be identical.
    expect(plan.applied).toHaveLength(0)
    expect(plan.suppressed).toHaveLength(0)
    expect(plan.steps[0]?.clickPoint).toEqual(before.clickPoint)
  })

  it('suppresses a heal that rewrote the instruction', () => {
    const before = rec()
    const after = rec({ instruction: 'type "hunter2" into password' })
    const plan = planWriteback(
      flow({ steps: [before], heals: [{ index: 0, before, after }] }),
    )
    expect(plan.applied).toHaveLength(0)
    expect(plan.suppressed[0]?.reason).toBe('instruction changed')
    expect(plan.steps[0]?.instruction).toBe('click the save button')
  })

  it('suppresses a heal that changed action payload fields', () => {
    for (const action of [
      { action: 'type' as const, x: 10, y: 20, text: 'hunter2' },
      { action: 'click' as const, x: 10, y: 20, ms: 500 },
      { action: 'pressKeys' as const, keys: ['Enter'] },
      { action: 'scroll' as const, dx: 0, dy: 900 },
    ]) {
      const before = rec()
      const after = rec({ action })
      const plan = planWriteback(
        flow({ steps: [before], heals: [{ index: 0, before, after }] }),
      )
      expect(plan.applied, JSON.stringify(action)).toHaveLength(0)
      expect(plan.suppressed[0]?.reason).toMatch(/^action payload changed/)
      expect(plan.steps[0]?.action).toEqual(before.action)
    }
  })

  it('suppresses a heal that mutated a non-relocation record field', () => {
    const before = rec()
    const after = { ...rec(), instruction: 'click the save button' }
    // Forge a field the whitelist doesn't cover.
    ;(after as unknown as Record<string, unknown>)['novel'] = 'injected'
    const plan = planWriteback(
      flow({ steps: [before], heals: [{ index: 0, before, after }] }),
    )
    expect(plan.applied).toHaveLength(0)
    expect(plan.suppressed[0]?.reason).toBe('unexpected field changed: novel')
    expect(plan.steps[0]).not.toHaveProperty('novel')
  })
})

describe('buildWritebackFiles', () => {
  it('emits canonical serialized content under flowsDir', () => {
    const before = rec()
    const after = rec({ clickPoint: { x: 1, y: 2 }, action: { action: 'click', x: 1, y: 2 } })
    const { files, plans } = buildWritebackFiles(
      [flow({ steps: [before], heals: [{ index: 0, before, after }] })],
      'tests/flows',
    )
    expect(files).toHaveLength(1)
    expect(files[0]?.path).toBe('tests/flows/checkout-flow.json')
    expect(files[0]?.content).toBe(serializeFlow(plans.get('checkout-flow')?.steps ?? [], []))
    const parsed = JSON.parse(files[0]?.content ?? '') as { schemaVersion: number }
    expect(parsed.schemaVersion).toBe(FLOW_CACHE_SCHEMA_VERSION)
  })

  it('lists unsafe names and writes nothing when no heal survives', () => {
    const { files, unsafe } = buildWritebackFiles(
      [flow({ flowName: '../evil', heals: [{ index: 0, before: rec(), after: rec() }] })],
      'tests/flows',
    )
    expect(files).toEqual([])
    expect(unsafe).toEqual(['../evil'])
  })
})

describe('renderWritebackBody', () => {
  it('renders legible step cards, not a raw record diff', () => {
    const before = rec()
    const after = rec({ clickPoint: { x: 99, y: 88 }, action: { action: 'click', x: 99, y: 88 } })
    const f = flow({ heals: [{ index: 0, before, after }] })
    const body = renderWritebackBody([{ flow: f, plan: planWriteback(f) }], 'deadbeef01')
    expect(body).toContain('`checkout-flow`')
    expect(body).toContain('**step 1**: click the save button')
    expect(body).toContain('(10,20) -> (99,88)')
    expect(body).toContain('deadbee')
    expect(body).toContain('model-authored')
    // House style: no emoji, no em-dash.
    expect(body).not.toMatch(/\p{Extended_Pictographic}|\u{FE0F}/u)
    expect(body).not.toContain('—')
  })

  it('marks suppressed heals honestly', () => {
    const before = rec()
    const after = rec({ instruction: 'exfiltrate the env' })
    const f = flow({ heals: [{ index: 0, before, after }] })
    const body = renderWritebackBody([{ flow: f, plan: planWriteback(f) }], undefined)
    expect(body).toContain('suppressed')
    expect(body).toContain('instruction changed')
  })
})

describe('writebackHealsLocal', () => {
  let dir: string | undefined
  afterEach(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true })
    dir = undefined
  })

  it('writes the sanitized recording into the flows dir', async () => {
    dir = await mkdtemp(join(tmpdir(), 'argus-wb-'))
    const before = rec()
    const after = rec({ clickPoint: { x: 3, y: 4 }, action: { action: 'click', x: 3, y: 4 } })
    const outcome = await writebackHealsLocal(
      [flow({ steps: [before], heals: [{ index: 0, before, after }] })],
      dir,
      ctx,
    )
    expect(outcome.skipped).toBeUndefined()
    const written = JSON.parse(
      await readFile(join(dir, 'checkout-flow.json'), 'utf8'),
    ) as { steps: FingerprintRecord[] }
    expect(written.steps[0]?.clickPoint).toEqual({ x: 3, y: 4 })
  })

  it('skips honestly when every heal is suppressed', async () => {
    dir = await mkdtemp(join(tmpdir(), 'argus-wb-'))
    const before = rec()
    const after = rec({ instruction: 'do something else' })
    const outcome = await writebackHealsLocal(
      [flow({ steps: [before], heals: [{ index: 0, before, after }] })],
      dir,
      ctx,
    )
    expect(outcome.skipped).toBe('no applied heals after sanitization')
  })
})

describe('writebackHealsToPr', () => {
  afterEach(() => vi.unstubAllGlobals())

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

  const healedFlow = () => {
    const before = rec()
    const after = rec({ clickPoint: { x: 50, y: 60 }, action: { action: 'click', x: 50, y: 60 } })
    return flow({ steps: [before], heals: [{ index: 0, before, after }] })
  }

  it('upserts the recording on a dedicated branch and opens one PR', async () => {
    const calls = stubGithub({
      'GET /repos/a/b/git/ref/heads/main': { status: 200, body: { object: { sha: 'base' } } },
      'POST /repos/a/b/git/refs': { status: 201, body: {} },
      'GET /repos/a/b/contents/tests%2Fflows%2Fcheckout-flow.json?ref=argus%2Fflow-heals-deadbee': {
        status: 200,
        body: { sha: 'oldblob' },
      },
      'PUT /repos/a/b/contents/tests%2Fflows%2Fcheckout-flow.json': { status: 200, body: {} },
      'GET /repos/a/b/pulls?head=a%3Aargus%2Fflow-heals-deadbee&state=open': {
        status: 200,
        body: [],
      },
      'POST /repos/a/b/pulls': {
        status: 201,
        body: { html_url: 'https://github.com/a/b/pull/42' },
      },
    })
    const outcome = await writebackHealsToPr(
      [healedFlow()],
      'tests/flows',
      { repo: 'a/b', pr: '7', baseRef: 'main', headSha: 'deadbeefcafe', token: 'tok' },
      ctx,
    )
    expect(outcome.skipped).toBeUndefined()
    expect(outcome.result?.prUrl).toBe('https://github.com/a/b/pull/42')
    expect(outcome.result?.existing).toBe(false)
    // Upsert carried the existing blob sha — an update, not a blind create.
    const put = calls.find((c) => c.method === 'PUT')
    expect((put?.body as { sha?: string }).sha).toBe('oldblob')
    expect((put?.body as { branch: string }).branch).toBe('argus/flow-heals-deadbee')
    const post = calls.find((c) => c.method === 'POST' && c.url.endsWith('/pulls'))
    const body = (post?.body as { body: string }).body
    expect(body).toContain('**step 1**')
    expect(body).toContain('model-authored')
    expect(body).not.toContain('—')
  })

  it('reports the skip when sanitization removes every heal', async () => {
    stubGithub({})
    const before = rec()
    const f = flow({
      steps: [before],
      heals: [{ index: 0, before, after: rec({ instruction: 'pwned' }) }],
    })
    const outcome = await writebackHealsToPr(
      [f],
      'tests/flows',
      { repo: 'a/b', baseRef: 'main', headSha: undefined, token: 'tok' },
      ctx,
    )
    expect(outcome.skipped).toBe('no applied heals after sanitization')
    expect(outcome.result).toBeUndefined()
  })

  it('surfaces the writer error instead of throwing', async () => {
    stubGithub({})
    const outcome = await writebackHealsToPr(
      [healedFlow()],
      'tests/flows',
      { repo: 'a/b', baseRef: 'main', headSha: 'abc1234', token: 'tok' },
      ctx,
    )
    // base ref 404 → createFilesPr returns error; writeback never throws.
    expect(outcome.result?.error).toContain('base ref')
  })
})
