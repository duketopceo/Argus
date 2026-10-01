import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ExecFn } from '../../src/detect.js'
import {
  A0_LANE_REPORT,
  A0_LIVE_LABEL,
  a0TaskPrompt,
  buildA0Args,
  buildA0ChildEnv,
  buildA0LanePrompt,
  runA0Lane,
  runA0Task,
} from '../../src/executor/a0.js'
import { runVerify } from '../../src/pipeline/verify.js'

const REACHABLE = async () => true
const NO_HOST = async () => ({ host: undefined, source: undefined })
const CLI_PRESENT = async () => 'a0 1.0.0'
const CLI_MISSING = async () => undefined

const OK_EXEC: ExecFn = async () => ({
  code: 0,
  stdout: 'delegation finished',
  stderr: '',
  timedOut: false,
})

function laneInput(overrides: Partial<Parameters<typeof runA0Lane>[0]> = {}) {
  return {
    a0: { url: 'https://a0.example.test', maxTasks: undefined, timeoutMs: undefined },
    env: {} as Record<string, string | undefined>,
    targetUrl: 'https://app.example.test/',
    intendedHeadSha: 'abc123',
    task: 'Reproduce the flaky checkout failure',
    deps: {
      exec: OK_EXEC,
      probe: REACHABLE,
      resolveHost: NO_HOST,
      cliVersion: CLI_PRESENT,
    },
    ...overrides,
  }
}

describe('runA0Lane preflight', () => {
  it('is blocked when no task is delegated — before any host work', async () => {
    const report = await runA0Lane(laneInput({ task: undefined }))
    expect(report.status).toBe('blocked')
    expect(report.reason).toContain('no delegated task')
    expect(report.tasks).toBe(0)
    expect(report.metered).toBe(false)
  })

  it('is unavailable when neither CLI nor host resolves', async () => {
    const report = await runA0Lane(
      laneInput({
        a0: undefined,
        deps: {
          probe: REACHABLE,
          resolveHost: NO_HOST,
          cliVersion: CLI_MISSING,
        },
      }),
    )
    expect(report.status).toBe('unavailable')
    expect(report.reason).toContain('no Agent Zero found')
    expect(report.tasks).toBe(0)
  })

  it('is unavailable when the CLI exists but no host resolves', async () => {
    const report = await runA0Lane(
      laneInput({
        a0: undefined,
        deps: {
          probe: REACHABLE,
          resolveHost: NO_HOST,
          cliVersion: CLI_PRESENT,
        },
      }),
    )
    expect(report.status).toBe('unavailable')
    expect(report.reason).toContain('no host resolved')
  })

  it('is unavailable when the configured host does not answer as Agent Zero', async () => {
    const report = await runA0Lane(
      laneInput({ deps: { probe: async () => false, resolveHost: NO_HOST, cliVersion: CLI_PRESENT } }),
    )
    expect(report.status).toBe('unavailable')
    expect(report.reason).toContain('did not answer as Agent Zero')
    expect(report.host).toBe('https://a0.example.test')
    expect(report.hostSource).toBe('config')
  })

  it('blocks a remote host asked to reach a loopback target', async () => {
    const report = await runA0Lane(
      laneInput({ targetUrl: 'http://localhost:9999/app' }),
    )
    expect(report.status).toBe('blocked')
    expect(report.reason).toContain('is remote')
    expect(report.reason).toContain('cannot reach')
    expect(report.targetReachable).toBe('refused')
    expect(report.tasks).toBe(0)
  })
})

