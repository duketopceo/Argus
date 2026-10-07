import { BrowserDriver, Observation } from '../driver/browser.js'
import type { Page } from 'playwright'
import { Actions } from './actions.js'
import { Config } from '../config.js'
import { fnv1a } from '../cache/fingerprint.js'
import { ErrorRecord } from '../journal/schema.js'
import { Logger } from '../log.js'
import { Ledger } from '../vision/ledger.js'
import { CallCost } from '../vision/cost.js'
import {
  buildExploreMessages,
  ExploreAction,
  exploreActionSchema,
  PriorAct,
} from './prompts.js'
import type { VisionClient } from './loop.js'

/** Model-typed text is bounded before it reaches the driver. */
const MAX_TYPE_CHARS = 500
/** Explore never waits more than 5s per step — long waits burn the cap. */
const MAX_WAIT_MS = 5_000
/** Scroll deltas are clamped so a model can't request absurd jumps. */
const MAX_SCROLL_PX = 3_000
/** Same page signature this many times total → 'stalled' (catches ping-pong, not just idle). */
const STALL_LIMIT = 3
/**
 * Explore needs form submit and focus movement, not arbitrary chords —
 * anything outside this list is dropped from a pressKeys proposal.
 */
const ALLOWED_KEYS = new Set([
  'Enter',
  'Tab',
  'Escape',
  'Backspace',
  'Delete',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'Space',
])

export type ExploreStopReason =
  | 'done'
  | 'max-steps'
  | 'budget'
  | 'stalled'
  | 'error'
  | 'expectation'
  | 'timeout'

interface ExploreStep {
  action: string
  /** Page URL after the act. */
  url: string
  /** Refusal/execution note (e.g. 'refused: cross-origin'). */
  note?: string
}

export interface ExploreResult {
  steps: ExploreStep[]
  /** Distinct page URLs visited during the pass. */
  visited: number
  stopReason: ExploreStopReason
  visionCalls: number
  /** Spend attributable to this explore pass (delta over the shared ledger). */
  visionCostUsd: number
  notes: ErrorRecord[]
  /** Page URL at stop time — the lane records where evidence ended. */
  finalUrl: string | undefined
}

/** Lane-side expected-state input: fresh observation, current URL, raw page. */
export interface ExpectationContext {
  observation: Observation
  url: string
  page: Page
}

export interface ExploreOptions {
  driver: BrowserDriver
  actions: Actions
  client: VisionClient
  ledger: Ledger
  config: Config
  /** Resolved run URL — the structural origin bound for `navigate`. */
  targetUrl: string
  logger?: Logger
  /**
   * Directed-task text (verify --app): replaces the free-probe goal in the
   * prompt. The substrate stays observation/act machinery either way.
   */
  task?: string
  /** Epoch-ms wall-clock bound — checked each step; 'timeout' on expiry. */
  deadlineAt?: number
  /**
   * Lane-side expected-state predicate evaluated on each fresh observation
   * before the model call — a satisfied marker stops the loop without
   * spending another call ('expectation'). Throwing degrades to a note.
   */
  expectation?: (ctx: ExpectationContext) => Promise<boolean>
  /** Lane step-cap override; defaults to config.explore.maxSteps. */
  maxSteps?: number
  /** Lane spend-cap override; defaults to config.explore.budgetUsd. */
  budgetUsd?: number
}

/**
 * Free-explore act policy (U4b): observe → propose → bound → execute →
 * repeat, with no recorded flow. Every proposal is validated against the
 * action vocabulary, the same-origin navigation bound, and the input caps
 * before it reaches the driver — model output is a proposal, never an
 * instruction (R8). The loop halts on done, maxSteps, budget, stall, or an
 * execution error; it never throws.
 */
