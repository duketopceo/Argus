import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { main } from '../../src/cli.js'
import { resolveConfig } from '../../src/config.js'
import { ACTION_PIN_SHA, ACTION_PIN_TAG, renderScaffold, scaffoldChecklist } from '../../src/onboarding/scaffold.js'

const GOLDEN = join(import.meta.dirname, '../fixtures/onboarding')
const UPDATE = process.env.GOLDEN_UPDATE === '1'
const PATHS = [
  'argus-reviewer.config.ts',
  'tests/argus/smoke.test.ts',
  '.github/workflows/argus-reviewer.yml',
  '.github/workflows/argus-mention.yml',
]

async function runInit(a0Host?: string): Promise<{ files: Record<string, string>; stdout: string }> {
  const cwd = await mkdtemp(join(tmpdir(), 'argus-golden-'))
  const lines: string[] = []
  const code = await main(['init'], {
    cwd,
    out: (l) => lines.push(l),
    err: () => {},
    isTTY: false,
    env: {
      PATH: '/nonexistent',
      HOME: '/nonexistent',
      ...(a0Host !== undefined ? { AGENT_ZERO_HOST: a0Host } : {}),
    },
    exec: async (cmd) =>
      cmd === 'a0' && a0Host !== undefined
        ? { code: 0, stdout: '2.12\n', stderr: '' }
        : { code: 1, stdout: '', stderr: 'unauthenticated' },
    probe: async () => false,
  })
  expect(code).toBe(0)
  const files: Record<string, string> = {}
  for (const p of PATHS) files[p] = await readFile(join(cwd, p), 'utf8')
  // Browser detection depends on the host's Playwright install; pin that row.
  const stdout = lines
    .join('\n')
    .replace(/^ +[^ ]+ +playwright +.*\n( +npx playwright install chromium\n)?/m, '  <glyph> playwright      <host-dependent>\n')
  return { files, stdout: stdout + '\n' }
}

async function golden(name: string, got: { files: Record<string, string>; stdout: string }) {
  const dir = join(GOLDEN, name)
  const targets: [string, string][] = [
    ['stdout.txt', got.stdout],
    ...Object.entries(got.files).map(([p, c]): [string, string] => [p, c]),
  ]
  for (const [rel, content] of targets) {
    const file = join(dir, rel === 'stdout.txt' ? rel : `${rel}.golden`)
    if (UPDATE) {
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, content, 'utf8')
    }
    expect(content, rel).toBe(await readFile(file, 'utf8'))
  }
}

describe('init golden output (pre-refactor capture)', () => {
  it('matches without an Agent Zero host', async () => {
    await golden('init-default', await runInit())
  })
  it('matches with an Agent Zero host', async () => {
    await golden('init-a0', await runInit('https://a0.example.com'))
  })
})

describe('renderScaffold', () => {
  const render = () => renderScaffold({ a0Host: undefined, includeConfig: true })

  it('returns the four files in init order', () => {
    const files = render()
    expect(files.map((f) => f.path)).toEqual([
      'argus-reviewer.config.ts',
      'tests/argus/smoke.test.ts',
      '.github/workflows/argus-reviewer.yml',
      '.github/workflows/argus-mention.yml',
    ])
  })

  it('omits the config when includeConfig is false', () => {
    const rest = renderScaffold({ a0Host: undefined, includeConfig: false })
    expect(rest.map((f) => f.path)).not.toContain('argus-reviewer.config.ts')
    expect(rest).toHaveLength(3)
  })

  it('is pure: same input, same output', () => {
    expect(renderScaffold({ a0Host: 'https://x.test', includeConfig: true })).toEqual(
      renderScaffold({ a0Host: 'https://x.test', includeConfig: true }),
    )
  })

  it('workflows keep the trust-lane invariants', () => {
    const byPath = new Map(render().map((f) => [f.path, f.content]))
    for (const p of ['.github/workflows/argus-reviewer.yml', '.github/workflows/argus-mention.yml']) {
      const w = byPath.get(p) as string
      expect(w).toContain('persist-credentials: false')
      expect(w).toMatch(/duketopceo\/Argus\/action@[0-9a-f]{40} # v/)
      expect(w).toMatch(/actions\/checkout@[0-9a-f]{40}/)
      expect(w).toContain('permissions:')
      expect(w).not.toContain('pull_request_target')
    }
    const review = byPath.get('.github/workflows/argus-reviewer.yml') as string
    expect(review).toContain('contents: read')
    expect(review).not.toContain('contents: write')
    expect(review).toContain('pull_request:')
  })

  it('templates name no stale model slugs', () => {
    const files = render()
    const all = files.map((f) => f.content).join('\n')
    expect(all).not.toMatch(/(claude|gpt|gemini|deepseek|qwen)[-/]/i)
  })
})

describe('scaffoldChecklist', () => {
  it('derives budget from current defaults and names the secret, data flow and stop path', () => {
    const lines = scaffoldChecklist(resolveConfig({}).budgetUsd ?? 1).join('\n')
    expect(lines).toContain('sent to provider')
    expect(lines).toContain('default budget    $1/run cap')
    expect(lines).toContain('how to stop')
    expect(lines).toContain('OPENROUTER_API_KEY')
    expect(scaffoldChecklist(5).join('\n')).toContain('$5/run cap')
  })
})

describe('action pin', () => {
  it('is a released tag SHA that skips the unparseable v0.4.0 and v0.4.1', () => {
    expect(ACTION_PIN_SHA).toMatch(/^[0-9a-f]{40}$/)
    expect(ACTION_PIN_TAG).toMatch(/^v\d+\.\d+\.\d+$/)
    expect(['v0.4.0', 'v0.4.1']).not.toContain(ACTION_PIN_TAG)
    expect(ACTION_PIN_SHA).not.toBe('63c9575622afef8bf4a8f2ea2d2909c6e54505d3')
  })

  it('appears in every generated workflow from the one constant', () => {
    const pin = `duketopceo/Argus/action@${ACTION_PIN_SHA} # ${ACTION_PIN_TAG}`
    const workflows = renderScaffold({ a0Host: undefined, includeConfig: true }).filter((f) =>
      f.path.startsWith('.github/workflows/'),
    )
    expect(workflows.length).toBeGreaterThan(0)
    for (const w of workflows) expect(w.content).toContain(pin)
  })

  it("pinned action.yml has no unquoted plain scalar containing ': ' (offline, skipped without the object)", (ctx) => {
    let yml: string
    try {
      yml = execFileSync('git', ['show', `${ACTION_PIN_SHA}:action/action.yml`], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        cwd: import.meta.dirname,
      })
    } catch {
      return ctx.skip()
    }
    const bad = yml.split('\n').filter((line) => {
      const m = /^\s*[A-Za-z0-9_-]+:\s+(.*)$/.exec(line)
      if (!m) return false
      const v = (m[1] as string).trim()
      return !/^["'|>[{&*!#]/.test(v) && v.includes(': ')
    })
    expect(bad).toEqual([])
  })
})
