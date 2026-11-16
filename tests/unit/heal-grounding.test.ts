import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { BrowserDriver } from '../../src/driver/browser.js'
import { Actions } from '../../src/engine/actions.js'
import { Engine, VisionClient } from '../../src/engine/loop.js'
import { TdSession } from '../../src/api.js'
import { actionSchema, exploreActionSchema } from '../../src/engine/prompts.js'
import { resolveConfig, ProviderRules } from '../../src/config.js'
import { FingerprintRecord, snippetsIdentityMatch } from '../../src/cache/fingerprint.js'
import { Ledger } from '../../src/vision/ledger.js'
import { CallCost, CallKind } from '../../src/vision/cost.js'
import { JsonSchema, Message } from '../../src/vision/openrouter.js'

class ScriptedClient implements VisionClient {
  calls = 0
  private queue: unknown[]
  constructor(queue: unknown[]) {
    this.queue = [...queue]
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
    if (next === undefined) throw new Error('scripted client queue empty')
    this.calls++
    const model = 'qwen/qwen3.7-flash'
    return {
      id: `s-${this.calls}`,
      content: JSON.stringify(next),
      model,
      cost: { model, provider: 'fake', tokens: 10, costUsd: 0.001, kind: opts.kind ?? 'ground' },
    }
  }
}

const click = (x: number, y: number) => ({ action: 'click', x, y, reasoning: 'r' })

const PAGE = `<!doctype html><html><body style="margin:0;font-family:sans-serif">
<div id="panel" style="position:absolute;left:0;top:0;width:600px;height:300px;background:#eee">
  Newsletter signup panel where visitors enter an email then Subscribe now
  <label for="nm" style="position:absolute;left:20px;top:100px">Full name</label>
  <input id="nm" style="position:absolute;left:120px;top:100px;width:200px;height:30px">
  <button id="sub" style="position:absolute;left:20px;top:200px;width:160px;height:40px">Subscribe</button>
  <button id="sub2" style="position:absolute;left:220px;top:200px;width:300px;height:40px">Subscribe to our weekly digest newsletter now</button>
</div></body></html>`

function recorded(snippet: string): FingerprintRecord {
  return {
    instruction: 'locate: the "Subscribe" button',
    action: { action: 'click', x: 5, y: 5 },
    bbox: { x: 0, y: 0, width: 10, height: 10 },
    clickPoint: { x: 5, y: 5 },
    model: 'm',
    a11ySnippet: snippet,
    regionHash: 'ffffffffffffffff',
  }
}

describe('strict-mode action schemas (OpenAI structured outputs)', () => {
  for (const schema of [actionSchema, exploreActionSchema]) {
    it(`${schema.name}: every property required, optional ones nullable, no extras`, () => {
      const s = schema.schema as {
        properties: Record<string, { type: string | string[] }>
        required: string[]
        additionalProperties: boolean
      }
      expect(s.additionalProperties).toBe(false)
      expect([...s.required].sort()).toEqual(Object.keys(s.properties).sort())
      for (const key of ['x', 'y', 'text', 'keys', 'dx', 'dy', 'ms']) {
        expect(s.properties[key]!.type).toContain('null')
      }
      expect(s.properties.action!.type).toBe('string')
      expect(s.properties.reasoning!.type).toBe('string')
    })
  }
})

describe('snippetsIdentityMatch', () => {
  it('accepts the same name, a changed counter, and an empty recorded name', () => {
    expect(snippetsIdentityMatch('Subscribe', 'Subscribe')).toBe(true)
    expect(snippetsIdentityMatch('Place order (2)', 'Place order (3)')).toBe(true)
    expect(snippetsIdentityMatch('', 'anything')).toBe(true)
  })
  it('rejects a neighbour and a container that merely includes the label', () => {
    expect(snippetsIdentityMatch('Subscribe', 'Gift wrap')).toBe(false)
    expect(
      snippetsIdentityMatch(
        'Subscribe',
        'Newsletter signup panel where visitors enter an email then Subscribe now',
      ),
    ).toBe(false)
    expect(snippetsIdentityMatch('Subscribe', '')).toBe(false)
  })
})

