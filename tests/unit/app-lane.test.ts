import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveConfig, type Config } from '../../src/config.js'
import { BrowserDriver } from '../../src/driver/browser.js'
import { TargetProcess } from '../../src/driver/target.js'
import type { VisionClient } from '../../src/engine/loop.js'
import {
  APP_LANE_REPORT,
  buildExpectationCheck,
  runAppLane,
} from '../../src/pipeline/app.js'
import { runVerify } from '../../src/pipeline/verify.js'
import type { CallCost, CallKind } from '../../src/vision/cost.js'
import type { JsonSchema, Message } from '../../src/vision/openrouter.js'
import type { ProviderRules } from '../../src/config.js'

const SERVE_SCRIPT = fileURLToPath(new URL('../fixtures/serve.mjs', import.meta.url))
const FIXTURE_DIR = fileURLToPath(new URL('../fixtures/', import.meta.url))

let APP_URL = ''
let fixtureServer: TargetProcess | undefined

beforeAll(async () => {
  const port = 6100 + Math.floor(Math.random() * 400)
  fixtureServer = await TargetProcess.start({
    command: `${JSON.stringify(process.execPath)} ${JSON.stringify(SERVE_SCRIPT)} ${port} ${JSON.stringify(FIXTURE_DIR)}`,
    url: `http://127.0.0.1:${port}/`,
    readyTimeoutMs: 10_000,
  })
  APP_URL = `${fixtureServer.url}app.html`
})

afterAll(async () => {
  await fixtureServer?.stop()
})

class StubClient implements VisionClient {
  calls: { kind: CallKind; model: string; text: string }[] = []
  private queue: { content: string }[]

  constructor(queue: { content: string }[]) {
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
    if (!next) throw new Error('stub client queue empty')
    const text = opts.messages
      .flatMap((m) => m.content)
      .filter((c) => c.type === 'text')
      .map((c) => ('text' in c ? c.text : ''))
      .join('\n')
    this.calls.push({ kind: opts.kind ?? 'ground', model: opts.model, text })
    const cost: CallCost = {
      model: opts.model,
      provider: 'stub',
      tokens: 10,
      costUsd: 0.001,
      kind: opts.kind ?? 'ground',
    }
    return { id: `stub-${this.calls.length}`, content: next.content, model: opts.model, cost }
  }
}

function laneConfig(overrides: Record<string, unknown> = {}): Config {
  return resolveConfig({ budgetUsd: 1, ...overrides })
}

function laneDeps(client: VisionClient) {
  return {
    launchDriver: async () => BrowserDriver.launch({ captureErrors: true }),
    createClient: () => client,
  }
}

/** The click that lands on the pinned Submit button (100,100 / 200x40). */
const CLICK_SUBMIT = JSON.stringify({ action: 'click', x: 200, y: 120, reasoning: 'submit' })
const CLAIM_DONE = JSON.stringify({ action: 'done', reasoning: 'looks finished' })
const WAIT = JSON.stringify({ action: 'wait', ms: 50, reasoning: 'pause' })

