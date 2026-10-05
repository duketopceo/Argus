import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveConfig, type Config, type Target } from '../../src/config.js'
import { inspectInstructions } from '../../src/driver/browser.js'
import { TargetProcess, holdTargetForDebug } from '../../src/driver/target.js'
import type { VisionClient } from '../../src/engine/loop.js'
import { runAppLane } from '../../src/pipeline/app.js'
import type { CallCost, CallKind } from '../../src/vision/cost.js'
import type { JsonSchema, Message } from '../../src/vision/openrouter.js'
import type { ProviderRules } from '../../src/config.js'

const SERVE_SCRIPT = fileURLToPath(new URL('../fixtures/serve.mjs', import.meta.url))
const FIXTURE_DIR = fileURLToPath(new URL('../fixtures/', import.meta.url))

/** Externally-served fixture for the CLI-surface test (target not lane-booted). */
let fixtureServer: TargetProcess | undefined
let SERVE_URL = ''

// Sequential ports from a band no other test file draws from — random draws
// collide once multiple servers in the file (or a parallel worker's server)
// are alive at the same time.
let nextPort = 7000 + Math.floor(Math.random() * 200)

beforeAll(async () => {
  const port = nextPort++
  fixtureServer = await TargetProcess.start({
    command: `${JSON.stringify(process.execPath)} ${JSON.stringify(SERVE_SCRIPT)} ${port} ${JSON.stringify(FIXTURE_DIR)}`,
    url: `http://127.0.0.1:${port}/`,
    readyTimeoutMs: 10_000,
  })
  SERVE_URL = fixtureServer.url
})

afterAll(async () => {
  await fixtureServer?.stop()
})

function capture(): { lines: string[]; fn: (line: string) => void } {
  const lines: string[] = []
  return { lines, fn: (line) => lines.push(line) }
}

function serveTarget(): Target {
  const port = nextPort++
  return {
    command: `${JSON.stringify(process.execPath)} ${JSON.stringify(SERVE_SCRIPT)} ${port} ${JSON.stringify(FIXTURE_DIR)}`,
    url: `http://127.0.0.1:${port}/`,
    readyTimeoutMs: 10_000,
  }
}

async function urlAnswers(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2_000) })
    return res.status >= 200 && res.status < 400
  } catch {
    return false
  }
}

describe('holdTargetForDebug', () => {
  it('prints the connect story and returns when the TTL lapses', async () => {
    const notes = capture()
    await holdTargetForDebug('http://127.0.0.1:1/', 25, notes.fn)
    const text = notes.lines.join('\n')
    expect(text).toContain('keep-alive: http://127.0.0.1:1/ stays up')
    expect(text).toContain("npx playwright open 'http://127.0.0.1:1/'")
    expect(text).toContain('window ended')
  })

  it('the served target still answers during the hold and teardown stops it after', async () => {
    const target = await TargetProcess.start(serveTarget())
    try {
      const held = holdTargetForDebug(target.url, 400, () => undefined)
      // Mid-hold: the server argus booted is still serving.
      expect(await urlAnswers(target.url)).toBe(true)
      await held
    } finally {
      await target.stop()
    }
    expect(await urlAnswers(target.url)).toBe(false)
  })

  it('ends the hold early on SIGINT without leaking the signal handlers', async () => {
    const baseline = process.listenerCount('SIGINT')
    let fires = 0
    const sleep = async (): Promise<void> => {
      fires++
      if (fires === 1) process.emit('SIGINT')
    }
    const started = Date.now()
    await holdTargetForDebug('http://127.0.0.1:1/', 60_000, () => undefined, { sleep })
    // SIGINT on the first sleep means the hold ended far before the 60s TTL.
    expect(Date.now() - started).toBeLessThan(30_000)
    expect(fires).toBeGreaterThanOrEqual(1)
    expect(process.listenerCount('SIGINT')).toBe(baseline)
  })
})

describe('inspectInstructions', () => {
  it('prints the headed-relaunch story and a plain-browser fallback', () => {
    const lines = inspectInstructions('http://localhost:3000/path?a=b')
    expect(lines[0]).toContain("npx playwright open 'http://localhost:3000/path?a=b'")
    expect(lines[1]).toContain('open http://localhost:3000/path?a=b in any browser')
  })

  it('shell-quotes a URL containing a single quote', () => {
    const lines = inspectInstructions("http://x/?q='")
    expect(lines[0]).toContain(`'http://x/?q='\\''`)
  })
})

class StubClient implements VisionClient {
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
    const cost: CallCost = {
      model: opts.model,
      provider: 'stub',
      tokens: 10,
      costUsd: 0.001,
      kind: opts.kind ?? 'ground',
    }
    return { id: `stub-${Math.random()}`, content: next.content, model: opts.model, cost }
  }
}

const CLAIM_DONE = JSON.stringify({ action: 'done', reasoning: 'looks finished' })
const CLICK_SUBMIT = JSON.stringify({ action: 'click', x: 200, y: 120, reasoning: 'submit' })

function laneConfig(target: Target): Config {
  return resolveConfig({ budgetUsd: 1, target })
}