describe('heal grounding against a real page', () => {
  let driver: BrowserDriver

  beforeAll(async () => {
    driver = await BrowserDriver.launch({
      viewport: { width: 1280, height: 720 },
      browserTimeoutMs: 8_000,
    })
    await driver.rawPage.setContent(PAGE)
  })
  afterAll(async () => {
    await driver.close()
  })

  function engineFor(client: ScriptedClient): Engine {
    const config = resolveConfig({ budgetUsd: 1, escalation_model: 'qwen/qwen3.7-flash' })
    return new Engine({
      driver,
      actions: new Actions(driver),
      client,
      ledger: new Ledger(config.budgetUsd),
      config,
    })
  }

  it('label-based inputs ground: the snippet is the <label for> text', async () => {
    const client = new ScriptedClient([click(200, 115)])
    const result = await engineFor(client).locate('the "Full name" input')
    expect(result.ok).toBe(true)
    expect(result.fingerprint?.a11ySnippet).toBe('Full name')
  })

  it('a click on a text span inside a button names the button', async () => {
    const client = new ScriptedClient([click(60, 220)])
    const result = await engineFor(client).locate('the "Subscribe" button')
    expect(result.ok).toBe(true)
    expect(result.fingerprint?.a11ySnippet).toBe('Subscribe')
  })

  it('a heal that lands on a container snaps to the interactive element inside it', async () => {
    // Empty panel background: its text contains "Subscribe" but it is a container.
    const client = new ScriptedClient([click(500, 50)])
    const result = await engineFor(client).locate('the "Subscribe" button', recorded('Subscribe'))
    expect(result.ok).toBe(true)
    expect(result.healed).toBe(true)
    expect(client.calls).toBe(1)
    expect(result.fingerprint?.a11ySnippet).toBe('Subscribe')
    expect(result.point).toEqual({ x: 100, y: 220 })
  })

  it('cold grounding never records a container: it snaps to the matching button', async () => {
    const client = new ScriptedClient([click(500, 50)])
    const result = await engineFor(client).locate('the "Subscribe" button')
    expect(result.ok).toBe(true)
    expect(result.fingerprint?.a11ySnippet).toBe('Subscribe')
    expect(client.calls).toBe(1)
  })

  it('cold grounding rejects a container when nothing inside it matches', async () => {
    const client = new ScriptedClient([click(500, 50), click(500, 60)])
    const result = await engineFor(client).locate('the "Visitors enter" thing')
    // nothing interactive is named "Visitors enter": the container is never recorded
    expect(result.ok).toBe(false)
    expect(result.fingerprint).toBeUndefined()
    expect(result.reason).toContain('container')
  })

  it('a heal that lands on a different element fails clearly and saves nothing', async () => {
    const client = new ScriptedClient([click(300, 220), click(300, 220), click(300, 220)])
    const result = await engineFor(client).locate('the "Subscribe" button', recorded('Subscribe'))
    expect(result.ok).toBe(false)
    expect(result.fingerprint).toBeUndefined()
    expect(result.reason).toContain('not the element recorded')
    expect(client.calls).toBe(3)
  })
})

describe('step effect check (TdSession)', () => {
  // A fresh browser per test: setContent reuses the window, a real navigation does not.
  let driver: BrowserDriver
  afterEach(async () => {
    await driver.close()
  })

  const PAGE_EFFECT = `<!doctype html><html><body style="margin:0">
<button id="noop" style="position:absolute;left:20px;top:20px;width:200px;height:40px">Noop</button>
<button id="count" style="position:absolute;left:20px;top:100px;width:200px;height:40px">Count</button>
<button id="late" style="position:absolute;left:20px;top:180px;width:200px;height:40px">Late</button>
<p id="out" style="position:absolute;left:300px;top:20px">0</p>
<script>
  let n = 0
  document.getElementById('count').addEventListener('click', () => {
    n += 1
    document.getElementById('out').textContent = String(n)
  })
  // ignores the first click, reacts to the second (the scripted retry)
  let late = 0
  document.getElementById('late').addEventListener('click', () => {
    late += 1
    if (late >= 2) document.getElementById('out').textContent = 'late'
  })
</script></body></html>`

  async function session(client: ScriptedClient): Promise<TdSession> {
    driver = await BrowserDriver.launch({
      viewport: { width: 1280, height: 720 },
      browserTimeoutMs: 8_000,
    })
    await driver.rawPage.setContent(PAGE_EFFECT)
    return TdSession.create({
      driver,
      client,
      config: resolveConfig({ budgetUsd: 1, escalation_model: 'qwen/qwen3-vl-235b-a22b-instruct' }),
    })
  }

  it('a click that changes nothing is retried once, then fails the step and saves nothing', async () => {
    const s = await session(new ScriptedClient([click(100, 40)]))
    await expect(s.td.find('the "Noop" button').click()).rejects.toThrow(/no observable effect/)
    expect(s.failed).toBe(true)
    expect(s.failureReason).toMatch(/no observable effect/)
    expect(s.steps[0]?.ok).toBe(false)
    expect(s.fingerprintRecords).toHaveLength(0)
    expect(s.noEffectSteps).toEqual(['the "Noop" button'])
  })

  it('a click that changes the page passes and its fingerprint is kept', async () => {
    const s = await session(new ScriptedClient([click(100, 120)]))
    await s.td.find('the "Count" button').click()
    expect(s.failed).toBe(false)
    expect(s.fingerprintRecords).toHaveLength(1)
  })

  it('a click that only takes effect on the retry (scroll into view, center click) passes', async () => {
    const s = await session(new ScriptedClient([click(30, 190)]))
    await s.td.find('the "Late" button').click()
    expect(s.failed).toBe(false)
    expect(s.fingerprintRecords).toHaveLength(1)
    expect(await driver.rawPage.evaluate(() => (globalThis as unknown as { document: { getElementById: (i: string) => { textContent: string } } }).document.getElementById('out').textContent)).toBe('late')
  })
})
