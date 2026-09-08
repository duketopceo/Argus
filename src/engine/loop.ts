import { BrowserDriver, Observation } from '../driver/browser.js'
import { Actions } from './actions.js'
import { Config, ProviderRules } from '../config.js'
import { CallCost, CallKind } from '../vision/cost.js'
import { Ledger } from '../vision/ledger.js'
import { JsonSchema, Message } from '../vision/openrouter.js'
import {
  ActionPayload,
  Bbox,
  computeRegionHash,
  Fingerprint,
  FingerprintRecord,
  Point,
} from '../cache/fingerprint.js'
import { FlowCache, saveFlow } from '../cache/store.js'
import {
  actionSchema,
  AssertionResult,
  assertionSchema,
  buildActionMessages,
  buildAssertMessages,
  ProposedAction,
} from './prompts.js'

export interface VisionClient {
  complete(opts: {
    model: string
    messages: Message[]
    schema?: JsonSchema
    escalationModels?: string[]
    provider?: ProviderRules
    kind?: CallKind
  }): Promise<{ id: string; content: string; cost: CallCost; model: string }>
}

export interface TestDriverApi {
  click(x: number, y: number): Promise<Observation>
  type(text: string): Promise<Observation>
  pressKeys(keys: string[]): Promise<Observation>
  scroll(dx: number, dy: number): Promise<Observation>
  wait(ms: number): Promise<Observation>
}

export interface EngineOptions {
  driver: BrowserDriver
  actions: Actions
  client: VisionClient
  ledger: Ledger
  config: Config
}

export interface RecordOptions {
  flowName?: string
  stepCap?: number
}

export interface ReplayOptions {
  flowName?: string
}

export interface StepResult {
  instruction: string
  action: string
  ok: boolean
  reason?: string
  healed?: boolean
  model?: string
}

export interface RunResult {
  ok: boolean
  reason?: string
  steps: StepResult[]
  visionCalls: number
}

export interface AssertResult extends AssertionResult {
  cached: boolean
}

export class Engine {
  private _visionCalls = 0
  private _steps: StepResult[] = []
  private _fingerprints: FingerprintRecord[] = []
  private _assertCache = new Map<string, AssertionResult>()

  constructor(private _opts: EngineOptions) {}

  get visionCalls(): number {
    return this._visionCalls
  }

  async record(
    instruction: string,
    tdApi: TestDriverApi = this._opts.actions,
    options: RecordOptions = {},
  ): Promise<RunResult> {
    this._visionCalls = 0
    this._steps = []
    this._fingerprints = []

    const cap = options.stepCap ?? 10
    let observation = await this._opts.driver.observe()

    for (let i = 0; i < cap; i++) {
      const response = await this._callModel('ground', buildActionMessages(instruction, observation))
      if (!response) {
        return this._result(false, 'budget exceeded or model call blocked')
      }

      const action = this._parseAction(response.content)

      if (action.action === 'done') {
        this._steps.push({ instruction, action: 'done', ok: true, reason: action.reasoning, model: response.model })
        break
      }

      if (action.action === 'fail') {
        this._steps.push({ instruction, action: 'fail', ok: false, reason: action.reasoning, model: response.model })
        return this._result(false, action.reasoning)
      }

      const resolved = await this._resolveAction(action)
      const nextObservation = await this._executeAction(tdApi, action)
      const fingerprint = await this._buildFingerprint(instruction, action, resolved, response.model)

      this._fingerprints.push(fingerprint)
      this._steps.push({ instruction, action: action.action, ok: true, model: response.model })
      observation = nextObservation
    }

    if (options.flowName && this._opts.config.cacheDir) {
      await saveFlow(this._opts.config.cacheDir, options.flowName, this._fingerprints)
    }

    const finished = this._steps[this._steps.length - 1]?.action === 'done'
    if (!finished) {
      return this._result(false, `step cap of ${cap} reached without done`)
    }

    return this._result(true)
  }

