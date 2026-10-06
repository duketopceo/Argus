import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { main } from '../../src/cli.js'
import type { CliDeps } from '../../src/cli.js'
import type { ScanReport } from '../../src/report/scan.js'
import type { VisionClient } from '../../src/engine/loop.js'
import type { CallCost, CallKind } from '../../src/vision/cost.js'
import type { JsonSchema, Message } from '../../src/vision/openrouter.js'
import type { ProviderRules } from '../../src/config.js'

const MIN_ENV = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' }

class StubClient implements VisionClient {
  calls: { kind: CallKind | undefined; model: string; messages: Message[] }[] = []
  constructor(private queue: { content: string }[]) {}
  async complete(opts: {
    model: string
    messages: Message[]
    schema?: JsonSchema
    provider?: ProviderRules
    kind?: CallKind
  }): Promise<{ id: string; content: string; cost: CallCost; model: string }> {
    this.calls.push({ kind: opts.kind, model: opts.model, messages: opts.messages })
    const next = this.queue.shift()
    if (next === undefined) throw new Error('StubClient queue exhausted')
    const cost: CallCost = {
      model: opts.model,
      provider: 'stub',
      tokens: 10,
      costUsd: 0.001,
      kind: opts.kind ?? 'code',
    }
    return { id: 'stub', content: next.content, cost, model: opts.model }
  }
}

async function scanDeps(
  dir: string,
  extra: Partial<CliDeps> = {},
): Promise<{ deps: CliDeps; out: string[]; err: string[] }> {
  const out: string[] = []
  const err: string[] = []
  const deps: CliDeps = {
    cwd: dir,
    env: { ...MIN_ENV },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    ...extra,
  }
  return { deps, out, err }
}

async function readReport(dir: string): Promise<ScanReport> {
  return JSON.parse(await readFile(join(dir, 'argus-reviewer-report', 'scan-report.json'), 'utf8'))
}

const FIXTURE_FILES: Record<string, string> = {
  'src/endpoint.ts': 'const host = "http://192.168.1.5:8080"\nexport { host }\n',
  'src/todo.ts': '// TODO: wire retry\nexport const x = 1\n',
  'src/keys.ts': 'const AWS_KEY = "AKIAIOSFODNN7EXAMPLE"\nexport { AWS_KEY }\n',
  'credentials.json': '{ "token": "ghp_uniqueCredentialContent0123456789" }\n',
}

async function materializeTree(dir: string, files: Record<string, string>): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    const p = join(dir, name)
    await mkdir(join(p, '..'), { recursive: true })
    await writeFile(p, content)
  }
}

