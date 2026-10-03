import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { main } from '../../src/cli.js'
import { STATUS_GLYPH } from '../../src/report/viewmodel.js'
import { CliError, ERROR_CODES, classifyHttpStatus } from '../../src/ui/errors.js'
import { DecisionClient } from '../../src/vision/decisions.js'
import { OpenRouterClient } from '../../src/vision/openrouter.js'

/** No OPENROUTER_API_KEY anywhere: provider calls in this file are mocked HTTP only. */
const MIN_ENV = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' }
const FAILED = STATUS_GLYPH.failed

function capture(): { lines: string[]; fn: (line: string) => void } {
  const lines: string[] = []
  return { lines, fn: (line) => lines.push(line) }
}

/** Fixture repo for `code-review --fixture` (zero GitHub calls). */
async function fixtureRepo(): Promise<{ repo: string; cwd: string }> {
  const repo = await mkdtemp(join(tmpdir(), 'argus-err-fix-'))
  const git = (args: string[]) =>
    execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args])
  git(['init', '-b', 'pr'])
  await writeFile(join(repo, 'a.ts'), 'x\n')
  git(['add', '-A'])
  git(['commit', '-m', 'base'])
  git(['branch', 'argus-fixture-base'])
  await writeFile(join(repo, 'a.ts'), 'y\n')
  git(['add', '-A'])
  git(['commit', '-m', 'head'])
  const cwd = await mkdtemp(join(tmpdir(), 'argus-err-cwd-'))
  // decisionModel '' keeps the decisions endpoint out of the picture.
  await writeFile(join(cwd, 'argus-reviewer.config.json'), JSON.stringify({ decisionModel: '' }))
  return { repo, cwd }
}

/** A real OpenRouterClient over a mocked fetch: every request gets `res`. */
function mockedClient(res: () => Response): { client: OpenRouterClient; calls: () => number } {
  let n = 0
  const fetch: typeof globalThis.fetch = async () => {
    n++
    return res()
  }
  return { client: new OpenRouterClient({ apiKey: 'test-not-a-key', fetch }), calls: () => n }
}

async function reviewWith(client: OpenRouterClient | undefined, extra: string[] = []) {
  const { repo, cwd } = await fixtureRepo()
  const out = capture()
  const err = capture()
  const code = await main(['code-review', '--fixture', repo, '--report-dir', join(cwd, 'r'), ...extra], {
    cwd,
    env: MIN_ENV,
    out: out.fn,
    err: err.fn,
    ...(client !== undefined ? { createClient: () => client } : {}),
  })
  return { code, out: out.lines, err: err.lines }
}

describe('error codes are a closed set (R14)', () => {
  it('names every documented class', () => {
    expect([...ERROR_CODES].sort()).toEqual(
      [
        'A0_UNREACHABLE',
        'COMMAND_FAILED',
        'CONFIG_INVALID',
        'INTERNAL',
        'MANIFEST_UNREADABLE',
        'OPENROUTER_KEY_MISSING',
        'OPENROUTER_KEY_REJECTED',
        'OPENROUTER_OUT_OF_CREDIT',
        'OPENROUTER_RATE_LIMITED',
        'PROVIDER_UNAVAILABLE',
        'USAGE',
      ].sort(),
    )
  })
})