describe('runAppLane --keep-alive', () => {
  it('holds the booted target on a failed task, then teardown stops it', async () => {
    const spec = serveTarget()
    const notes = capture()
    let sleepCalls = 0
    let aliveDuringHold: boolean | undefined
    const report = await runAppLane({
      config: laneConfig(spec),
      url: `${spec.url}app.html`,
      trusted: true,
      task: 'Submit the form',
      expected: { text: 'Submission received' },
      keepAlive: { ttlMs: 40 },
      deps: {
        // Real browser + real lane-booted server; the claim-done reply
        // fails the expected-marker check so the lane ends 'failed'.
        createClient: () => new StubClient([{ content: CLAIM_DONE }]),
        startTarget: (s) => TargetProcess.start(s),
        note: notes.fn,
        sleep: async (ms) => {
          sleepCalls++
          if (aliveDuringHold === undefined) {
            aliveDuringHold = await urlAnswers(spec.url)
          }
          await new Promise((r) => setTimeout(r, Math.min(ms, 10)))
        },
      },
    })
    expect(report.status).toBe('failed')
    expect(sleepCalls).toBeGreaterThanOrEqual(1)
    expect(aliveDuringHold).toBe(true)
    const text = notes.lines.join('\n')
    // The hold prints the page URL the lane navigated to (base + app.html).
    expect(text).toContain(`keep-alive: ${spec.url}app.html stays up`)
    expect(text).toContain('npx playwright open')
    // After the lane returns, the finally has torn the target down.
    expect(await urlAnswers(spec.url)).toBe(false)
  }, 60_000)

  it('does not hold on a passing lane', async () => {
    const spec = serveTarget()
    const notes = capture()
    let sleepCalls = 0
    const report = await runAppLane({
      config: laneConfig(spec),
      url: `${spec.url}app.html`,
      trusted: true,
      task: 'Submit the form',
      expected: { text: 'Submission received' },
      keepAlive: { ttlMs: 40 },
      deps: {
        createClient: () => new StubClient([{ content: CLICK_SUBMIT }]),
        note: notes.fn,
        sleep: async () => {
          sleepCalls++
        },
      },
    })
    expect(report.status).toBe('passed')
    expect(sleepCalls).toBe(0)
    expect(notes.lines.join('\n')).not.toContain('keep-alive')
  }, 60_000)
})

describe('run --keep-alive cli surface', () => {
  it('holds an argus-booted target after a failed flow, then tears down', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'argus-ka-run-'))
    const testsDir = join(cwd, 'tests')
    await mkdir(testsDir, { recursive: true })
    const spec = serveTarget()
    await writeFile(
      join(cwd, 'argus-reviewer.config.json'),
      JSON.stringify({
        testsDir,
        reportDir: join(cwd, 'report'),
        budgetUsd: 1,
        target: { command: spec.command, url: spec.url },
      }),
    )
    await writeFile(
      join(testsDir, 'failing.test.ts'),
      `test('fails the marker', async (td) => {
  const ok = await td.assert('an element that does not exist is visible')
  if (ok.verdict !== 'pass') throw new Error(ok.reasoning)
})
`,
    )
    const { main } = await import('../../src/cli.js')
    const out = capture()
    let sleepCalls = 0
    let aliveDuringHold: boolean | undefined
    const code = await main(['run', '--keep-alive', '--keep-alive-ttl', '1'], {
      cwd,
      isTTY: true,
      // Explicit env without CI/GITHUB_ACTIONS: the interactive gate must
      // engage even when the suite itself runs under CI.
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        OPENROUTER_API_KEY: 'test-key',
      },
      out: out.fn,
      err: () => undefined,
      createClient: () =>
        new StubClient([
          { content: JSON.stringify({ verdict: 'fail', reasoning: 'not on screen' }) },
        ]),
      sleep: async (ms) => {
        sleepCalls++
        if (aliveDuringHold === undefined) {
          aliveDuringHold = await urlAnswers(spec.url)
        }
        await new Promise((r) => setTimeout(r, Math.min(ms, 10)))
      },
    })
    expect(code).toBe(1)
    // The argus-booted server stayed reachable through the hold window and
    // the finally tore it down after the TTL.
    expect(sleepCalls).toBeGreaterThanOrEqual(1)
    expect(aliveDuringHold).toBe(true)
    expect(out.lines.join('\n')).toContain('keep-alive:')
    expect(await urlAnswers(spec.url)).toBe(false)
  }, 60_000)
})

describe('verify --keep-alive cli surface', () => {
  it('prints the skip line for a failed app lane under CI', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'argus-keepalive-ci-'))
    const reportDir = join(cwd, 'reports')
    await writeFile(
      join(cwd, 'argus-reviewer.config.json'),
      JSON.stringify({
        reportDir,
        app: { task: 'smoke the checkout', expected: { text: 'never present' } },
      }),
    )
    const { main } = await import('../../src/cli.js')
    const out = capture()
    let sleepCalls = 0
    const code = await main(
      ['verify', '--no-review', '--app', '--url', `${SERVE_URL}app.html`, '--keep-alive'],
      {
        cwd,
        // isTTY true but CI set: the interactive gate must still skip.
        isTTY: true,
        env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', CI: 'true' },
        out: out.fn,
        err: () => undefined,
        createClient: () => new StubClient([{ content: CLAIM_DONE }]),
        sleep: async () => {
          sleepCalls++
        },
      },
    )
    expect(code).toBe(1)
    expect(out.lines.join('\n')).toContain('keep-alive: skipped (non-interactive or CI run)')
    expect(sleepCalls).toBe(0)
  }, 60_000)
})