  async replay(flow: FlowCache, options: ReplayOptions = {}): Promise<RunResult> {
    this._visionCalls = 0
    this._steps = []

    for (let i = 0; i < flow.steps.length; i++) {
      const step = flow.steps[i]
      if (!step) continue
      let observation = await this._opts.driver.observe()
      const regionBuffer = await this._regionScreenshot(step.bbox)
      const fingerprint = new Fingerprint(step)
      const resolve = fingerprint.resolve(regionBuffer, observation.a11yYaml)

      if (resolve.matched) {
        await this._executeAction(this._opts.actions, step.action)
        this._steps.push({ instruction: step.instruction, action: step.action.action, ok: true })
        continue
      }

      if (this._opts.ledger.replayOnly || !this._opts.ledger.canSpend(0.001)) {
        this._steps.push({
          instruction: step.instruction,
          action: step.action.action,
          ok: false,
          reason: 'fingerprint mismatch and budget/replay-only prevents heal',
        })
        return this._result(false)
      }

      const response = await this._callModel(
        'heal',
        buildActionMessages(step.instruction, observation),
        [this._opts.config.escalation_model],
      )
      if (!response) {
        this._steps.push({
          instruction: step.instruction,
          action: step.action.action,
          ok: false,
          reason: 'heal blocked by budget',
        })
        return this._result(false)
      }

      const action = this._parseAction(response.content)
      if (action.action === 'fail') {
        this._steps.push({
          instruction: step.instruction,
          action: step.action.action,
          ok: false,
          reason: action.reasoning,
          healed: false,
        })
        return this._result(false)
      }

      if (action.action === 'done') {
        this._steps.push({
          instruction: step.instruction,
          action: step.action.action,
          ok: false,
          reason: 'heal returned done instead of a relocated action',
          healed: false,
        })
        return this._result(false)
      }

      const resolved = await this._resolveAction(action)
      const nextObservation = await this._executeAction(this._opts.actions, action)
      const newFingerprint = await this._buildFingerprint(step.instruction, action, resolved, response.model)
      flow.steps[i] = newFingerprint

      this._steps.push({
        instruction: step.instruction,
        action: action.action,
        ok: true,
        healed: true,
        model: response.model,
      })
      observation = nextObservation
    }

    if (options.flowName && this._opts.config.cacheDir) {
      await saveFlow(this._opts.config.cacheDir, options.flowName, flow.steps)
    }

    return this._result(true)
  }

  async assert(question: string): Promise<AssertResult> {
    const observation = await this._opts.driver.observe()
    const regionHash = computeRegionHash(observation.screenshotJpeg)
    const key = JSON.stringify({ question, regionHash })
    const cached = this._assertCache.get(key)
    if (cached) {
      return { ...cached, cached: true }
    }

    if (this._opts.ledger.replayOnly || !this._opts.ledger.canSpend(0.001)) {
      return { verdict: 'fail', reasoning: 'budget exceeded or replay-only', cached: false }
    }

    const response = await this._callModel('assert', buildAssertMessages(question, observation))
    if (!response) {
      return { verdict: 'fail', reasoning: 'budget exceeded', cached: false }
    }

    const parsed = this._parseAssertion(response.content)
    this._assertCache.set(key, parsed)
    return { ...parsed, cached: false }
  }

  private async _callModel(
    kind: CallKind,
    messages: Message[],
    escalationModels?: string[],
  ): Promise<{ id: string; content: string; cost: CallCost; model: string } | undefined> {
    if (!this._opts.ledger.canSpend(0.001)) {
      return undefined
    }
    const schema = kind === 'assert' ? assertionSchema : actionSchema
    const response = await this._opts.client.complete({
      model: this._opts.config.model,
      messages,
      schema,
      ...(escalationModels ? { escalationModels } : {}),
      provider: this._opts.config.provider,
      kind,
    })
    this._opts.ledger.recordCall(response.cost)
    if (
      this._opts.config.budgetUsd !== undefined &&
      this._opts.ledger.visionCostUsd > this._opts.config.budgetUsd
    ) {
      this._opts.ledger.flagBudgetExceeded()
    }
    this._visionCalls++
    return response
  }

  private _parseAction(content: string): ProposedAction {
    try {
      const parsed = JSON.parse(content) as Record<string, unknown>
      const action = String(parsed.action ?? '')
      if (!['click', 'type', 'pressKeys', 'scroll', 'wait', 'done', 'fail'].includes(action)) {
        return { action: 'fail', reasoning: `unknown action: ${action}` }
      }
      return {
        action: action as ProposedAction['action'],
        x: typeof parsed.x === 'number' ? parsed.x : undefined,
        y: typeof parsed.y === 'number' ? parsed.y : undefined,
        text: typeof parsed.text === 'string' ? parsed.text : undefined,
        keys: Array.isArray(parsed.keys) ? parsed.keys.map((k) => String(k)) : undefined,
        dx: typeof parsed.dx === 'number' ? parsed.dx : undefined,
        dy: typeof parsed.dy === 'number' ? parsed.dy : undefined,
        ms: typeof parsed.ms === 'number' ? parsed.ms : undefined,
        reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
      } as unknown as ProposedAction
    } catch (e) {
      return { action: 'fail', reasoning: `JSON parse failed: ${(e as Error).message}` }
    }
  }

