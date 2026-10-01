import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { main } from '../../src/cli.js'
import { TargetProcess } from '../../src/driver/target.js'
import { VisionClient } from '../../src/engine/loop.js'
import { CallCost, CallKind } from '../../src/vision/cost.js'
import { JsonSchema, Message } from '../../src/vision/openrouter.js'
import { ProviderRules } from '../../src/config.js'

const SERVE_SCRIPT = fileURLToPath(new URL('../fixtures/serve.mjs', import.meta.url))
const FIXTURE_DIR = fileURLToPath(new URL('../fixtures/', import.meta.url))

let FIXTURE_URL = ''
let fixtureServer: TargetProcess | undefined

beforeAll(async () => {
  const port = 5000 + Math.floor(Math.random() * 400)
  fixtureServer = await TargetProcess.start({
    command: `${JSON.stringify(process.execPath)} ${JSON.stringify(SERVE_SCRIPT)} ${port} ${JSON.stringify(FIXTURE_DIR)}`,
    url: `http://127.0.0.1:${port}/`,
    readyTimeoutMs: 10_000,
  })
  FIXTURE_URL = fixtureServer.url
})

afterAll(async () => {
  await fixtureServer?.stop()
})

class StubClient implements VisionClient {
  calls: { kind: CallKind; model: string }[] = []
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
    this.calls.push({ kind: opts.kind ?? 'ground', model: opts.model })
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

interface Captured {
  lines: string[]
  fn: (line: string) => void
}

function capture(): Captured {
  const lines: string[] = []
  return { lines, fn: (line) => lines.push(line) }
}

async function writeConfig(cwd: string, testsDir: string, cacheDir: string, reportDir: string) {
  await writeFile(
    join(cwd, 'argus-reviewer.config.json'),
    JSON.stringify({
      testsDir,
      cacheDir,
      reportDir,
      budgetUsd: 1,
    }),
  )
}

describe('argus-reviewer end-to-end smoke', () => {
  it('records a click flow and replays it, using at most one heal on an unchanged UI', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'argus-reviewer-smoke-'))
    const testsDir = join(cwd, 'tests')
    const cacheDir = join(cwd, 'cache')
    const reportDir = join(cwd, 'report')
    await mkdir(testsDir, { recursive: true })
    await mkdir(cacheDir, { recursive: true })
    await writeConfig(cwd, testsDir, cacheDir, reportDir)

    const recordOut = capture()
    const recordErr = capture()
    const recordCode = await main(
      [
        'record',
        'click the "Click me" button',
        '--url',
        FIXTURE_URL,
        '--name',
        'smoke-flow',
      ],
      {
        cwd,
        out: recordOut.fn,
        err: recordErr.fn,
        createClient: () =>
          new StubClient([
            { content: JSON.stringify({ action: 'click', x: 200, y: 130, reasoning: 'the button' }) },
            { content: JSON.stringify({ action: 'done' }) },
          ]),
        env: { ...process.env, OPENROUTER_API_KEY: 'test-key' },
      },
    )

    if (recordCode !== 0) {
      console.log('record out:', recordOut.lines.join('\n'))
      console.log('record err:', recordErr.lines.join('\n'))
    }
    expect(recordCode).toBe(0)

    const generated = await readFile(join(testsDir, 'smoke-flow.test.ts'), 'utf8')
    expect(generated).toContain('await td.find')
    const cache = JSON.parse(await readFile(join(cacheDir, 'smoke-flow.json'), 'utf8')) as {
      steps: { instruction: string; action: { action: string } }[]
    }
    expect(cache.steps.length).toBe(1)
    expect(cache.steps[0]!.action.action).toBe('click')

    const runClient = new StubClient([
      { content: JSON.stringify({ action: 'click', x: 200, y: 130, reasoning: 'the button' }) },
    ])
    const out = capture()
    const err = capture()
    const code = await main(['run', '--url', FIXTURE_URL], {
      cwd,
      out: out.fn,
      err: err.fn,
      createClient: () => runClient,
      env: { ...process.env, OPENROUTER_API_KEY: 'test-key' },
    })

    if (code !== 0) {
      console.log('run out:', out.lines.join('\n'))
      console.log('run err:', err.lines.join('\n'))
    }
    expect(code).toBe(0)
    expect(out.lines.join('\n')).toContain('PASS smoke-flow')
    expect(runClient.calls.length).toBeLessThanOrEqual(1)

    // Replay economics are explainable: run.json carries the cache outcome
    // and the provider-call count matches what the client actually spent.
    const report = JSON.parse(await readFile(join(reportDir, 'run.json'), 'utf8')) as {
      totals: { visionCalls: number; cacheHits: number; cacheHeals: number }
    }
    expect(report.totals.visionCalls).toBe(runClient.calls.length)
    expect(report.totals.cacheHits + report.totals.cacheHeals).toBeGreaterThanOrEqual(1)
  }, 60_000)

  it('fails to run when no target URL is provided', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'argus-reviewer-smoke-notarget-'))
    const testsDir = join(cwd, 'tests')
    const cacheDir = join(cwd, 'cache')
    const reportDir = join(cwd, 'report')
    await mkdir(testsDir, { recursive: true })
    await mkdir(cacheDir, { recursive: true })
    await writeConfig(cwd, testsDir, cacheDir, reportDir)

    const out = capture()
    const code = await main(['run'], {
      cwd,
      out: out.fn,
      err: out.fn,
      createClient: () => new StubClient([]),
      env: { ...process.env, OPENROUTER_API_KEY: 'test-key' },
    })

    expect(code).not.toBe(0)
    expect(out.lines.join('\n')).toContain('no target URL')
  })
})