export async function runExplore(opts: ExploreOptions): Promise<ExploreResult> {
  const { driver, actions, client, ledger, config, logger } = opts
  const maxSteps = opts.maxSteps ?? config.explore.maxSteps
  const laneBudget = opts.budgetUsd ?? config.explore.budgetUsd ?? config.budgetUsd
  const costStart = ledger.visionCostUsd

  // Non-http(s) targets (file:// demos) get a no-navigate policy — 'null'
  // origin cannot be compared, so navigate proposals are always refused.
  const targetOrigin = httpOrigin(opts.targetUrl)

  const steps: ExploreStep[] = []
  const priorActs: PriorAct[] = []
  const notes: ErrorRecord[] = []
  const visited = new Set<string>()
  const signatures = new Map<string, number>()
  let visionCalls = 0

  const note = (message: string, context?: string): void => {
    notes.push({ stage: 'explore', message, ...(context !== undefined ? { context } : {}) })
    logger?.debug(`explore: ${message}${context !== undefined ? ` (${context})` : ''}`)
  }
  const finish = (stopReason: ExploreStopReason): ExploreResult => {
    let finalUrl: string | undefined
    try {
      finalUrl = driver.rawPage.url()
    } catch {
      // A dead page leaves no final URL — evidence, not a crash.
    }
    return {
      steps,
      visited: visited.size,
      stopReason,
      visionCalls,
      visionCostUsd: ledger.visionCostUsd - costStart,
      notes,
      finalUrl,
    }
  }
  const budgetExhausted = (): boolean =>
    ledger.replayOnly ||
    !ledger.canSpend(0.001) ||
    (laneBudget !== undefined && ledger.visionCostUsd - costStart >= laneBudget)

  let observation: Observation | undefined
  for (let i = 0; i < maxSteps; i++) {
    if (budgetExhausted()) return finish('budget')
    if (opts.deadlineAt !== undefined && Date.now() >= opts.deadlineAt) {
      return finish('timeout')
    }

    try {
      observation = observation ?? (await driver.observe({ grid: true }))
    } catch (e) {
      note('observe failed', (e as Error).message)
      return finish('error')
    }
    const url = driver.rawPage.url()
    visited.add(url)

    const sig = fnv1a(`${url}\n${observation.a11yYaml}`)
    const seen = (signatures.get(sig) ?? 0) + 1
    signatures.set(sig, seen)
    if (seen >= STALL_LIMIT) {
      note('page state unchanged — stopping')
      return finish('stalled')
    }

    // Lane-side expected state is checked on the fresh observation *before*
    // spending a model call — a satisfied marker ends the loop for free.
    if (opts.expectation !== undefined) {
      try {
        if (await opts.expectation({ observation, url, page: driver.rawPage })) {
          return finish('expectation')
        }
      } catch (e) {
        note('expectation check failed', (e as Error).message)
      }
    }

    let response: { content: string; cost: CallCost; model: string }
    try {
      response = await client.complete({
        model: config.model,
        messages: buildExploreMessages(observation, priorActs, opts.task),
        schema: exploreActionSchema,
        provider: config.provider,
        kind: 'explore',
      })
    } catch (e) {
      note('model call threw', (e as Error).message)
      return finish('error')
    }
    ledger.recordCall(response.cost)
    visionCalls++
    if (laneBudget !== undefined && ledger.visionCostUsd - costStart > laneBudget) {
      ledger.flagBudgetExceeded()
    }

    const action = parseExploreAction(response.content)
    if (action === undefined) {
      note('unparseable proposal', response.content.slice(0, 160))
      steps.push({ action: 'noop', url, note: 'unparseable proposal' })
      priorActs.push({ action: { action: 'fail', reasoning: 'unparseable' }, url, note: 'unparseable proposal' })
      continue
    }
    if (action.action === 'done') {
      steps.push({ action: 'done', url })
      return finish('done')
    }

    const bounded = boundAction(action, url, targetOrigin, observation)
    let nextUrl = url
    let stepNote = bounded.refusal
    if (bounded.refusal === undefined) {
      try {
        observation = await executeExploreAction(actions, bounded.action)
        nextUrl = driver.rawPage.url()
        if (httpOrigin(nextUrl) === targetOrigin) {
          visited.add(nextUrl)
        } else {
          // A click or submit can leave the target without a navigate
          // proposal — the origin bound applies to wherever an act
          // lands, not just to navigate. Discard the foreign
          // observation and return to the last in-origin page; if we
          // can't get back, the pass stops rather than act off-origin.
          note('act left target origin — returning', nextUrl)
          stepNote = 'refused: left target origin'
          observation = undefined
          nextUrl = url
          try {
            await driver.goto(url)
          } catch (e) {
            note('return to target origin failed', (e as Error).message)
            steps.push({ action: bounded.action.action, url, note: stepNote })
            priorActs.push({ action: bounded.action, url, note: stepNote })
            return finish('error')
          }
        }
      } catch (e) {
        // A failed act (nav timeout, detached node, dead page) is evidence of
        // a broken app, not a loop failure — journal it and let the model
        // pick a different probe next step.
        note(`act ${bounded.action.action} failed`, (e as Error).message)
        stepNote = `failed: ${(e as Error).message.slice(0, 80)}`
        observation = undefined
      }
    } else {
      note(`act refused: ${bounded.refusal}`, bounded.action.url ?? bounded.action.action)
      observation = undefined
    }
    steps.push({
      action: bounded.action.action,
      url: nextUrl,
      ...(stepNote !== undefined ? { note: stepNote } : {}),
    })
    priorActs.push({
      action: bounded.action,
      url: nextUrl,
      ...(stepNote !== undefined ? { note: stepNote } : {}),
    })
  }
  return finish('max-steps')
}

