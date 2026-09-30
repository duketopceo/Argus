import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { BrowserDriver } from '../../src/driver/browser.js'
import { TargetProcess } from '../../src/driver/target.js'
import { Actions } from '../../src/engine/actions.js'
import { runExplore } from '../../src/engine/explore.js'
import { VisionClient } from '../../src/engine/loop.js'
import { ProviderRules, resolveConfig } from '../../src/config.js'
import { Ledger } from '../../src/vision/ledger.js'
import { CallCost, CallKind } from '../../src/vision/cost.js'
import { JsonSchema, Message } from '../../src/vision/openrouter.js'

const SERVE_SCRIPT = fileURLToPath(new URL('../fixtures/serve.mjs', import.meta.url))
const FIXTURE_DIR = fileURLToPath(new URL('../fixtures/', import.meta.url))

class FakeClient implements VisionClient {
  calls: CallKind[] = []

  constructor(private queue: { content: string }[] = []) {}

  async complete(opts: {
    model: string
    messages: Message[]
    schema?: JsonSchema
    escalationModels?: string[]
    provider?: ProviderRules
    kind?: CallKind
  }): Promise<{ id: string; content: string; cost: CallCost; model: string }> {
    const next = this.queue.shift()
    if (next === undefined) throw new Error('fake client queue empty')
    this.calls.push(opts.kind ?? 'ground')
    const cost: CallCost = {
      model: opts.model,
      provider: 'fake',
      tokens: 10,
      costUsd: 0.001,
      kind: opts.kind ?? 'ground',
    }
    return { id: `fake-${this.calls.length}`, content: next.content, model: opts.model, cost }
  }
}

const act = (content: unknown) => ({ content: JSON.stringify(content) })

// Real BrowserDriver + real fixture server: proves Actions.navigate, the
// structural origin bound, and capture taps end-to-end (U4b / R1, R3, R9).
describe('runExplore against a real browser (U4b)', () => {
  let port: number
  let target: TargetProcess | undefined
  let driver: BrowserDriver
  let videoDir: string

  beforeAll(async () => {
    port = 4300 + Math.floor(Math.random() * 500)
    target = await TargetProcess.start({
      command: `${JSON.stringify(process.execPath)} ${JSON.stringify(SERVE_SCRIPT)} ${port} ${JSON.stringify(FIXTURE_DIR)}`,
      url: `http://127.0.0.1:${port}/`,
      readyTimeoutMs: 10_000,
    })
    videoDir = await mkdtemp(join(tmpdir(), 'argus-explore-video-'))
    driver = await BrowserDriver.launch({
      captureErrors: true,
      videoDir,
      browserTimeoutMs: 8_000,
    })
    await driver.goto(`http://127.0.0.1:${port}/index.html`)
  })

  afterAll(async () => {
    await driver?.close()
    await target?.stop()
  })

  it('navigates same-origin, refuses cross-origin, and captures the target page anomalies', async () => {
    const client = new FakeClient([
      act({ action: 'navigate', url: '/explore.html', reasoning: 'visit another page' }),
      act({ action: 'navigate', url: 'https://evil.example/', reasoning: 'try to leave' }),
      act({ action: 'done', reasoning: 'surface covered' }),
    ])
    const config = resolveConfig({ budgetUsd: 5, explore: { enabled: true, maxSteps: 8 } })
    const ledger = new Ledger(config.budgetUsd)

    const res = await runExplore({
      driver,
      actions: new Actions(driver),
      client,
      ledger,
      config,
      targetUrl: `http://127.0.0.1:${port}/`,
    })

    expect(res.stopReason).toBe('done')
    expect(res.steps).toHaveLength(3)
    expect(res.visited).toBeGreaterThanOrEqual(2)
    expect(res.visionCalls).toBe(3)
    expect(client.calls.every((k) => k === 'explore')).toBe(true)

    // The same-origin navigate executed; the cross-origin one was refused
    // and the page never left the fixture origin.
    const refused = res.steps.find((s) => s.note?.includes('cross-origin'))
    expect(refused).toBeDefined()
    expect(driver.rawPage.url()).toBe(`http://127.0.0.1:${port}/explore.html`)

    // explore.html seeds a console error ×3 and a pageerror — the session's
    // taps captured them as observed evidence.
    const caps = driver.pageCaptures()
    expect(
      caps.some((c) => c.kind === 'console-error' && c.text.includes('seeded console boom')),
    ).toBe(true)
    expect(
      caps.some((c) => c.kind === 'pageerror' && c.text.includes('seeded page boom')),
    ).toBe(true)
  })
})