describe('verify --app lane', () => {
  it('passes only when the expected marker is verified (AE-A)', async () => {
    const client = new StubClient([{ content: CLICK_SUBMIT }])
    const report = await runAppLane({
      config: laneConfig(),
      url: APP_URL,
      trusted: true,
      task: 'Submit the form and confirm the success banner',
      expected: { text: 'Submission received' },
      deps: laneDeps(client),
    })
    expect(report.status).toBe('passed')
    expect(report.expectedMet).toBe(true)
    expect(report.stopReason).toBe('expectation')
    expect(report.steps.length).toBeGreaterThanOrEqual(1)
    expect(report.steps[0]!.action).toBe('click')
    expect(report.finalUrl).toBe(APP_URL)
    expect(report.visionCalls).toBe(1)
    expect(report.visionCostUsd).toBeCloseTo(0.001)
    expect(report.calls.length).toBe(1)
    // The seeded console error is captured as anomaly evidence.
    expect(report.anomalies.some((a) => a.kind === 'console-error')).toBe(true)
  }, 60_000)

  it('fails a task whose marker never appears — page load alone is not a pass', async () => {
    // The model immediately claims done without touching the page; the lane
    // must verify the marker itself and refuse the claimed completion.
    const client = new StubClient([{ content: CLAIM_DONE }])
    const report = await runAppLane({
      config: laneConfig(),
      url: APP_URL,
      trusted: true,
      task: 'Submit the form and confirm the success banner',
      expected: { text: 'Submission received' },
      deps: laneDeps(client),
    })
    expect(report.status).toBe('failed')
    expect(report.expectedMet).toBe(false)
    expect(report.stopReason).toBe('done')
    expect(report.reason).toContain('expected state')
    expect(report.steps.length).toBe(1)
  }, 60_000)

  it('sends the task to the model prompt — a directed lane, not free probe', async () => {
    const client = new StubClient([{ content: WAIT }, { content: CLAIM_DONE }])
    const report = await runAppLane({
      config: laneConfig(),
      url: APP_URL,
      trusted: true,
      task: 'Submit the form',
      expected: { text: 'never-present-marker' },
      deps: laneDeps(client),
    })
    expect(report.status).toBe('failed')
    expect(client.calls.length).toBe(2)
    expect(client.calls[0]!.text).toContain('Task: Submit the form')
    // The task path uses the directed-task system prompt, not free-explore.
    expect(client.calls[0]!.text).not.toContain('Probe the application')
    // Prior acts ride the next prompt so the model sees its own progress.
    expect(client.calls[1]!.text).toContain('Steps already taken')
  }, 60_000)

  it('blocks without a task before touching the provider', async () => {
    const client = new StubClient([])
    const report = await runAppLane({
      config: laneConfig(),
      url: APP_URL,
      trusted: true,
      task: undefined,
      expected: { text: 'x' },
      deps: laneDeps(client),
    })
    expect(report.status).toBe('blocked')
    expect(report.reason).toContain('no task')
    expect(client.calls.length).toBe(0)
  })

  it('blocks a task with no expected-state marker — load alone cannot pass', async () => {
    const client = new StubClient([])
    const report = await runAppLane({
      config: laneConfig(),
      url: APP_URL,
      trusted: true,
      task: 'do something',
      expected: undefined,
      deps: laneDeps(client),
    })
    expect(report.status).toBe('blocked')
    expect(report.reason).toContain('expected-state')
    expect(client.calls.length).toBe(0)
  })

  it('blocks on an invalid expected-state marker (bad url regex)', async () => {
    const client = new StubClient([])
    const report = await runAppLane({
      config: laneConfig(),
      url: APP_URL,
      trusted: true,
      task: 'do something',
      expected: { url: '[unterminated' },
      deps: laneDeps(client),
    })
    expect(report.status).toBe('blocked')
    expect(report.reason).toContain('invalid expected-state marker')
  })

  it('blocks with no configured target', async () => {
    const client = new StubClient([])
    const report = await runAppLane({
      config: laneConfig(),
      url: undefined,
      trusted: true,
      task: 'do something',
      expected: { text: 'x' },
      deps: laneDeps(client),
    })
    expect(report.status).toBe('blocked')
    expect(report.reason).toContain('no application target')
  })

  it('reports unreachable targets as unavailable before any model call', async () => {
    const client = new StubClient([])
    const report = await runAppLane({
      config: laneConfig(),
      url: 'http://127.0.0.1:9/nothing',
      trusted: true,
      task: 'do something',
      expected: { text: 'x' },
      deps: {
        ...laneDeps(client),
        waitForReady: async () => {
          throw new Error('connection refused')
        },
      },
    })
    expect(report.status).toBe('unavailable')
    expect(report.reason).toContain('unreachable')
    expect(client.calls.length).toBe(0)
    expect(report.visionCalls).toBe(0)
  })

  it('blocks a target.command on an untrusted checkout before booting', async () => {
    const client = new StubClient([])
    let booted = false
    const report = await runAppLane({
      config: laneConfig({
        target: { command: 'echo should-not-run', url: APP_URL, readyTimeoutMs: 1000 },
      }),
      url: APP_URL,
      trusted: false,
      task: 'do something',
      expected: { text: 'x' },
      deps: {
        ...laneDeps(client),
        startTarget: async () => {
          booted = true
          throw new Error('must not be called')
        },
      },
    })
    expect(report.status).toBe('blocked')
    expect(report.reason).toContain('trusted checkout')
    expect(booted).toBe(false)
    expect(client.calls.length).toBe(0)
  })

  it('boots a trusted target command, runs the task, and cleans up', async () => {
    const port = 6600 + Math.floor(Math.random() * 200)
    const bootUrl = `http://127.0.0.1:${port}/app.html`
    const client = new StubClient([{ content: CLICK_SUBMIT }])
    let spawned: TargetProcess | undefined
    const report = await runAppLane({
      config: laneConfig({
        target: {
          command: `${JSON.stringify(process.execPath)} ${JSON.stringify(SERVE_SCRIPT)} ${port} ${JSON.stringify(FIXTURE_DIR)}`,
          url: `http://127.0.0.1:${port}/app.html`,
          readyTimeoutMs: 10_000,
        },
      }),
      url: undefined,
      trusted: true,
      task: 'Submit the form',
      expected: { text: 'Submission received' },
      deps: {
        ...laneDeps(client),
        startTarget: async (spec) => {
          spawned = await TargetProcess.start(spec)
          return spawned
        },
      },
    })
    expect(report.status).toBe('passed')
    expect(report.finalUrl).toBe(bootUrl)
    // The lane stopped its booted process — no orphaned server.
    expect(spawned).toBeDefined()
    expect(spawned!.pid).toBeDefined()
    await expect(
      fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1_000) }).then(
        () => 'up',
        () => 'down',
      ),
    ).resolves.toBe('down')
  }, 60_000)

  it('halts on the step cap with partial evidence preserved', async () => {
    const client = new StubClient([
      { content: WAIT },
      { content: WAIT },
      { content: WAIT },
    ])
    const report = await runAppLane({
      config: laneConfig({ app: { maxSteps: 2 } }),
      url: APP_URL,
      trusted: true,
      task: 'never reachable',
      expected: { text: 'never-present-marker' },
      deps: laneDeps(client),
    })
    expect(report.status).toBe('failed')
    expect(report.stopReason).toBe('max-steps')
    expect(report.steps.length).toBe(2)
    expect(report.visionCalls).toBe(2)
  }, 60_000)

  it('halts on the USD cap with partial evidence preserved', async () => {
    const client = new StubClient([{ content: WAIT }, { content: WAIT }])
    const report = await runAppLane({
      config: laneConfig({ app: { budgetUsd: 0.0015 } }),
      url: APP_URL,
      trusted: true,
      task: 'never reachable',
      expected: { text: 'never-present-marker' },
      deps: laneDeps(client),
    })
    expect(report.status).toBe('failed')
    expect(report.stopReason).toBe('budget')
    // One call spent, second refused — the spend and the steps stay in evidence.
    expect(report.visionCalls).toBe(1)
    expect(report.visionCostUsd).toBeCloseTo(0.001)
  }, 60_000)

  it('halts on the wall-clock deadline with partial evidence preserved', async () => {
    const client = new StubClient(
      Array.from({ length: 10 }, () => ({ content: WAIT })),
    )
    const report = await runAppLane({
      config: laneConfig({ app: { timeoutMs: 1 } }),
      url: APP_URL,
      trusted: true,
      task: 'never reachable',
      expected: { text: 'never-present-marker' },
      deps: laneDeps(client),
    })
    expect(report.status).toBe('failed')
    expect(['timeout', 'stalled', 'max-steps']).toContain(report.stopReason)
    expect(report.visionCalls).toBeLessThan(10)
  }, 60_000)
})

