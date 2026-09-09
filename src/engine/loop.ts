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
  fnv1a,
  FingerprintRecord,
  Point,
} from '../cache/fingerprint.js'
import { CachedAssert, FlowCache, saveFlow } from '../cache/store.js'
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
  /** Assertion verdicts persisted from a prior run of this flow. */
  initialAsserts?: CachedAssert[]
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

export interface LocateResult {
  ok: boolean
  reason: string | undefined
  healed: boolean
  point: Point | undefined
  fingerprint: FingerprintRecord | undefined
  model: string | undefined
}

export class Engine {
  private _visionCalls = 0
  private _steps: StepResult[] = []
  private _fingerprints: FingerprintRecord[] = []
  private _assertCache = new Map<string, CachedAssert>()

  constructor(private _opts: EngineOptions) {
    for (const entry of _opts.initialAsserts ?? []) {
      this._assertCache.set(`${entry.question}${entry.a11yHash}`, entry)
    }
  }

  /** Assertion verdicts collected/known this run — persist into the flow cache. */
  get assertEntries(): CachedAssert[] {
    return [...this._assertCache.values()]
  }

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
    let observation = await this._opts.driver.observe({ grid: true })

    for (let i = 0; i < cap; i++) {
      const response = await this._callModel(
        'ground',
        buildActionMessages(instruction, observation),
      )
      if (!response) {
        return this._result(false, 'budget exceeded or model call blocked')
      }

      const action = this._parseAction(response.content)

      if (action.action === 'done') {
        this._steps.push({
          instruction,
          action: 'done',
          ok: true,
          reason: action.reasoning,
          model: response.model,
        })
        break
      }

      if (action.action === 'fail') {
        this._steps.push({
          instruction,
          action: 'fail',
          ok: false,
          reason: action.reasoning,
          model: response.model,
        })
        return this._result(false, action.reasoning)
      }

      const resolved = await this._resolveAction(action)
      const nextObservation = await this._executeAction(tdApi, action)
      const fingerprint = await this._buildFingerprint(
        instruction,
        action,
        resolved,
        response.model,
      )

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
      const newFingerprint = await this._buildFingerprint(
        step.instruction,
        action,
        resolved,
        response.model,
      )
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

  /**
   * Resolve a single element for the `td.find()` DSL (R13). When `cached` is
   * provided and still resolves locally, this costs zero vision calls (R2);
   * otherwise it grounds (or heals) via the model and returns a fresh
   * fingerprint (R4). The returned point is the viewport-pixel click target.
   */
  async locate(instruction: string, cached?: FingerprintRecord): Promise<LocateResult> {
    const observation = await this._opts.driver.observe({ grid: true })

    if (cached) {
      const regionBuffer = await this._regionScreenshot(cached.bbox)
      const resolve = new Fingerprint(cached).resolve(regionBuffer, observation.a11yYaml)
      if (resolve.matched) {
        return {
          ok: true,
          reason: undefined,
          healed: false,
          point: cached.clickPoint,
          fingerprint: cached,
          model: undefined,
        }
      }
      if (this._opts.ledger.replayOnly || !this._opts.ledger.canSpend(0.001)) {
        return {
          ok: false,
          reason: 'fingerprint mismatch and budget/replay-only prevents heal',
          healed: false,
          point: undefined,
          fingerprint: undefined,
          model: undefined,
        }
      }
    }

    const response = await this._callModel(
      cached ? 'heal' : 'ground',
      buildActionMessages(instruction, observation),
      cached ? [this._opts.config.escalation_model] : undefined,
    )
    if (!response) {
      return {
        ok: false,
        reason: 'model call blocked by budget',
        healed: false,
        point: undefined,
        fingerprint: undefined,
        model: undefined,
      }
    }

    let action = this._parseAction(response.content)
    let model = response.model

    // Verify-then-correct: resolve the DOM node under the proposed point and
    // check its label against the instruction's target words. A mismatch means
    // the model's pixel grounding drifted (small models are systematically
    // imprecise); re-ask once with the resolved element as feedback.
    for (let attempt = 0; attempt < 2; attempt++) {
      if (action.action === 'fail') {
        return {
          ok: false,
          reason: action.reasoning,
          healed: false,
          point: undefined,
          fingerprint: undefined,
          model,
        }
      }
      if (action.action !== 'click') break
      if (action.x === undefined || action.y === undefined) {
        return {
          ok: false,
          reason: `model returned "${action.action}" without coordinates (reasoning: ${(action.reasoning ?? '').slice(0, 160)})`,
          healed: false,
          point: undefined,
          fingerprint: undefined,
          model,
        }
      }

      const probe = await this._resolveNode(action.x, action.y)
      if (probe === null || instructionMatchesNode(instruction, probe.a11ySnippet)) break

      if (attempt === 1 || !this._opts.ledger.canSpend(0.001)) break
      const specialist = this._opts.config.grounding_model !== undefined
      const feedback = specialist
        ? // ui-tars-class models want their native prompt format.
          `Click on the UI element matching this description: ${instruction.replace(/^locate:\s*/i, '')}.`
        : `Your previous coordinates (${action.x},${action.y}) resolved to "${probe.a11ySnippet}", which does not match the target. Re-examine the grid labels and return corrected coordinates for: ${instruction}`
      const retry = await this._callModel(
        cached ? 'heal' : 'ground',
        buildActionMessages(feedback, observation),
        cached ? [this._opts.config.escalation_model] : undefined,
        this._opts.config.grounding_model,
      )
      if (!retry) break
      action = this._parseAction(retry.content)
      model = retry.model
    }

    if (action.action === 'fail') {
      return {
        ok: false,
        reason: action.reasoning,
        healed: false,
        point: undefined,
        fingerprint: undefined,
        model,
      }
    }
    if (action.x === undefined || action.y === undefined) {
      return {
        ok: false,
        reason: `model returned "${action.action}" without coordinates`,
        healed: false,
        point: undefined,
        fingerprint: undefined,
        model,
      }
    }

    const resolved = await this._resolveNode(action.x, action.y)
    // Never commit a fingerprint for a node we can see is wrong — a false
    // cache entry would silently replay the mis-click forever.
    if (
      resolved !== null &&
      action.action === 'click' &&
      !instructionMatchesNode(instruction, resolved.a11ySnippet)
    ) {
      return {
        ok: false,
        reason: `model grounded to "${resolved.a11ySnippet}", which does not match the instruction`,
        healed: false,
        point: undefined,
        fingerprint: undefined,
        model,
      }
    }
    const fingerprint = await this._buildFingerprint(instruction, action, resolved, model)
    return {
      ok: true,
      reason: undefined,
      healed: cached !== undefined,
      point: { x: action.x, y: action.y },
      fingerprint,
      model: response.model,
    }
  }

  async assert(question: string): Promise<AssertResult> {
    const observation = await this._opts.driver.observe()
    // Page-state key is the a11y tree, not screenshot bytes — JPEG pixels
    // shift every render, but identical DOM means the answer is unchanged.
    const a11yHash = fnv1a(observation.a11yYaml)
    const key = `${question}${a11yHash}`
    const cached = this._assertCache.get(key)
    if (cached) {
      return { verdict: cached.verdict, reasoning: cached.reasoning, cached: true }
    }

    if (this._opts.ledger.replayOnly || !this._opts.ledger.canSpend(0.001)) {
      return { verdict: 'fail', reasoning: 'budget exceeded or replay-only', cached: false }
    }

    const response = await this._callModel('assert', buildAssertMessages(question, observation))
    if (!response) {
      return { verdict: 'fail', reasoning: 'budget exceeded', cached: false }
    }

    const parsed = this._parseAssertion(response.content)
    this._assertCache.set(key, {
      question,
      a11yHash,
      verdict: parsed.verdict,
      reasoning: parsed.reasoning,
      model: response.model,
    })
    return { ...parsed, cached: false }
  }

  private async _callModel(
    kind: CallKind,
    messages: Message[],
    escalationModels?: string[],
    modelOverride?: string,
  ): Promise<{ id: string; content: string; cost: CallCost; model: string } | undefined> {
    if (!this._opts.ledger.canSpend(0.001)) {
      return undefined
    }
    // Specialist grounding models don't emit JSON — sending response_format
    // plus require_parameters would filter out their providers entirely.
    const schema =
      modelOverride === undefined ? (kind === 'assert' ? assertionSchema : actionSchema) : undefined
    const response = await this._opts.client.complete({
      model: modelOverride ?? this._opts.config.model,
      messages,
      ...(schema !== undefined ? { schema } : {}),
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
      // Variant shape some models emit: {"click": "(x,y)"} or
      // {"click": {"x": .., "y": ..}} — action name as key, payload as value.
      const variantKey = ['click', 'type', 'pressKeys', 'scroll', 'wait', 'done', 'fail'].find(
        (k) => k in parsed,
      )
      if (parsed.action === undefined && variantKey !== undefined) {
        const v = parsed[variantKey]
        const out: Record<string, unknown> = { action: variantKey }
        if (typeof v === 'object' && v !== null) Object.assign(out, v)
        else if (typeof v === 'string') {
          const coord = v.match(/\(?\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*\)?/)
          if (coord) {
            out.x = Number(coord[1])
            out.y = Number(coord[2])
          } else {
            out.text = v
          }
        }
        if (typeof parsed.reasoning === 'string') out.reasoning = parsed.reasoning
        return out as unknown as ProposedAction
      }

      const action = String(parsed.action ?? '')
      if (!['click', 'type', 'pressKeys', 'scroll', 'wait', 'done', 'fail'].includes(action)) {
        return {
          action: 'fail',
          reasoning: `unknown action: ${action} (raw: ${content.slice(0, 160)})`,
        }
      }
      // Some specialist models return JSON action names but put coordinates in
      // a trailing "(x,y)" or start_box token instead of the schema fields.
      let x = typeof parsed.x === 'number' ? parsed.x : undefined
      let y = typeof parsed.y === 'number' ? parsed.y : undefined
      if (x === undefined || y === undefined) {
        const coord = content.match(/\(?\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*\)?/)
        if (coord) {
          x = Number(coord[1])
          y = Number(coord[2])
        }
      }
      return {
        action: action as ProposedAction['action'],
        x,
        y,
        text: typeof parsed.text === 'string' ? parsed.text : undefined,
        keys: Array.isArray(parsed.keys) ? parsed.keys.map((k) => String(k)) : undefined,
        dx: typeof parsed.dx === 'number' ? parsed.dx : undefined,
        dy: typeof parsed.dy === 'number' ? parsed.dy : undefined,
        ms: typeof parsed.ms === 'number' ? parsed.ms : undefined,
        reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
      } as unknown as ProposedAction
    } catch (e) {
      // Tolerant fallback for specialist grounding models (e.g. ui-tars) that
      // answer with a bare "(x,y)" or `click(start_box='(x,y)')` instead of
      // JSON. Coordinates are absolute pixels of the screenshot; values <= 1
      // are treated as normalized [0,1] and scaled to the viewport.
      const coord = content.match(/\(?\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*\)?/)
      // Malformed-JSON fallback: pull "x":N and "y":N fields independently.
      const xm = content.match(/"x"\s*:\s*(\d+(?:\.\d+)?)/)
      const ym = content.match(/"y"\s*:\s*(\d+(?:\.\d+)?)/)
      const px = coord?.[1] ?? xm?.[1]
      const py = coord?.[2] ?? ym?.[1]
      if (px !== undefined && py !== undefined) {
        let x = Number(px)
        let y = Number(py)
        if (x <= 1 && y <= 1) {
          x = Math.round(x * 1280)
          y = Math.round(y * 720)
        }
        return {
          action: 'click',
          x: Math.round(x),
          y: Math.round(y),
          reasoning: `coordinate-only response: ${content.slice(0, 120)}`,
        } as ProposedAction
      }
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
    >(
      ([cx, cy]) => {
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
        const snippet = ((el.getAttribute('aria-label') as string | null) || el.textContent || '')
          .trim()
          .slice(0, 200)
        return {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          snippet,
        }
      },
      [x, y],
    )

    if (!info) {
      return {
        bbox: { x, y, width: 0, height: 0 },
        clickPoint: { x, y },
        a11ySnippet: '',
      }
    }
    return { bbox: info, clickPoint: { x, y }, a11ySnippet: info.snippet }
  }

  private async _executeAction(
    tdApi: TestDriverApi,
    action: ProposedAction | ActionPayload,
  ): Promise<Observation> {
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
        return this._opts.driver.observe({ grid: true })
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

/**
 * Cheap semantic check for the verify-then-correct loop: does the resolved
 * node's label share any content word with the instruction? Stopwords and
 * short words are ignored; quoted phrases are split into words.
 */
const LOCATE_STOPWORDS = new Set([
  'the', 'a', 'an', 'in', 'on', 'of', 'to', 'for', 'with', 'below', 'above',
  'left', 'right', 'top', 'bottom', 'side', 'sidebar', 'navigation', 'nav',
  'item', 'button', 'link', 'field', 'input', 'section', 'area', 'panel',
  'that', 'this', 'into', 'onto', 'page', 'view', 'menu', 'click', 'find',
])

export function instructionMatchesNode(instruction: string, nodeSnippet: string): boolean {
  const words = instruction
    .replace(/^locate:\s*/i, '')
    .toLowerCase()
    .replace(/["'']/g, ' ')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4 && !LOCATE_STOPWORDS.has(w))
  if (words.length === 0) return true
  const haystack = nodeSnippet.toLowerCase()
  return words.some((w) => haystack.includes(w))
}
