import { describe, expect, it } from 'vitest'

import { BrowserDriver, Observation } from '../../src/driver/browser.js'
import { Actions } from '../../src/engine/actions.js'
import { parseExploreAction, runExplore } from '../../src/engine/explore.js'
import { VisionClient } from '../../src/engine/loop.js'
import { resolveConfig, ProviderRules } from '../../src/config.js'
import { Ledger } from '../../src/vision/ledger.js'
import { CallCost, CallKind } from '../../src/vision/cost.js'
import { JsonSchema, Message } from '../../src/vision/openrouter.js'

const BASE_URL = 'http://localhost:3000/'

function observation(tag: string): Observation {
  return {
    screenshotJpeg: Buffer.alloc(4),
    a11yYaml: `page: ${tag}`,
    width: 1280,
    height: 720,
  }
}

class StubDriver {
  url = BASE_URL
  /** Next click navigates here — simulates a link leaving the origin. */
  pendingUrl: string | undefined
  private tick = 0

  get rawPage() {
    return { url: () => this.url }
  }

  async goto(url: string): Promise<void> {
    this.url = url
  }

  async observe(): Promise<Observation> {
    // Distinct a11y per call so stall detection doesn't trip in tests that
    // don't exercise it; tests that want a stall pin `frozen`.
    this.tick++
    return observation(this.frozen ? 'frozen' : `state-${this.tick}`)
  }

  frozen = false
}

class StubActions {
  calls: string[] = []

  constructor(private readonly driver: StubDriver) {}

  async click(): Promise<Observation> {
    this.calls.push('click')
    if (this.driver.pendingUrl !== undefined) {
      this.driver.url = this.driver.pendingUrl
      this.driver.pendingUrl = undefined
    }
    return this.driver.observe()
  }
  async type(): Promise<Observation> {
    this.calls.push('type')
    return this.driver.observe()
  }
  async pressKeys(): Promise<Observation> {
    this.calls.push('pressKeys')
    return this.driver.observe()
  }
  async scroll(): Promise<Observation> {
    this.calls.push('scroll')
    return this.driver.observe()
  }
  async wait(): Promise<Observation> {
    this.calls.push('wait')
    return this.driver.observe()
  }
  async navigate(url: string): Promise<Observation> {
    this.calls.push(`navigate:${url}`)
    this.driver.url = url
    return this.driver.observe()
  }
}

interface FakeCall {
  kind: CallKind
  userText: string
}

class FakeClient implements VisionClient {
  calls: FakeCall[] = []

  constructor(
    private queue: ({ content: string } | { error: Error })[] = [],
    private costUsd = 0.001,
  ) {}

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
    if ('error' in next) throw next.error
    const userText = opts.messages
      .filter((m) => m.role === 'user')
      .flatMap((m) => m.content)
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n')
    this.calls.push({ kind: opts.kind ?? 'ground', userText })
    const cost: CallCost = {
      model: 'qwen/qwen3.7-flash',
      provider: 'fake',
      tokens: 10,
      costUsd: this.costUsd,
      kind: opts.kind ?? 'ground',
    }
    return { id: `fake-${this.calls.length}`, content: next.content, model: 'qwen/qwen3.7-flash', cost }
  }
}

function setup(
  queue: ({ content: string } | { error: Error })[],
  configInput: Parameters<typeof resolveConfig>[0] = {},
) {
  const driver = new StubDriver()
  const actions = new StubActions(driver)
  const client = new FakeClient(queue)
  const config = resolveConfig({ budgetUsd: 10, ...configInput })
  const ledger = new Ledger(config.explore.budgetUsd ?? config.budgetUsd)
  return { driver, actions, client, config, ledger }
}

function run(h: ReturnType<typeof setup>) {
  return runExplore({
    driver: h.driver as unknown as BrowserDriver,
    actions: h.actions as unknown as Actions,
    client: h.client,
    ledger: h.ledger,
    config: h.config,
    targetUrl: BASE_URL,
  })
}

const act = (content: unknown) => ({ content: JSON.stringify(content) })