describe('argus scan (U7)', () => {
  it('audits a tree: deterministic + secrets findings, $0 spend', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'argus-scan-'))
    await materializeTree(dir, FIXTURE_FILES)
    const { deps, out } = await scanDeps(dir)

    const code = await main(['scan', '.'], deps)

    expect(code).toBe(0)
    expect(out.some((l) => l.startsWith('scan root:'))).toBe(true)
    const report = await readReport(dir)
    expect(report.filesScanned).toBe(4)
    expect(report.gitRepo).toBe(false)
    expect(report.spend).toEqual({ calls: 0, tokens: 0, costUsd: 0 })
    const ran = 'ran' in (report.rulesScan ?? {}) ? (report.rulesScan as { ran: string[] }).ran : []
    expect(ran).toContain('secrets')
    expect(ran).toContain('hardcoded-endpoint')
    expect(ran).toContain('leftover-todo')
    const rules = report.findings.map((f) => f.rule)
    expect(rules).toContain('hardcoded-endpoint')
    expect(rules).toContain('leftover-todo')
    // Unadjudicated secret stays a risk finding (severity ceiling).
    expect(report.findings.some((f) => f.rule === 'secrets' && f.severity === 'risk')).toBe(true)
    // Masking: the secret literal never reaches the report.
    expect(JSON.stringify(report)).not.toContain('AKIAIOSFODNN7EXAMPLE')
    expect(report.skipped).toEqual([])
  })

  it('errors cleanly on a nonexistent path and an empty dir', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'argus-scan-'))
    const { deps, err } = await scanDeps(dir)

    expect(await main(['scan', './nope'], deps)).toBe(1)
    expect(err.some((l) => l.includes('not a directory'))).toBe(true)

    const empty = join(dir, 'empty')
    await mkdir(empty)
    expect(await main(['scan', 'empty'], deps)).toBe(1)
    expect(err.some((l) => l.includes('no scannable files'))).toBe(true)
  })

  it('errors cleanly on --base outside a git work tree', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'argus-scan-'))
    await materializeTree(dir, { 'a.ts': 'export const a = 1\n' })
    const { deps, err } = await scanDeps(dir)

    expect(await main(['scan', '.', '--base', 'main'], deps)).toBe(1)
    expect(err.some((l) => l.includes('needs a git work tree'))).toBe(true)
  })

  it('--base audits the git diff range inside a work tree', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'argus-scan-'))
    const git = (args: string[]) =>
      execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args])
    git(['init', '-b', 'main'])
    await writeFile(join(dir, 'a.ts'), 'export const a = 1\n')
    git(['add', '-A'])
    git(['commit', '-m', 'base'])
    git(['checkout', '-b', 'feature'])
    await writeFile(join(dir, 'b.ts'), 'const host = "http://10.1.2.3:9000"\nexport { host }\n')
    git(['add', '-A'])
    git(['commit', '-m', 'head'])
    const { deps } = await scanDeps(dir)

    expect(await main(['scan', '.', '--base', 'main'], deps)).toBe(0)

    const report = await readReport(dir)
    expect(report.diffRange?.base).toBe('main')
    expect(report.filesScanned).toBe(1)
    expect(report.findings.some((f) => f.rule === 'hardcoded-endpoint')).toBe(true)
  })

  it('--model unions model findings but withholds credential-shaped files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'argus-scan-'))
    await materializeTree(dir, FIXTURE_FILES)
    const client = new StubClient([
      {
        content: JSON.stringify({
          summary: 'ok',
          verdict: 'approve',
          findings: [
            {
              file: 'src/todo.ts',
              line: 2,
              severity: 'nit',
              category: 'convention',
              message: 'L2: nit: model finding - fix it.',
            },
          ],
        }),
      },
    ])
    const { deps } = await scanDeps(dir, { createClient: () => client })

    expect(await main(['scan', '.', '--model'], deps)).toBe(0)

    const report = await readReport(dir)
    expect(report.model?.findings).toBe(1)
    expect(report.spend.calls).toBe(1)
    expect(report.spend.costUsd).toBeGreaterThan(0)
    expect(report.findings.some((f) => f.message.includes('model finding'))).toBe(true)
    // credentials.json content never reached model context.
    const sent = JSON.stringify(client.calls.map((c) => c.messages))
    expect(sent).not.toContain('ghp_uniqueCredentialContent0123456789')
    expect(sent).not.toContain('credentials.json')
  })

  it('rules lane throw lands in skipped and the report still writes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'argus-scan-'))
    await materializeTree(dir, { 'a.ts': 'export const a = 1\n' })
    const { deps } = await scanDeps(dir, {
      rulesRunner: () => {
        throw new Error('lane boom')
      },
    })

    expect(await main(['scan', '.'], deps)).toBe(0)

    const report = await readReport(dir)
    expect(report.skipped).toContainEqual({ lane: 'rules', reason: 'lane boom' })
    expect(report.rulesScan).toEqual({ skipped: 'lane boom' })
    expect(report.findings).toEqual([])
    expect(report.verdict).toBe('pass')
  })

  it('review.rules: [] disables the lane — findings stay empty, report written', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'argus-scan-'))
    await materializeTree(dir, FIXTURE_FILES)
    await writeFile(
      join(dir, 'argus-reviewer.config.json'),
      JSON.stringify({ review: { rules: [] } }),
    )
    const { deps } = await scanDeps(dir)

    expect(await main(['scan', '.'], deps)).toBe(0)

    const report = await readReport(dir)
    expect(report.findings).toEqual([])
    expect(report.rulesScan).toEqual({ skipped: 'the rules lane is disabled (review.rules)' })
    expect(report.verdict).toBe('pass')
  })
})