describe('runA0Lane delegation', () => {
  it('delegates through a reachable host and reports unverified-live', async () => {
    let sawArgs: string[] = []
    let sawBaseEnv: Record<string, string> | undefined
    let sawTimeout: number | undefined
    const exec: ExecFn = async (_bin, args, timeoutMs, _env, opts) => {
      sawArgs = args
      sawTimeout = timeoutMs
      sawBaseEnv = opts?.baseEnv
      return { code: 0, stdout: 'all good', stderr: '', timedOut: false }
    }
    const report = await runA0Lane(
      laneInput({
        a0: { url: 'https://a0.example.test', maxTasks: 5, timeoutMs: 30_000 },
        env: {
          PATH: '/usr/bin',
          HOME: '/home/x',
          AGENT_ZERO_HOST: 'https://a0.example.test',
          OPENROUTER_API_KEY: 'sk-or-secret',
          GITHUB_TOKEN: 'ghp_secret',
          ARGUS_MODEL: 'x/y',
          npm_config__authToken: 'tok',
        },
        deps: { exec, probe: REACHABLE, resolveHost: NO_HOST, cliVersion: CLI_PRESENT },
      }),
    )
    expect(report.status).toBe('inconclusive')
    expect(report.summary).toContain(A0_LIVE_LABEL)
    expect(report.tasks).toBe(1)
    expect(report.host).toBe('https://a0.example.test')
    expect(report.targetReachable).toBe('assumed')
    expect(report.output).toBe('all good')
    expect(report.metered).toBe(false)
    // The prompt travels as `-p <prompt>`; host bound via --host.
    expect(sawArgs.at(-2)).toBe('-p')
    const prompt = sawArgs.at(-1) ?? ''
    expect(prompt).toContain('Reproduce the flaky checkout failure')
    expect(prompt).toContain('https://app.example.test/')
    expect(prompt).toContain('abc123')
    expect(prompt).not.toContain('sk-or-secret')
    expect(sawTimeout).toBe(30_000)
    // Child env is the allowlist — no secrets, no ARGUS_*, no npm_*.
    expect(sawBaseEnv?.PATH).toBe('/usr/bin')
    expect(sawBaseEnv?.HOME).toBe('/home/x')
    expect(sawBaseEnv?.AGENT_ZERO_HOST).toBe('https://a0.example.test')
    expect(sawBaseEnv?.OPENROUTER_API_KEY).toBeUndefined()
    expect(sawBaseEnv?.GITHUB_TOKEN).toBeUndefined()
    expect(sawBaseEnv?.ARGUS_MODEL).toBeUndefined()
    expect(sawBaseEnv?.npm_config__authToken).toBeUndefined()
  })

  it('is inconclusive when the delegation times out — partial output preserved', async () => {
    const exec: ExecFn = async () => ({
      code: -1,
      stdout: 'partial work before kill',
      stderr: 'killed on timeout',
      timedOut: true,
    })
    const report = await runA0Lane(
      laneInput({ deps: { exec, probe: REACHABLE, resolveHost: NO_HOST, cliVersion: CLI_PRESENT } }),
    )
    expect(report.status).toBe('inconclusive')
    expect(report.reason).toContain('timed out')
    expect(report.output).toContain('partial work')
    expect(report.tasks).toBe(1)
  })

  it('is inconclusive when the host reports failure — never a pass', async () => {
    const exec: ExecFn = async () => ({
      code: 2,
      stdout: '',
      stderr: 'agent exploded',
      timedOut: false,
    })
    const report = await runA0Lane(
      laneInput({ deps: { exec, probe: REACHABLE, resolveHost: NO_HOST, cliVersion: CLI_PRESENT } }),
    )
    expect(report.status).toBe('inconclusive')
    expect(report.reason).toContain('agent exploded')
    expect(report.tasks).toBe(1)
  })

  it('is unavailable when the delegation cannot spawn after preflight', async () => {
    const exec: ExecFn = async () => ({
      code: 1,
      stdout: '',
      stderr: 'spawn a0 ENOENT',
      timedOut: false,
    })
    const report = await runA0Lane(
      laneInput({ deps: { exec, probe: REACHABLE, resolveHost: NO_HOST, cliVersion: CLI_PRESENT } }),
    )
    expect(report.status).toBe('unavailable')
    expect(report.reason).toContain('could not start')
    expect(report.tasks).toBe(0)
  })

  it('resolves the host from env when config omits it', async () => {
    const exec: ExecFn = async () => ({
      code: 0,
      stdout: 'ok',
      stderr: '',
      timedOut: false,
    })
    const report = await runA0Lane(
      laneInput({
        a0: undefined,
        deps: {
          exec,
          probe: REACHABLE,
          resolveHost: async () => ({ host: 'http://a0.local:5080', source: 'env' }),
          cliVersion: CLI_PRESENT,
        },
      }),
    )
    expect(report.host).toBe('http://a0.local:5080')
    expect(report.hostSource).toBe('env')
    expect(report.status).toBe('inconclusive')
  })
})