describe('runExplore', () => {
  it('done terminates with the step recorded', async () => {
    const h = setup([act({ action: 'done', reasoning: 'covered' })])
    const res = await run(h)
    expect(res.stopReason).toBe('done')
    expect(res.steps).toHaveLength(1)
    expect(res.steps[0]?.action).toBe('done')
    expect(res.visionCalls).toBe(1)
    expect(h.client.calls[0]?.kind).toBe('explore')
  })

  it('stops at the step cap when the model keeps proposing', async () => {
    const h = setup(
      [
        act({ action: 'wait', ms: 1, reasoning: 'a' }),
        act({ action: 'wait', ms: 1, reasoning: 'b' }),
      ],
      { explore: { enabled: true, maxSteps: 2 } },
    )
    const res = await run(h)
    expect(res.stopReason).toBe('max-steps')
    expect(res.steps).toHaveLength(2)
    expect(res.visionCalls).toBe(2)
  })

  it('explore.budgetUsd halts the loop before the step cap', async () => {
    const h = setup(
      [
        act({ action: 'wait', ms: 1, reasoning: 'a' }),
        act({ action: 'wait', ms: 1, reasoning: 'b' }),
      ],
      { explore: { enabled: true, maxSteps: 20, budgetUsd: 0.001 } },
    )
    const res = await run(h)
    expect(res.stopReason).toBe('budget')
    expect(res.visionCalls).toBe(1)
    expect(res.visionCostUsd).toBeCloseTo(0.001)
  })

  it('explore.budgetUsd overrides the run budget when larger', async () => {
    const h = setup(
      [
        act({ action: 'wait', ms: 1, reasoning: 'a' }),
        act({ action: 'wait', ms: 1, reasoning: 'b' }),
        act({ action: 'wait', ms: 1, reasoning: 'c' }),
      ],
      // Run budget alone would stop the pass before the first call; the
      // lane-specific cap wins and two $0.001 calls fit inside it.
      { budgetUsd: 0.0005, explore: { enabled: true, maxSteps: 20, budgetUsd: 0.0025 } },
    )
    const res = await run(h)
    expect(res.stopReason).toBe('budget')
    expect(res.visionCalls).toBe(2)
    expect(h.ledger.budgetExceeded).toBe(true)
  })

  it('click-induced cross-origin navigation returns to the last in-origin page', async () => {
    const h = setup([
      act({ action: 'click', x: 10, y: 10, reasoning: 'external link' }),
      act({ action: 'done', reasoning: 'stop' }),
    ])
    h.driver.pendingUrl = 'https://evil.example/landing'
    const res = await run(h)
    expect(res.steps[0]?.note).toBe('refused: left target origin')
    expect(res.steps[0]?.url).toBe(BASE_URL)
    expect(h.driver.url).toBe(BASE_URL)
    expect(res.visited).toBe(1)
    expect(res.notes.some((n) => n.message.includes('left target origin'))).toBe(true)
    expect(res.stopReason).toBe('done')
  })

  it('replayOnly ledger stops explore before the first call', async () => {
    const h = setup([])
    h.ledger.canSpend(1) // exceeds nothing — force replayOnly via flag path
    h.ledger.flagBudgetExceeded()
    const res = await run(h)
    expect(res.stopReason).toBe('budget')
    expect(res.visionCalls).toBe(0)
    expect(h.client.calls).toHaveLength(0)
  })

  it('cross-origin navigate is refused, journaled, and never executes', async () => {
    const h = setup([
      act({ action: 'navigate', url: 'https://evil.example/x', reasoning: 'leave' }),
      act({ action: 'done', reasoning: 'stop' }),
    ])
    const res = await run(h)
    expect(res.stopReason).toBe('done')
    expect(h.driver.url).toBe(BASE_URL)
    expect(h.actions.calls).not.toContain('navigate:https://evil.example/x')
    const refused = res.steps.find((s) => s.note?.includes('cross-origin'))
    expect(refused).toBeDefined()
    expect(res.notes.some((n) => n.message.includes('refused'))).toBe(true)
  })

  it('same-origin relative navigate executes and is journaled', async () => {
    const h = setup([
      act({ action: 'navigate', url: '/settings', reasoning: 'nav' }),
      act({ action: 'done', reasoning: 'stop' }),
    ])
    const res = await run(h)
    expect(h.driver.url).toBe('http://localhost:3000/settings')
    expect(res.visited).toBeGreaterThanOrEqual(2)
    expect(res.stopReason).toBe('done')
  })

  it('non-http(s) navigate targets are refused', async () => {
    const h = setup([
      act({ action: 'navigate', url: 'javascript:alert(1)', reasoning: 'xss' }),
      act({ action: 'done', reasoning: 'stop' }),
    ])
    const res = await run(h)
    expect(res.steps[0]?.note).toContain('refused')
    expect(h.actions.calls.filter((c) => c.startsWith('navigate'))).toHaveLength(0)
  })

  it('same page signature three times → stalled', async () => {
    const h = setup([
      act({ action: 'wait', ms: 1, reasoning: 'a' }),
      act({ action: 'wait', ms: 1, reasoning: 'b' }),
      act({ action: 'wait', ms: 1, reasoning: 'c' }),
    ])
    h.driver.frozen = true
    const res = await run(h)
    expect(res.stopReason).toBe('stalled')
  })

  it('model throw stops the loop with error and never rejects', async () => {
    const h = setup([{ error: new Error('provider down') }])
    const res = await run(h)
    expect(res.stopReason).toBe('error')
    expect(res.notes.some((n) => n.message === 'model call threw')).toBe(true)
  })

  it('unparseable proposals count as steps without executing', async () => {
    const h = setup([
      { content: 'not json at all' },
      act({ action: 'done', reasoning: 'stop' }),
    ])
    const res = await run(h)
    expect(res.steps[0]?.action).toBe('noop')
    expect(res.steps[0]?.note).toBe('unparseable proposal')
    expect(res.stopReason).toBe('done')
  })

  it('transcript carries prior acts with urls and refusal notes', async () => {
    const h = setup([
      act({ action: 'navigate', url: 'https://off.example/', reasoning: 'x' }),
      act({ action: 'done', reasoning: 'stop' }),
    ])
    await run(h)
    const secondCall = h.client.calls[1]?.userText ?? ''
    expect(secondCall).toContain('navigate https://off.example/')
    expect(secondCall).toContain('cross-origin')
  })
})

