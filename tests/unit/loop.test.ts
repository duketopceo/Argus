import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { BrowserDriver } from '../../src/driver/browser.js'
import { Actions } from '../../src/engine/actions.js'
import { Engine, VisionClient } from '../../src/engine/loop.js'
import { resolveConfig, ProviderRules } from '../../src/config.js'
import { loadFlow } from '../../src/cache/store.js'
import { Ledger } from '../../src/vision/ledger.js'
import { CallCost, CallKind } from '../../src/vision/cost.js'
import { JsonSchema, Message } from '../../src/vision/openrouter.js'

const FIXTURE_URL = fileURLToPath(new URL('../fixtures/index.html', import.meta.url))

interface FakeCall {
  kind: CallKind
  model: string
}

class FakeClient implements VisionClient {
  calls: FakeCall[] = []
  private queue: { content: string; model?: string }[]

  constructor(queue: { content: string; model?: string }[] = []) {
    this.queue = [...queue]
  }

  reset() {
    this.calls = []
  }

  async complete(opts: {
    model: string
    messages: Message[]
    schema?: JsonSchema
    escalationModels?: string[]
    provider?: ProviderRules
    kind?: CallKind
  }): Promise<{ id: string; content: string; cost: CallCost; model: string }> {
    const next = this.queue.shift()
    if (!next) {
      throw new Error('fake client queue empty')
    }
    this.calls.push({ kind: opts.kind ?? 'ground', model: opts.model })
    const model = next.model ?? 'qwen/qwen3.7-flash'
    const cost: CallCost = {
      model,
      provider: 'fake',
      tokens: 10,
      costUsd: 0.001,
      kind: opts.kind ?? 'ground',
    }
    return { id: `fake-${this.calls.length}`, content: next.content, model, cost }
  }
}

describe('Engine record/replay', () => {
  let driver: BrowserDriver

  beforeAll(async () => {
    driver = await BrowserDriver.launch({
      viewport: { width: 1280, height: 720 },
      browserTimeoutMs: 8_000,
    })
  })

  beforeEach(async () => {
    await driver.goto(`file://${FIXTURE_URL}`)
  })

  afterAll(async () => {
    await driver.close()
  })

  it('recorded flow replays with zero model calls when fingerprints resolve', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'vision-e2e-ae1-'))
    const actions = new Actions(driver)
    const client = new FakeClient([
      { content: JSON.stringify({ action: 'click', x: 200, y: 130, reasoning: 'click the button' }) },
      { content: JSON.stringify({ action: 'done', reasoning: 'finished' }) },
    ])
    const config = resolveConfig({ cacheDir, budgetUsd: 1 })
    const engine = new Engine({ driver, actions, client, ledger: new Ledger(config.budgetUsd), config })

    const record = await engine.record('Click the button', actions, { flowName: 'ae1' })
    expect(record.ok).toBe(true)

    client.reset()
    const flow = await loadFlow(cacheDir, 'ae1')
    expect(flow).toBeDefined()

    const replay = await engine.replay(flow!, { flowName: 'ae1' })
    expect(replay.ok).toBe(true)
    expect(client.calls.length).toBe(0)
    expect(await driver.rawPage.locator('#marker').getAttribute('data-marker')).toBe('clicked')
  })

  it('element moved triggers exactly one heal call and updates the cache', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'vision-e2e-ae2-'))
    const actions = new Actions(driver)
    const recordClient = new FakeClient([
      { content: JSON.stringify({ action: 'click', x: 200, y: 130, reasoning: 'click' }) },
      { content: JSON.stringify({ action: 'done', reasoning: 'done' }) },
    ])
    const config = resolveConfig({ cacheDir, budgetUsd: 1 })
    const recordEngine = new Engine({
      driver,
      actions,
      client: recordClient,
      ledger: new Ledger(config.budgetUsd),
      config,
    })
    await recordEngine.record('Click the button', actions, { flowName: 'ae2' })

    await driver.rawPage.evaluate(() => {
      const btn = document.getElementById('click-target')
      if (btn) {
        ;(btn as HTMLElement).style.left = '500px'
        ;(btn as HTMLElement).style.top = '100px'
      }
    })

    const flow = await loadFlow(cacheDir, 'ae2')
    const healClient = new FakeClient([
      { content: JSON.stringify({ action: 'click', x: 600, y: 130, reasoning: 'relocated' }) },
    ])
    const replayEngine = new Engine({
      driver,
      actions,
      client: healClient,
      ledger: new Ledger(config.budgetUsd),
      config,
    })
    const replay = await replayEngine.replay(flow!, { flowName: 'ae2' })

    expect(replay.ok).toBe(true)
    expect(replay.steps[0].healed).toBe(true)
    expect(healClient.calls.length).toBe(1)

    const updated = await loadFlow(cacheDir, 'ae2')
    expect(updated!.steps[0].bbox.x).toBe(500)
    expect(await driver.rawPage.locator('#marker').getAttribute('data-marker')).toBe('clicked')
  })

  it('heal failure marks the step and run as failed with reasoning captured', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'vision-e2e-fail-'))
    const actions = new Actions(driver)
    const recordClient = new FakeClient([
      { content: JSON.stringify({ action: 'click', x: 200, y: 130, reasoning: 'click' }) },
      { content: JSON.stringify({ action: 'done', reasoning: 'done' }) },
    ])
    const config = resolveConfig({ cacheDir, budgetUsd: 1 })
    const recordEngine = new Engine({
      driver,
      actions,
      client: recordClient,
      ledger: new Ledger(config.budgetUsd),
      config,
    })
    await recordEngine.record('Click the button', actions, { flowName: 'fail' })

    await driver.rawPage.evaluate(() => {
      const btn = document.getElementById('click-target')
      if (btn) {
        ;(btn as HTMLElement).style.display = 'none'
      }
    })

    const flow = await loadFlow(cacheDir, 'fail')
    const failClient = new FakeClient([
      { content: JSON.stringify({ action: 'fail', reasoning: 'button not found' }) },
    ])
    const replayEngine = new Engine({
      driver,
      actions,
      client: failClient,
      ledger: new Ledger(config.budgetUsd),
      config,
    })
    const replay = await replayEngine.replay(flow!)

    expect(replay.ok).toBe(false)
    expect(replay.steps[0].ok).toBe(false)
    expect(replay.steps[0].reason).toContain('button not found')
    expect(failClient.calls.length).toBe(1)
  })

  it('assert returns a cached verdict without a model call on an unchanged region', async () => {
    const actions = new Actions(driver)
    const client = new FakeClient([
      { content: JSON.stringify({ verdict: 'pass', reasoning: 'button is visible' }) },
    ])
    const config = resolveConfig({ budgetUsd: 1 })
    const engine = new Engine({ driver, actions, client, ledger: new Ledger(config.budgetUsd), config })

    const first = await engine.assert('Is the click button visible?')
    expect(first.verdict).toBe('pass')
    expect(first.cached).toBe(false)
    expect(client.calls.length).toBe(1)

    const second = await engine.assert('Is the click button visible?')
    expect(second.verdict).toBe('pass')
    expect(second.cached).toBe(true)
    expect(client.calls.length).toBe(1)
  })
})