describe('buildA0ChildEnv', () => {
  it('passes only the allowlisted keys', () => {
    const child = buildA0ChildEnv({
      HOME: '/home/x',
      PATH: '/usr/bin',
      USER: 'u',
      TERM: 'xterm',
      OPENROUTER_API_KEY: 'sk-or-secret',
      GITHUB_TOKEN: 'ghp_x',
      GH_TOKEN: 'ghp_y',
      ARGUS_MODEL: 'a/b',
      ARGUS_CONFIG_PATH: '/tmp/c',
      npm_config_registry: 'https://npm.internal',
      npm_config__authToken: 'tok',
      HTTP_PROXY: 'http://proxy',
      RANDOM_OTHER: 'nope',
    })
    expect(child).toEqual({
      HOME: '/home/x',
      PATH: '/usr/bin',
      USER: 'u',
      TERM: 'xterm',
    })
  })
})

describe('buildA0LanePrompt', () => {
  it('carries the typed payload — target, head, failure, evidence — and no secrets', () => {
    const prompt = buildA0LanePrompt({
      task: 'verify the checkout flow',
      targetUrl: 'http://app.test',
      intendedHeadSha: 'abc123',
      failureSummary: 'timeout at step 4',
      evidenceRefs: ['reports/run-1/app-lane.json'],
    })
    expect(prompt).toContain('verify the checkout flow')
    expect(prompt).toContain('http://app.test')
    expect(prompt).toContain('abc123')
    expect(prompt).toContain('timeout at step 4')
    expect(prompt).toContain('reports/run-1/app-lane.json')
    expect(prompt).toContain('Do not attempt to access provider keys')
  })
})

describe('a0TaskPrompt / buildA0Args', () => {
  it('binds the task to a URL when one is known', () => {
    expect(a0TaskPrompt('click checkout', 'http://app.test')).toContain('Open http://app.test')
    expect(a0TaskPrompt('click checkout', undefined)).toBe('click checkout')
  })

  it('passes the prompt via -p and the host via --host', () => {
    const args = buildA0Args('do the thing', 'https://a0.test')
    expect(args.slice(0, 4)).toEqual(['headless', '--new-chat', '--output', 'text'])
    expect(args.at(-2)).toBe('-p')
    expect(args.at(-1)).toBe('do the thing')
    expect(args).toContain('--host')
    expect(args).toContain('https://a0.test')
    expect(buildA0Args('t', undefined)).not.toContain('--host')
  })
})

describe('runA0Task env contract', () => {
  it('hands the sanitized env as the complete base — no ambient inheritance', async () => {
    let sawOpts: { baseEnv?: Record<string, string> } | undefined
    let sawEnv: Record<string, string> | undefined
    const exec: ExecFn = async (_bin, _args, _timeout, env, opts) => {
      sawEnv = env
      sawOpts = opts
      return { code: 0, stdout: 'done', stderr: '', timedOut: false }
    }
    const res = await runA0Task('task prompt', {
      host: 'https://a0.test',
      timeoutMs: 1_000,
      exec,
      env: { PATH: '/usr/bin', HOME: '/home/x' },
    })
    expect(res.ok).toBe(true)
    expect(res.timedOut).toBe(false)
    expect(res.spawnError).toBe(false)
    expect(sawEnv).toBeUndefined()
    expect(sawOpts?.baseEnv).toEqual({ PATH: '/usr/bin', HOME: '/home/x' })
  })

  it('sanitizes the ambient env by default — secrets never reach the child', async () => {
    let sawOpts: { baseEnv?: Record<string, string> } | undefined
    const exec: ExecFn = async (_bin, _args, _timeout, _env, opts) => {
      sawOpts = opts
      return { code: 0, stdout: '', stderr: '', timedOut: false }
    }
    const saved = { ...process.env }
    process.env.A0_TEST_SECRET = 'sk-test-secret'
    try {
      await runA0Task('task prompt', { exec })
    } finally {
      process.env.A0_TEST_SECRET = saved.A0_TEST_SECRET
    }
    // The default child env is buildA0ChildEnv(process.env) — allowlisted
    // keys only, so ambient secrets are never inherited.
    expect(sawOpts?.baseEnv).toBeDefined()
    expect(sawOpts?.baseEnv?.A0_TEST_SECRET).toBeUndefined()
    expect(Object.keys(sawOpts?.baseEnv ?? {})).toEqual(
      expect.arrayContaining(['PATH']),
    )
    expect(sawOpts?.baseEnv?.OPENROUTER_API_KEY).toBeUndefined()
    expect(sawOpts?.baseEnv?.GITHUB_TOKEN).toBeUndefined()
  })

  it('degrades a spawn rejection to a failed delegation, not a throw', async () => {
    const exec: ExecFn = async () => {
      throw new Error('spawn a0 ENOENT')
    }
    const res = await runA0Task('task prompt', { exec })
    expect(res.ok).toBe(false)
    expect(res.spawnError).toBe(true)
    expect(res.output).toContain('ENOENT')
  })
})