/** Parse an http(s) origin; anything else (file://, parse failure) → null. */
function httpOrigin(url: string): string | undefined {
  try {
    const parsed = new URL(url)
    if (!/^https?:$/.test(parsed.protocol)) return undefined
    return parsed.origin
  } catch {
    return undefined
  }
}

interface Bounded {
  action: ExploreAction
  refusal?: string
}

/**
 * Structural bounds applied to every proposal before it reaches the driver
 * (R3, R7, R8): same-origin navigation, typed-text truncation, key
 * allowlist, scroll/wait clamps. Returns either the bounded action or a
 * refusal string — refused proposals still consume a step so the loop
 * cannot spin on refusals for free.
 */
function boundAction(
  action: ExploreAction,
  currentUrl: string,
  targetOrigin: string | undefined,
  observation: Observation,
): Bounded {
  switch (action.action) {
    case 'navigate': {
      const raw = typeof action.url === 'string' ? action.url.trim() : ''
      if (raw === '') return { action, refusal: 'navigate without url' }
      let resolved: URL
      try {
        resolved = new URL(raw, currentUrl)
      } catch {
        return { action, refusal: 'unparseable url' }
      }
      if (!/^https?:$/.test(resolved.protocol)) {
        return { action, refusal: `refused scheme: ${resolved.protocol}` }
      }
      if (targetOrigin === undefined || resolved.origin !== targetOrigin) {
        return { action, refusal: 'refused: cross-origin' }
      }
      return { action: { ...action, url: resolved.href } }
    }
    case 'type': {
      const text = (action.text ?? '').slice(0, MAX_TYPE_CHARS)
      return { action: { ...action, text } }
    }
    case 'pressKeys': {
      const keys = (action.keys ?? []).filter((k) => ALLOWED_KEYS.has(k))
      if (keys.length === 0) return { action, refusal: 'no allowed keys' }
      return { action: { ...action, keys } }
    }
    case 'scroll': {
      const clamp = (v: number | undefined) =>
        Math.max(-MAX_SCROLL_PX, Math.min(MAX_SCROLL_PX, Number.isFinite(v) ? (v as number) : 0))
      return { action: { ...action, dx: clamp(action.dx), dy: clamp(action.dy) } }
    }
    case 'wait': {
      const ms = Math.max(0, Math.min(MAX_WAIT_MS, Number.isFinite(action.ms) ? (action.ms as number) : 0))
      return { action: { ...action, ms } }
    }
    case 'click': {
      const x = Number.isFinite(action.x) ? Math.round(action.x as number) : undefined
      const y = Number.isFinite(action.y) ? Math.round(action.y as number) : undefined
      if (
        x === undefined ||
        y === undefined ||
        x < 0 ||
        y < 0 ||
        x > observation.width ||
        y > observation.height
      ) {
        return { action, refusal: 'click coordinates out of viewport' }
      }
      return { action: { ...action, x, y } }
    }
    default:
      return { action, refusal: `unsupported action: ${action.action}` }
  }
}

