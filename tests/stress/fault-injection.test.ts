/**
 * Stress / fault-injection suite — runs in the default test run (one shared
 * browser, ~2s). Every malformed model output or drifted element must
 * degrade gracefully: the engine returns a structured failure or recovers,
 * and the anomaly lands in `errorRecords` for the run journal.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { BrowserDriver } from '../../src/driver/browser.js'
import { Actions } from '../../src/engine/actions.js'
import { Engine, VisionClient } from '../../src/engine/loop.js'
import { resolveConfig, ProviderRules } from '../../src/config.js'
import { Ledger } from '../../src/vision/ledger.js'
import { CallCost, CallKind } from '../../src/vision/cost.js'
import { JsonSchema, Message } from '../../src/vision/openrouter.js'

const FIXTURE_URL = fileURLToPath(new URL('../fixtures/index.html', import.meta.url))

class FaultyClient implements VisionClient {
  calls = 0
  constructor(private responses: (string | Error)[]) {}
  async complete(opts: {
    model: string
    messages: Message[]
    schema?: JsonSchema
    escalationModels?: string[]
    provider?: ProviderRules
    kind?: CallKind
  }): Promise<{ id: string; content: string; cost: CallCost; model: string }> {
    this.calls++
    const next = this.responses.shift() ?? 'NO MORE RESPONSES'
    if (next instanceof Error) throw next
    const cost: CallCost = { model: opts.model, provider: 'fake', tokens: 1, costUsd: 0.0001, kind: opts.kind ?? 'ground' }
    return { id: `f${this.calls}`, content: next, model: opts.model, cost }
  }
}

function makeEngine(driver: BrowserDriver, client: VisionClient, cacheDir: string) {
  const config = resolveConfig({ cacheDir, budgetUsd: 1 })
  return new Engine({
    driver,
    actions: new Actions(driver),
    client,
    ledger: new Ledger(config.budgetUsd),
    config,
  })
}

describe('fault injection — model output garbage degrades gracefully', () => {
  let driver: BrowserDriver

  beforeAll(async () => {
    driver = await BrowserDriver.launch({ viewport: { width: 1280, height: 720 } })
  })
  beforeEach(async () => {
    await driver.goto(`file://${FIXTURE_URL}`)
  })
  afterAll(async () => {
    await driver.close()
  })

  it('non-JSON model output → locate fails with a reason, not a throw', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'argus-stress-'))
    const engine = makeEngine(driver, new FaultyClient(['the button is somewhere over there']), cacheDir)
    const r = await engine.locate('locate: the click button')
    expect(r.ok).toBe(false)
    expect(r.reason).toBeDefined()
    expect(engine.errorRecords.some((e) => e.stage === 'locate')).toBe(true)
  })

  it('non-finite coords are rejected and journaled, never reach elementFromPoint', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'argus-stress-'))
    const client = new FaultyClient([
      '{"action":"click","x":null,"y":null}',
      '{"action":"click","x":200,"y":130}',
      '{"action":"done"}',
    ])
    const engine = makeEngine(driver, client, cacheDir)
    const r = await engine.locate('locate: the click button')
    expect(r.ok).toBe(true)
    expect(engine.errorRecords.some((e) => e.message.includes('missing/invalid coords'))).toBe(true)
  })

  it('provider 5xx throws (hard failure) but still lands in errorRecords', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'argus-stress-'))
    const engine = makeEngine(driver, new FaultyClient([new Error('OpenRouter 502')]), cacheDir)
    await expect(engine.locate('locate: the click button')).rejects.toThrow('OpenRouter 502')
    expect(engine.errorRecords.some((e) => e.message === 'model call threw')).toBe(true)
  })

  it('empty response queue → structured failure, no uncaught paths', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'argus-stress-'))
    const engine = makeEngine(driver, new FaultyClient([]), cacheDir)
    const r = await engine.locate('locate: the click button')
    expect(r.ok).toBe(false)
  })

  it('a stale-flagged fingerprint re-grounds instead of replaying', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'argus-stress-'))
    const client = new FaultyClient([
      '{"action":"click","x":200,"y":130}',
      '{"action":"done"}',
    ])
    const engine = makeEngine(driver, client, cacheDir)
    const fake = {
      instruction: 'the click button',
      action: { type: 'click' as const, x: 200, y: 130 },
      bbox: { x: 150, y: 100, w: 100, h: 60 },
      clickPoint: { x: 200, y: 130 },
      model: 'fake',
      a11ySnippet: 'button "Click me"',
      regionHash: 'deadbeef',
      stale: 'diff touched app surface: src/App.tsx',
    }
    const r = await engine.locate('locate: the click button', fake)
    // Stale → bypass hash-verify, re-ground via exactly one model call,
    // producing a fresh fingerprint rather than replaying the stale one.
    expect(r.ok).toBe(true)
    expect(client.calls).toBe(1)
    expect(r.fingerprint).toBeDefined()
    expect(r.fingerprint).not.toBe(fake)
    expect(r.fingerprint?.regionHash).not.toBe('deadbeef')
    expect(engine.errorRecords.some((e) => e.message === 'cache entry invalidated by diff')).toBe(true)
  })
})
