import { BrowserDriver } from './driver/browser.js'
import { Actions } from './engine/actions.js'
import { Engine, VisionClient } from './engine/loop.js'
import { AssertionResult } from './engine/prompts.js'
import { FingerprintRecord } from './cache/fingerprint.js'
import { CachedAssert, FlowCache, loadFlow, saveFlow } from './cache/store.js'
import { Ledger, LedgerState } from './vision/ledger.js'
import { Config, defineConfig } from './config.js'
import { ErrorRecord } from './journal/schema.js'
import { Logger } from './log.js'
export { defineConfig }
export {
  DecisionClient,
  DecisionError,
  JEV_DEFAULT_MODEL,
  type DecisionAnswer,
  type DecisionClientOptions,
  type DecisionErrorKind,
  type DecisionQuestion,
} from './vision/decisions.js'

/**
 * Test-facing API (R13). Test files are plain TypeScript using a `td` object:
 *
 *   test('landing', async (td) => {
 *     await td.find('the "See pricing" button').click()
 *     await td.type('user@example.com')
 *     await td.pressKeys(['tab'])
 *     const ok = await td.assert('The pricing section is visible')
 *   })
 *
 * `td` calls resolve elements through the engine's fingerprint cache — a
 * cache hit costs zero vision calls, a miss grounds (or heals) via the model.
 */

export interface TypeOptions {
  /**
   * When true, `text` is a secret name: the typed value comes from
   * `config.secrets[name]` (or the `name` environment variable) and is never
   * sent to the model. The model only resolves which field receives it.
   */
  secret?: boolean
}

export interface TdHandle {
  click(): Promise<void>
  doubleClick(): Promise<void>
}

export interface Td {
  find(description: string): TdHandle
  type(text: string, options?: TypeOptions): Promise<void>
  pressKeys(keys: string[]): Promise<void>
  assert(question: string): Promise<AssertionResult>
  wait(ms: number): Promise<void>
  scroll(dx: number, dy: number): Promise<void>
}

export interface TdStepRecord {
  instruction: string
  action: string
  ok: boolean
  healed: boolean
  model: string | undefined
  reason: string | undefined
}

export interface TdAssertRecord extends AssertionResult {
  question: string
  cached: boolean
}

export interface HealEvent {
  instruction: string
  model: string | undefined
  /** Step position in the loaded flow — set for write-back diffing. */
  index?: number | undefined
  /** The record the session loaded pre-heal. */
  before?: FingerprintRecord | undefined
  /** The healed record the model re-resolved. */
  after?: FingerprintRecord | undefined
}

export interface TdSessionOptions {
  driver: BrowserDriver
  client: VisionClient
  config: Config
  /** Flow name used to load/save the fingerprint cache for this test. */
  flowName?: string
  /**
   * Committed recordings dir (`<testsDir>/flows`) — the canonical fallback
   * when no cache entry exists. Read-only here; write-back lands via
   * `flow.healWriteback` (PR in CI, working-tree write locally).
   */
  flowsDir?: string
  env?: NodeJS.ProcessEnv
  /**
   * Set by the run path when diff-aware invalidation fired — marks every
   * loaded fingerprint `stale` so they re-ground on first use.
   */
  staleReason?: string
  logger?: Logger
}

const KEY_ALIASES: Record<string, string> = {
  tab: 'Tab',
  enter: 'Enter',
  return: 'Enter',
  escape: 'Escape',
  esc: 'Escape',
  backspace: 'Backspace',
  delete: 'Delete',
  space: ' ',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  shift: 'Shift',
  control: 'Control',
  ctrl: 'Control',
  alt: 'Alt',
  meta: 'Meta',
  cmd: 'Meta',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
}

export function normalizeKey(key: string): string {
  if (key.includes('+')) {
    return key
      .split('+')
      .map((part) => normalizeKey(part.trim()))
      .join('+')
  }
  const lowered = key.toLowerCase()
  const alias = KEY_ALIASES[lowered]
  if (alias !== undefined) return alias
  if (key.length === 1) return key
  return key.charAt(0).toUpperCase() + key.slice(1)
}

/**
 * One session per executed test. Owns the ledger + engine, replays the
 * per-test fingerprint cache, and records steps/heals/asserts for the report.
 */
export class TdSession {
  readonly td: Td
  readonly ledger: Ledger
  readonly steps: TdStepRecord[] = []
  readonly asserts: TdAssertRecord[] = []
  readonly healEvents: HealEvent[] = []