describe('provider failures name their class (R15)', () => {
  it('maps HTTP status to a code; non-provider statuses stay unclassified', () => {
    expect(classifyHttpStatus(402)?.code).toBe('OPENROUTER_OUT_OF_CREDIT')
    expect(classifyHttpStatus(401)?.code).toBe('OPENROUTER_KEY_REJECTED')
    expect(classifyHttpStatus(429)?.code).toBe('OPENROUTER_RATE_LIMITED')
    expect(classifyHttpStatus(500)?.code).toBe('PROVIDER_UNAVAILABLE')
    expect(classifyHttpStatus(503)?.code).toBe('PROVIDER_UNAVAILABLE')
    expect(classifyHttpStatus(400)).toBeUndefined()
  })

  it('reads the reset from Retry-After seconds, an HTTP date, or X-RateLimit-Reset', () => {
    const now = Date.parse('2026-10-02T12:00:00Z')
    expect(classifyHttpStatus(429, new Headers({ 'retry-after': '20' }), now)?.retryAfterSeconds).toBe(20)
    expect(
      classifyHttpStatus(429, new Headers({ 'retry-after': 'Fri, 02 Oct 2026 12:01:00 GMT' }), now)
        ?.retryAfterSeconds,
    ).toBe(60)
    expect(
      classifyHttpStatus(429, new Headers({ 'x-ratelimit-reset': String(now + 5_000) }), now)?.retryAfterSeconds,
    ).toBe(5)
    expect(classifyHttpStatus(429, new Headers(), now)?.retryAfterSeconds).toBeUndefined()
  })

  it('OpenRouterClient throws the classified error when every candidate fails the same way', async () => {
    const { client } = mockedClient(() => new Response('{}', { status: 402 }))
    const err = await client
      .complete({ model: 'a/b', escalationModels: ['c/d'], messages: [] })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CliError)
    expect((err as CliError).code).toBe('OPENROUTER_OUT_OF_CREDIT')
    expect((err as CliError).message).toBe('OpenRouter reports no credit left on this key')
  })

  it('DecisionClient reuses the classification: same code on the typed DecisionError', async () => {
    const client = new DecisionClient({
      apiKey: 'test-not-a-key',
      fetch: async () => new Response('{}', { status: 402 }),
    })
    const err = await client
      .decide({ state: 's', questions: { q: { type: 'noul', instructions: 'i' } } })
      .catch((e: unknown) => e)
    expect(err).toMatchObject({ kind: 'unexpected', code: 'OPENROUTER_OUT_OF_CREDIT' })
    expect((err as Error).message).not.toContain('—')
  })
})