describe('boundAction via runExplore', () => {
  it('type text is truncated to 500 chars', async () => {
    const long = 'x'.repeat(800)
    const h = setup([
      act({ action: 'type', text: long, reasoning: 'boundary' }),
      act({ action: 'done', reasoning: 'stop' }),
    ])
    const res = await run(h)
    // The action recorded in priorActs is the bounded one — assert via the
    // second prompt's transcript.
    const transcript = h.client.calls[1]?.userText ?? ''
    expect(transcript).not.toContain(long)
    expect(res.steps[0]?.action).toBe('type')
  })

  it('pressKeys outside the allowlist is refused', async () => {
    const h = setup([
      act({ action: 'pressKeys', keys: ['Control+Alt+Delete'], reasoning: 'bad' }),
      act({ action: 'done', reasoning: 'stop' }),
    ])
    const res = await run(h)
    expect(res.steps[0]?.note).toBe('no allowed keys')
    expect(h.actions.calls).not.toContain('pressKeys')
  })

  it('click outside the viewport is refused', async () => {
    const h = setup([
      act({ action: 'click', x: 9999, y: 9999, reasoning: 'off-screen' }),
      act({ action: 'done', reasoning: 'stop' }),
    ])
    const res = await run(h)
    expect(res.steps[0]?.note).toBe('click coordinates out of viewport')
    expect(h.actions.calls).not.toContain('click')
  })
})

describe('parseExploreAction', () => {
  it('parses a standard proposal', () => {
    const a = parseExploreAction(
      JSON.stringify({ action: 'navigate', url: '/a', reasoning: 'go' }),
    )
    expect(a?.action).toBe('navigate')
    expect(a?.url).toBe('/a')
  })

  it('parses the variant shape {"navigate": "/a"}', () => {
    const a = parseExploreAction(JSON.stringify({ navigate: '/a', reasoning: 'go' }))
    expect(a?.action).toBe('navigate')
    expect(a?.url).toBe('/a')
  })

  it('extracts bare coordinates into a click', () => {
    const a = parseExploreAction('click(342, 210)')
    expect(a?.action).toBe('click')
    expect(a?.x).toBe(342)
  })

  it('returns undefined for unknown actions', () => {
    expect(parseExploreAction(JSON.stringify({ action: 'exec', reasoning: 'x' }))).toBeUndefined()
  })
})