  private readonly engine: Engine
  private readonly actions: Actions
  private readonly flow: FlowCache | undefined
  private readonly fingerprints: FingerprintRecord[] = []
  private _failed = false
  private _failureReason: string | undefined

  private constructor(
    private readonly opts: TdSessionOptions,
    flow: FlowCache | undefined,
  ) {
    this.flow = flow
    if (opts.staleReason !== undefined && flow !== undefined) {
      const reason = opts.staleReason
      flow.steps = flow.steps.map((step) => ({ ...step, stale: reason }))
    }
    this.ledger = new Ledger(opts.config.budgetUsd)
    this.actions = new Actions(opts.driver)
    this.engine = new Engine({
      driver: opts.driver,
      actions: this.actions,
      client: opts.client,
      ledger: this.ledger,
      config: opts.config,
      ...(flow?.asserts !== undefined ? { initialAsserts: flow.asserts } : {}),
      ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
    })
    this.td = this._makeTd()
  }

  static async create(opts: TdSessionOptions): Promise<TdSession> {
    const flow =
      opts.flowName !== undefined && opts.config.cacheDir !== undefined
        ? (await loadFlow(opts.config.cacheDir, opts.flowName)) ??
          (opts.flowsDir !== undefined ? await loadFlow(opts.flowsDir, opts.flowName) : undefined)
        : undefined
    return new TdSession(opts, flow)
  }

  get visionCalls(): number {
    return this.engine.visionCalls
  }

  get cacheStats() {
    return this.engine.cacheStats
  }

  /** Non-fatal anomalies observed by the engine — journaled as evidence. */
  get errorRecords(): ErrorRecord[] {
    return this.engine.errorRecords
  }

  get failed(): boolean {
    return this._failed
  }

  get failureReason(): string | undefined {
    return this._failureReason
  }

  get ledgerState(): LedgerState {
    return this.ledger.state
  }

  /** The session's final fingerprint set — healed records included. */
  get fingerprintRecords(): FingerprintRecord[] {
    return [...this.fingerprints]
  }

  /** Assertion entries in the cache's shape — persisted alongside steps. */
  get assertEntries(): CachedAssert[] {
    return this.engine.assertEntries
  }

  /** Persist the (possibly healed) fingerprints back to the cache (R4, R5). */
  async save(): Promise<void> {
    if (this.opts.flowName !== undefined && this.opts.config.cacheDir !== undefined) {
      await saveFlow(
        this.opts.config.cacheDir,
        this.opts.flowName,
        this.fingerprints,
        this.engine.assertEntries,
      )
    }
  }

  private _record(
    record: TdStepRecord,
    healDetail?: Pick<HealEvent, 'index' | 'before' | 'after'>,
  ): void {
    this.steps.push(record)
    if (!record.ok) {
      this._failed = true
      this._failureReason = record.reason ?? `${record.action} failed`
    }
    if (record.healed) {
      this.healEvents.push({
        instruction: record.instruction,
        model: record.model,
        ...healDetail,
      })
    }
  }

  private async _locate(description: string): Promise<{ x: number; y: number }> {
    const index = this.fingerprints.length
    const cached = this.flow?.steps[index]
    const result = await this.engine.locate(`locate: ${description}`, cached)
    if (!result.ok || result.point === undefined || result.fingerprint === undefined) {
      this._record({
        instruction: description,
        action: 'find',
        ok: false,
        healed: false,
        model: result.model,
        reason: result.reason,
      })
      throw new Error(`td.find("${description}") failed: ${result.reason ?? 'unknown reason'}`)
    }
    this.fingerprints.push(result.fingerprint)
    this._record(
      {
        instruction: description,
        action: 'find',
        ok: true,
        healed: result.healed,
        model: result.model,
        reason: undefined,
      },
      result.healed ? { index, before: cached, after: result.fingerprint } : undefined,
    )
    return result.point
  }

  /** Steps whose click had no observable effect (even after one retry); nothing was saved for them. */
  readonly noEffectSteps: string[] = []