describe('expectation predicate', () => {
  const ctx = {
    observation: {
      screenshotJpeg: Buffer.alloc(0),
      a11yYaml: 'banner "Submission received"\nbutton "Submit"',
      width: 1280,
      height: 720,
    },
    url: 'http://app.test/done',
    page: {} as never,
  }

  it('ANDs multiple markers', async () => {
    const all = buildExpectationCheck({ text: 'submission received', url: 'done$' })
    expect(await all.check(ctx)).toBe(true)
    const fail = buildExpectationCheck({ text: 'submission received', url: 'other$' })
    expect(await fail.check(ctx)).toBe(false)
  })

  it('text matching is case-insensitive', async () => {
    const check = buildExpectationCheck({ text: 'SUBMISSION RECEIVED' })
    expect(await check.check(ctx)).toBe(true)
  })

  it('an expectation with no markers never passes', async () => {
    const check = buildExpectationCheck({})
    expect(await check.check(ctx)).toBe(false)
  })
})

describe('app lane manifest merge', () => {
  it('maps app-lane.json detail into the manifest lane', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'argus-app-manifest-'))
    const reportDir = join(cwd, 'reports')
    const result = await runVerify({
      cwd,
      runId: 'run-app',
      reportDir,
      identity: {
        repo: 'o/r',
        pr: '1',
        intendedHeadSha: 'abc',
        checkoutSha: 'abc',
        baseSha: 'def',
      },
      selection: { review: false, flow: false, app: true, a0: false },
      runners: {
        review: async () => 0,
        app: async () => {
          await mkdir(reportDir, { recursive: true })
          await writeFile(
            join(reportDir, APP_LANE_REPORT),
            JSON.stringify({
              lane: 'app',
              status: 'passed',
              summary: 'expected state verified',
              model: 'test/model',
              calls: [
                { provider: 'stub', model: 'test/model', tokens: 10, costUsd: 0.002 },
              ],
              visionCalls: 1,
              visionCostUsd: 0.002,
              expectedMet: true,
              steps: [{ action: 'click', url: 'http://app/' }],
              anomalies: [],
              tasks: 0,
              durationMs: 1200,
            }),
          )
          return 0
        },
      },
      budgets: { app: { limitUsd: 0.01, maxDurationMs: 120_000 } },
    })
    expect(result.exitCode).toBe(0)
    const lane = result.manifest.lanes.app
    expect(lane.status).toBe('passed')
    expect(lane.reportPath).toBe('reports/app-lane.json')
    expect(lane.usage).toMatchObject({
      provider: 'openrouter',
      model: 'test/model',
      calls: 1,
      costUsd: 0.002,
      metered: true,
    })
    expect(lane.budget.elapsedMs).toBe(1200)
  })

  it('honors a runner detail status over the exit code', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'argus-app-detail-'))
    const reportDir = join(cwd, 'reports')
    const result = await runVerify({
      cwd,
      runId: 'run-app-blocked',
      reportDir,
      identity: {
        repo: undefined,
        pr: undefined,
        intendedHeadSha: undefined,
        checkoutSha: undefined,
        baseSha: undefined,
      },
      selection: { review: false, flow: false, app: true, a0: false },
      runners: {
        review: async () => 0,
        app: async () => {
          await mkdir(reportDir, { recursive: true })
          await writeFile(
            join(reportDir, APP_LANE_REPORT),
            JSON.stringify({
              lane: 'app',
              status: 'blocked',
              reason: 'no task configured — set app.task or pass --task',
              calls: [],
              visionCalls: 0,
              visionCostUsd: 0,
              durationMs: 3,
            }),
          )
          return 1
        },
      },
    })
    expect(result.manifest.lanes.app.status).toBe('blocked')
    expect(result.manifest.lanes.app.reason).toContain('no task')
  })

  it('keeps a stale detail file from laundering a failed runner', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'argus-app-stale-'))
    const reportDir = join(cwd, 'reports')
    const result = await runVerify({
      cwd,
      runId: 'run-app-throw',
      reportDir,
      identity: {
        repo: undefined,
        pr: undefined,
        intendedHeadSha: undefined,
        checkoutSha: undefined,
        baseSha: undefined,
      },
      selection: { review: false, flow: false, app: true, a0: false },
      runners: {
        review: async () => 0,
        app: async () => {
          await mkdir(reportDir, { recursive: true })
          await writeFile(
            join(reportDir, APP_LANE_REPORT),
            JSON.stringify({ lane: 'app', status: 'passed', calls: [] }),
          )
          throw new Error('runner blew up mid-lane')
        },
      },
    })
    // A runner exception is authoritative — the lane is failed even when a
    // detail file claims a pass.
    expect(result.manifest.lanes.app.status).toBe('failed')
    expect(result.manifest.lanes.app.reason).toContain('runner blew up')
  })
})