describe('CLI error grammar (R14)', () => {
  it('a missing key prints the failed glyph summary, the cause, and the fix on its own line', async () => {
    const r = await reviewWith(undefined)
    expect(r.code).toBe(1)
    const i = r.err.findIndex((l) => l.startsWith(`${FAILED} `))
    expect(i).toBeGreaterThanOrEqual(0)
    expect(r.err[i]).toBe(`${FAILED} code-review: OpenRouter key missing`)
    expect(r.err[i + 1]).toMatch(/^ {2}OPENROUTER_API_KEY is not set/)
    expect(r.err[i + 2]?.trim()).toMatch(/^export OPENROUTER_API_KEY=\S+$/)
  })

  it('--json prints one JSON object with a stable code and a fix field', async () => {
    const r = await reviewWith(undefined, ['--json'])
    expect(r.code).toBe(1)
    const json = r.err.filter((l) => l.startsWith('{'))
    expect(json).toHaveLength(1)
    const parsed = JSON.parse(json[0]!) as { error: { code: string; fix: string; summary: string } }
    expect(parsed.error.code).toBe('OPENROUTER_KEY_MISSING')
    expect(parsed.error.fix).toMatch(/^export OPENROUTER_API_KEY=/)
    expect(r.err.some((l) => l.startsWith(`${FAILED} `))).toBe(false)
  })

  it('a mocked 429 with Retry-After: 20 names the class and the reset', async () => {
    const { client } = mockedClient(
      () => new Response('{}', { status: 429, headers: { 'retry-after': '20' } }),
    )
    const r = await reviewWith(client)
    expect(r.code).toBe(1)
    const text = r.err.join('\n')
    expect(text).toContain(`${FAILED} code-review: OpenRouter rate limit reached`)
    expect(text).toMatch(/resets in 20s/)
    expect(text).not.toMatch(/\b429\b/)

    const j = await reviewWith(mockedClient(() => new Response('{}', { status: 429, headers: { 'retry-after': '20' } })).client, ['--json'])
    const parsed = JSON.parse(j.err.find((l) => l.startsWith('{'))!) as { error: Record<string, unknown> }
    expect(parsed.error).toMatchObject({ code: 'OPENROUTER_RATE_LIMITED', retryAfterSeconds: 20 })
  })

  it('a mocked 402 is OPENROUTER_OUT_OF_CREDIT and a mocked 503 is PROVIDER_UNAVAILABLE', async () => {
    for (const [status, code] of [
      [402, 'OPENROUTER_OUT_OF_CREDIT'],
      [503, 'PROVIDER_UNAVAILABLE'],
      [401, 'OPENROUTER_KEY_REJECTED'],
    ] as const) {
      const r = await reviewWith(mockedClient(() => new Response('{}', { status })).client, ['--json'])
      expect(r.code, String(status)).toBe(1)
      const parsed = JSON.parse(r.err.find((l) => l.startsWith('{'))!) as { error: { code: string; fix: string } }
      expect(parsed.error.code, String(status)).toBe(code)
      expect(parsed.error.fix.length).toBeGreaterThan(0)
    }
  })

  it('an unexpected exception is INTERNAL with an issue link; the stack only under --debug', async () => {
    let thrown = 0
    const boom = (): void => {
      thrown++
      throw new TypeError('boom')
    }
    const err = capture()
    expect(await main(['--help'], { env: MIN_ENV, out: boom, err: err.fn })).toBe(1)
    expect(thrown).toBe(1)
    const text = err.lines.join('\n')
    expect(text).toContain(`${FAILED} unexpected error`)
    expect(text).toContain('github.com/duketopceo/Argus/issues')
    expect(text).not.toMatch(/\n\s+at /)

    const dbg = capture()
    expect(await main(['--help', '--debug'], { env: MIN_ENV, out: boom, err: dbg.fn })).toBe(1)
    expect(dbg.lines.join('\n')).toMatch(/\n\s+at /)
  })

  it('an invalid config is CONFIG_INVALID, not a crash', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'argus-err-cfg-'))
    await writeFile(join(cwd, 'argus-reviewer.config.json'), '{not json')
    const err = capture()
    const code = await main(['cache', 'list', '--json'], { cwd, env: MIN_ENV, out: capture().fn, err: err.fn })
    expect(code).toBe(1)
    const parsed = JSON.parse(err.lines.find((l) => l.startsWith('{'))!) as { error: { code: string } }
    expect(parsed.error.code).toBe('CONFIG_INVALID')
  })
})

describe('numeric exit codes are unchanged (public CI contract)', () => {
  it('usage errors keep 2; an unknown option keeps 1; verdict failure keeps 1', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'argus-err-exit-'))
    const deps = () => ({ cwd, env: MIN_ENV, out: capture().fn, err: capture().fn })
    expect(await main(['bogus'], deps())).toBe(2)
    expect(await main(['cache', 'prune'], deps())).toBe(2)
    expect(await main(['delegate'], deps())).toBe(2)
    expect(await main(['record', 'x', '--url', 'http://127.0.0.1:9/', '--max-steps=0'], deps())).toBe(2)
    // parseArgs rejections used to escape main() and exit 1 at the bin wrapper.
    expect(await main(['run', '--bogus'], deps())).toBe(1)
    expect(await main(['verify', '--no-review'], deps())).toBe(1)
  })

  it('a usage error renders the grammar with a help command as the fix', async () => {
    const err = capture()
    expect(await main(['bogus'], { env: MIN_ENV, out: capture().fn, err: err.fn })).toBe(2)
    expect(err.lines[0]).toBe(`${FAILED} unknown command: bogus`)
    expect(err.lines.at(-1)?.trim()).toBe('argus-reviewer --help')
  })
})