  /**
   * Cheap page-state signature: URL, focused element, a DOM mutation counter
   * (child list, attributes, text, installed on first use) and the scroll
   * offset. Two equal signatures around an action mean it did nothing.
   */
  private async _stateSignature(): Promise<string> {
    return this.opts.driver.rawPage.evaluate(() => {
      type N = { id?: string }
      type Rec = {
        target: N
        addedNodes: ArrayLike<N>
        removedNodes: ArrayLike<N>
      }
      type G = {
        location: { href: string }
        document: {
          activeElement: { tagName?: string; id?: string; checked?: boolean; value?: string } | null
          documentElement: unknown
        }
        scrollX: number
        scrollY: number
        MutationObserver: new (cb: (m: Rec[]) => void) => {
          observe: (n: unknown, o: Record<string, boolean>) => void
        }
        __argusMutations?: { n: number; root: unknown }
      }
      const g = globalThis as unknown as G
      // Our own coordinate overlay (observe({grid:true})) is not the page reacting.
      const ours = (n: N): boolean => (n.id ?? '').startsWith('__argus_')
      if (g.__argusMutations === undefined || g.__argusMutations.root !== g.document.documentElement) {
        const counter = { n: 0, root: g.document.documentElement }
        new g.MutationObserver((records) => {
          for (const r of records) {
            const nodes = [...Array.from(r.addedNodes), ...Array.from(r.removedNodes)]
            if (ours(r.target) || (nodes.length > 0 && nodes.every(ours))) continue
            counter.n += 1
          }
        }).observe(g.document.documentElement, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true,
        })
        g.__argusMutations = counter
      }
      const a = g.document.activeElement
      return JSON.stringify([
        g.location.href,
        // Focus only counts for fields: a click focuses any button, which says nothing.
        /^(INPUT|TEXTAREA|SELECT)$/.test(a?.tagName ?? '') ? `${a?.tagName}#${a?.id ?? ''}` : '',
        `${a?.checked ?? ''}|${a?.value ?? ''}`,
        g.__argusMutations.n,
        g.scrollX,
        g.scrollY,
      ])
    })
  }

  /** Scroll the element under (x, y) into view and return its center. */
  private async _actionableCenter(x: number, y: number): Promise<{ x: number; y: number }> {
    return this.opts.driver.rawPage.evaluate(
      ([px, py]) => {
        type El = {
          closest: (s: string) => El | null
          scrollIntoView: (o: Record<string, string>) => void
          getBoundingClientRect: () => { x: number; y: number; width: number; height: number }
        }
        const doc = (
          globalThis as unknown as { document: { elementFromPoint: (x: number, y: number) => El | null } }
        ).document
        const hit = doc.elementFromPoint(px as number, py as number)
        if (hit === null) return { x: px as number, y: py as number }
        const el =
          hit.closest(
            'button,a[href],input,select,textarea,summary,label,[role=button],[role=checkbox],[role=switch],[role=link],[role=tab],[role=menuitem],[onclick]',
          ) ?? hit
        el.scrollIntoView({ block: 'center', inline: 'center' })
        const r = el.getBoundingClientRect()
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
      },
      [x, y],
    )
  }

  /**
   * Run the click for the step just located and confirm it took effect: the
   * page-state signature must differ afterwards. If not, retry once the way a
   * person would (scroll the element into view, let the page settle, click its
   * center). If it still did nothing the step fails with a clear reason and
   * nothing is persisted for it: a cold fingerprint is dropped, a heal is
   * replaced by the previous record marked stale and its heal event withdrawn.
   */
  private async _actVerified(
    point: { x: number; y: number },
    kind: 'click' | 'doubleClick',
  ): Promise<void> {
    const run = (p: { x: number; y: number }) =>
      kind === 'click' ? this.actions.click(p.x, p.y) : this.actions.doubleClick(p.x, p.y)
    const last = this.steps[this.steps.length - 1]
    const before = await this._stateSignature()
    await run(point)
    if ((await this._stateSignature()) !== before) return

    const center = await this._actionableCenter(point.x, point.y)
    await this.actions.wait(150)
    const beforeRetry = await this._stateSignature()
    await run(center)
    if ((await this._stateSignature()) !== beforeRetry) return

    const index = this.fingerprints.length - 1
    const previous = this.flow?.steps[index]
    if (last?.healed === true && previous !== undefined) {
      this.fingerprints[index] = { ...previous, stale: 'heal had no observable effect' }
    } else {
      this.fingerprints.pop()
    }
    const healIdx = this.healEvents.findIndex((h) => h.index === index)
    if (healIdx !== -1) this.healEvents.splice(healIdx, 1)
    const instruction = last?.instruction ?? ''
    this.noEffectSteps.push(instruction)
    const reason = `td.find("${instruction}") ${kind} had no observable effect (no URL, focus, DOM or scroll change), even after scrolling into view and clicking the element center; nothing was saved for this step`
    if (last !== undefined) {
      last.ok = false
      last.reason = reason
    }
    this._failed = true
    this._failureReason = reason
    throw new Error(reason)
  }

  private _makeTd(): Td {
    return {
      find: (description: string): TdHandle => ({
        click: async () => {
          const point = await this._locate(description)
          await this._actVerified(point, 'click')
        },
        doubleClick: async () => {
          const point = await this._locate(description)
          await this._actVerified(point, 'doubleClick')
        },
      }),

      type: async (text: string, options?: TypeOptions) => {
        if (options?.secret === true) {
          const value = this.opts.config.secrets?.[text] ?? this.opts.env?.[text]
          if (value === undefined) {
            this._failed = true
            this._failureReason = `secret "${text}" not found in config.secrets or environment`
            throw new Error(this._failureReason)
          }
          // The model only picks the field; the secret value never leaves the
          // harness (prompt-injection mitigation).
          const point = await this._locate(`the "${text}" input field`)
          await this.actions.click(point.x, point.y)
          await this.actions.type(value)
          return
        }
        await this.actions.type(text)
      },

      pressKeys: async (keys: string[]) => {
        await this.actions.pressKeys(keys.map(normalizeKey))
      },

      assert: async (question: string) => {
        const result = await this.engine.assert(question)
        this.asserts.push({ question, ...result })
        if (result.verdict === 'fail') {
          this._failed = true
          this._failureReason = `assert("${question}") failed: ${result.reasoning}`
        }
        return result
      },

      wait: async (ms: number) => {
        await this.actions.wait(ms)
      },

      scroll: async (dx: number, dy: number) => {
        await this.actions.scroll(dx, dy)
      },
    }
  }
}