  private _parseAssertion(content: string): AssertionResult {
    try {
      const parsed = JSON.parse(content) as Record<string, unknown>
      const verdict = String(parsed.verdict ?? '')
      if (verdict !== 'pass' && verdict !== 'fail') {
        return { verdict: 'fail', reasoning: `invalid verdict: ${verdict}` }
      }
      return {
        verdict,
        reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
      }
    } catch (e) {
      return { verdict: 'fail', reasoning: `JSON parse failed: ${(e as Error).message}` }
    }
  }

  private async _resolveAction(
    action: ProposedAction,
  ): Promise<{ bbox: Bbox; clickPoint: Point; a11ySnippet: string } | undefined> {
    if (action.x === undefined || action.y === undefined) {
      return undefined
    }
    return this._resolveNode(action.x, action.y)
  }

  private async _resolveNode(
    x: number,
    y: number,
  ): Promise<{ bbox: Bbox; clickPoint: Point; a11ySnippet: string }> {
    const info = await this._opts.driver.rawPage.evaluate<
      { x: number; y: number; width: number; height: number; snippet: string } | null,
      [number, number]
    >(([cx, cy]) => {
      const doc = (
        globalThis as unknown as {
          document: { elementFromPoint: (x: number, y: number) => unknown }
        }
      ).document
      const el = doc.elementFromPoint(cx, cy) as {
        getBoundingClientRect: () => { x: number; y: number; width: number; height: number }
        getAttribute: (attr: string) => string | null
        textContent: string | null
      } | null
      if (!el) {
        return null
      }
      const rect = el.getBoundingClientRect()
      const snippet = ((el.getAttribute('aria-label') as string | null) || el.textContent || '').trim().slice(0, 200)
      return {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        snippet,
      }
    }, [x, y])

    if (!info) {
      return {
        bbox: { x, y, width: 0, height: 0 },
        clickPoint: { x, y },
        a11ySnippet: '',
      }
    }
    return { bbox: info, clickPoint: { x, y }, a11ySnippet: info.snippet }
  }

  private async _executeAction(tdApi: TestDriverApi, action: ProposedAction | ActionPayload): Promise<Observation> {
    switch (action.action) {
      case 'click':
        return tdApi.click(action.x ?? 0, action.y ?? 0)
      case 'type':
        return tdApi.type(action.text ?? '')
      case 'pressKeys':
        return tdApi.pressKeys(action.keys ?? [])
      case 'scroll':
        return tdApi.scroll(action.dx ?? 0, action.dy ?? 0)
      case 'wait':
        return tdApi.wait(action.ms ?? 0)
      default:
        return this._opts.driver.observe()
    }
  }

  private async _buildFingerprint(
    instruction: string,
    action: ProposedAction,
    resolved: { bbox: Bbox; clickPoint: Point; a11ySnippet: string } | undefined,
    model: string,
  ): Promise<FingerprintRecord> {
    const { reasoning: _, ...payload } = action
    const actionPayload = payload as ActionPayload
    if (!resolved) {
      return {
        instruction,
        action: actionPayload,
        bbox: { x: 0, y: 0, width: 0, height: 0 },
        clickPoint: { x: 0, y: 0 },
        model,
        a11ySnippet: '',
        regionHash: '',
      }
    }
    const regionBuffer = await this._regionScreenshot(resolved.bbox)
    return {
      instruction,
      action: actionPayload,
      bbox: resolved.bbox,
      clickPoint: resolved.clickPoint,
      model,
      a11ySnippet: resolved.a11ySnippet,
      regionHash: computeRegionHash(regionBuffer),
    }
  }

  private async _regionScreenshot(bbox: Bbox): Promise<Buffer> {
    const raw = await this._opts.driver.rawPage.screenshot({
      clip: { x: bbox.x, y: bbox.y, width: bbox.width, height: bbox.height },
      type: 'jpeg',
      quality: 70,
      scale: 'css',
    })
    return Buffer.from(raw)
  }

  private _result(ok: boolean, reason?: string): RunResult {
    return { ok, steps: this._steps, visionCalls: this._visionCalls, ...(reason ? { reason } : {}) }
  }
}