describe('a0 lane manifest merge', () => {
  it('maps a0-lane.json detail into the manifest lane as unmetered', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'argus-a0-manifest-'))
    const reportDir = join(cwd, 'reports')
    const result = await runVerify({
      cwd,
      runId: 'run-a0',
      reportDir,
      identity: {
        repo: 'o/r',
        pr: '1',
        intendedHeadSha: 'abc',
        checkoutSha: 'abc',
        baseSha: 'def',
      },
      selection: { review: false, flow: false, app: false, a0: true },
      runners: {
        review: async () => 0,
        a0: async () => {
          await mkdir(reportDir, { recursive: true })
          await writeFile(
            join(reportDir, A0_LANE_REPORT),
            JSON.stringify({
              lane: 'a0',
              status: 'inconclusive',
              summary: `delegation returned — ${A0_LIVE_LABEL}`,
              tasks: 1,
              host: 'https://a0.example.test',
              durationMs: 42_000,
              metered: false,
            }),
          )
          return 0
        },
      },
      budgets: { a0: { limitUsd: 1, maxDurationMs: 600_000 } },
    })
    const lane = result.manifest.lanes.a0
    expect(lane.status).toBe('inconclusive')
    expect(lane.reportPath).toBe('reports/a0-lane.json')
    expect(lane.summary).toContain(A0_LIVE_LABEL)
    expect(lane.usage).toMatchObject({
      provider: 'a0',
      calls: 0,
      costUsd: 0,
      metered: false,
    })
    expect(lane.budget.elapsedMs).toBe(42_000)
    expect(lane.budget.tasks).toBe(1)
    // An inconclusive lane can never green the run.
    expect(result.manifest.aggregate.ok).toBe(false)
    expect(result.manifest.aggregate.status).toBe('inconclusive')
    expect(result.exitCode).toBe(1)
  })

  it('records blocked preflight faithfully instead of an exit-code failure', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'argus-a0-blocked-'))
    const reportDir = join(cwd, 'reports')
    const result = await runVerify({
      cwd,
      runId: 'run-a0-blocked',
      reportDir,
      identity: {
        repo: undefined,
        pr: undefined,
        intendedHeadSha: undefined,
        checkoutSha: undefined,
        baseSha: undefined,
      },
      selection: { review: false, flow: false, app: false, a0: true },
      runners: {
        review: async () => 0,
        a0: async () => {
          await mkdir(reportDir, { recursive: true })
          await writeFile(
            join(reportDir, A0_LANE_REPORT),
            JSON.stringify({
              lane: 'a0',
              status: 'unavailable',
              reason: 'a0 host did not answer as Agent Zero: https://a0.example.test',
              tasks: 0,
              metered: false,
              durationMs: 8,
            }),
          )
          return 1
        },
      },
    })
    const lane = result.manifest.lanes.a0
    expect(lane.status).toBe('unavailable')
    expect(lane.reason).toContain('did not answer')
    expect(result.manifest.aggregate.status).toBe('inconclusive')
  })
})