export interface RegisteredTest {
  name: string
  fn: (td: Td) => void | Promise<void>
}

const registeredTests: RegisteredTest[] = []
let currentSession: TdSession | undefined

/** Register a test; called by test files at import time. */
export function test(name: string, fn: (td: Td) => void | Promise<void>): void {
  registeredTests.push({ name, fn })
}

/** Drain the registry — the runner calls this after importing a test file. */
export function takeTests(): RegisteredTest[] {
  return registeredTests.splice(0, registeredTests.length)
}

/** Bind the session the ambient `td` proxy delegates to. Internal to the runner. */
export function bindSession(session: TdSession | undefined): void {
  currentSession = session
}

function session(): TdSession {
  if (currentSession === undefined) {
    throw new Error('td used outside an argus-reviewer run — no active session')
  }
  return currentSession
}

/**
 * Ambient `td` for test files that use top-level calls instead of `test()`.
 * The CLI also exposes this as `globalThis.td` while importing test files.
 */
export const td: Td = {
  find: (description) => session().td.find(description),
  type: (text, options) => session().td.type(text, options),
  pressKeys: (keys) => session().td.pressKeys(keys),
  assert: (question) => session().td.assert(question),
  wait: (ms) => session().td.wait(ms),
  scroll: (dx, dy) => session().td.scroll(dx, dy),
}

/** Render a recorded flow as a plain-TS test file (R13). */
export function renderTestFile(flowName: string, steps: FingerprintRecord[]): string {
  const lines = steps.map((step) => {
    const instruction = JSON.stringify(step.instruction)
    switch (step.action.action) {
      case 'click':
        return `  await td.find(${instruction}).click()`
      case 'type':
        return `  await td.type(${JSON.stringify(step.action.text ?? '')})`
      case 'pressKeys':
        return `  await td.pressKeys(${JSON.stringify(step.action.keys ?? [])})`
      case 'wait':
        return `  await td.wait(${step.action.ms ?? 0})`
      case 'scroll':
        return `  await td.scroll(${step.action.dx ?? 0}, ${step.action.dy ?? 0})`
      default:
        return `  // TODO: unsupported recorded action ${JSON.stringify(step.action.action)}`
    }
  })
  return [
    `// Recorded by argus-reviewer: ${flowName}`,
    `// Run with: npx argus-reviewer run`,
    `test(${JSON.stringify(flowName)}, async (td) => {`,
    ...lines,
    '})',
    '',
  ].join('\n')
}