describe('verify --app cli surface', () => {
  it('runs the app lane end-to-end through the manifest', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'argus-verify-app-'))
    const reportDir = join(cwd, 'reports')
    await writeFile(
      join(cwd, 'argus-reviewer.config.json'),
      JSON.stringify({
        reportDir,
        app: {
          task: 'Submit the form and confirm the success banner',
          expected: { text: 'Submission received' },
        },
      }),
    )
    const client = new StubClient([{ content: CLICK_SUBMIT }])
    const { main } = await import('../../src/cli.js')
    // No OPENROUTER_API_KEY → the default review lane self-skips; the app
    // lane's passed verdict alone decides the run.
    const code = await main(['verify', '--app', '--url', APP_URL], {
      cwd,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
      out: () => undefined,
      err: () => undefined,
      createClient: () => client,
    })
    expect(code).toBe(0)
    const manifest = JSON.parse(await readFile(join(reportDir, 'run-manifest.json'), 'utf8')) as {
      lanes: { app: { status: string; usage: { calls: number } } }
    }
    expect(manifest.lanes.app.status).toBe('passed')
    expect(manifest.lanes.app.usage.calls).toBe(1)
    const detail = JSON.parse(await readFile(join(reportDir, APP_LANE_REPORT), 'utf8')) as {
      status: string
      steps: unknown[]
    }
    expect(detail.status).toBe('passed')
    expect(detail.steps.length).toBeGreaterThanOrEqual(1)
  }, 60_000)
})