async function executeExploreAction(
  actions: Actions,
  action: ExploreAction,
): Promise<Observation> {
  switch (action.action) {
    case 'click':
      return actions.click(action.x as number, action.y as number)
    case 'type':
      return actions.type(action.text ?? '')
    case 'pressKeys':
      return actions.pressKeys(action.keys ?? [])
    case 'scroll':
      return actions.scroll(action.dx ?? 0, action.dy ?? 0)
    case 'wait':
      return actions.wait(action.ms ?? 0)
    case 'navigate':
      return actions.navigate(action.url as string)
    default:
      return actions.wait(0)
  }
}

/**
 * Tolerant parse of the explore proposal, mirroring Engine's `_parseAction`
 * shape: strict JSON first, the {"click": "(x,y)"} variant, then a bare
 * coordinate extraction for specialist models. Returns undefined when
 * nothing usable can be recovered — the caller counts it as a step.
 */
export function parseExploreAction(content: string): ExploreAction | undefined {
  const coerce = (parsed: Record<string, unknown>): ExploreAction | undefined => {
    const action = String(parsed.action ?? '')
    if (
      !['click', 'type', 'pressKeys', 'scroll', 'wait', 'navigate', 'done', 'fail'].includes(action)
    ) {
      return undefined
    }
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
      action: action as ExploreAction['action'],
      ...(x !== undefined ? { x } : {}),
      ...(y !== undefined ? { y } : {}),
      ...(typeof parsed.text === 'string' ? { text: parsed.text } : {}),
      ...(Array.isArray(parsed.keys) ? { keys: parsed.keys.map((k) => String(k)) } : {}),
      ...(typeof parsed.dx === 'number' ? { dx: parsed.dx } : {}),
      ...(typeof parsed.dy === 'number' ? { dy: parsed.dy } : {}),
      ...(typeof parsed.ms === 'number' ? { ms: parsed.ms } : {}),
      ...(typeof parsed.url === 'string' ? { url: parsed.url } : {}),
      reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
    }
  }

  try {
    const parsed = JSON.parse(content) as Record<string, unknown>
    const variantKey = [
      'click',
      'type',
      'pressKeys',
      'scroll',
      'wait',
      'navigate',
      'done',
      'fail',
    ].find((k) => k in parsed)
    if (parsed.action === undefined && variantKey !== undefined) {
      const v = parsed[variantKey]
      const out: Record<string, unknown> = { action: variantKey }
      if (typeof v === 'object' && v !== null) Object.assign(out, v)
      else if (typeof v === 'string') {
        const coord = v.match(/\(?\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*\)?/)
        if (coord) {
          out.x = Number(coord[1])
          out.y = Number(coord[2])
        } else if (variantKey === 'navigate') {
          out.url = v
        } else {
          out.text = v
        }
      }
      if (typeof parsed.reasoning === 'string') out.reasoning = parsed.reasoning
      return coerce(out)
    }
    return coerce(parsed)
  } catch {
    const coord = content.match(/\(?\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*\)?/)
    if (coord) {
      return {
        action: 'click',
        x: Math.round(Number(coord[1])),
        y: Math.round(Number(coord[2])),
        reasoning: `coordinate-only response: ${content.slice(0, 120)}`,
      }
    }
    return undefined
  }
}
