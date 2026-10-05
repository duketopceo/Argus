import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildCodeReviewMessages, main } from '../../src/cli.js'
import { parseInstructions, resolveConfig } from '../../src/config.js'
import { rulesForFiles } from '../../src/review/scope.js'
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
    const cost: CallCost = { model: opts.model, provider: 'stub', tokens: 10, costUsd: 0.001, kind: opts.kind ?? 'code' }
    return { id: 'stub', content: next.content, cost, model: opts.model }
  }
}

function materializeFixture(
  dir: string,
  baseFiles: Record<string, string>,
  headFiles: Record<string, string>,
): void {
  const git = (args: string[]) =>
    execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args])
  const write = (files: Record<string, string>) => {
    for (const [name, content] of Object.entries(files)) {
      execFileSync('mkdir', ['-p', join(dir, name, '..')])
      execFileSync('sh', ['-c', `cat > ${join(dir, name)}`], { input: content })
    }
  }
  execFileSync('git', ['-C', dir, 'init', '-b', 'pr'])
  write(baseFiles)
  git(['add', '-A'])
  git(['commit', '--allow-empty', '-m', 'base'])
  git(['branch', 'argus-fixture-base'])
  write(headFiles)
  git(['add', '-A'])
  git(['commit', '--allow-empty', '-m', 'head'])
}

function userText(messages: Message[]): string {
  const part = messages[1]?.content[0]
  return part?.type === 'text' ? part.text : ''
}

const PASS = { content: JSON.stringify({ summary: 'ok', verdict: 'pass', findings: [] }) }

describe('rulesForFiles', () => {
  const instructions = [
    { glob: 'db/**', rule: 'Migrations must be reversible' },
    { glob: '**/*.tsx', rule: 'Flag missing aria labels' },
    { glob: 'src/**', rule: 'No console.log' },
  ]

  it('returns only rules whose glob matches a file in the set', () => {
    expect(rulesForFiles(instructions, ['db/migrations/001.sql'])).toEqual([
      'Migrations must be reversible',
    ])
    expect(rulesForFiles(instructions, ['web/page.tsx'])).toEqual(['Flag missing aria labels'])
  })

  it('keeps entry order when a file matches two globs', () => {
    expect(rulesForFiles(instructions, ['src/x.ts'])).toEqual(['No console.log'])
    expect(rulesForFiles(instructions, ['src/ui/a.tsx'])).toEqual([
      'Flag missing aria labels',
      'No console.log',
    ])
  })

  it('returns [] for no instructions or no matches', () => {
    expect(rulesForFiles([], ['a.ts'])).toEqual([])
    expect(rulesForFiles(instructions, ['docs/readme.md'])).toEqual([])
  })
})

describe('parseInstructions / config normalization', () => {
  it('keeps well-formed entries and trims', () => {
    expect(
      resolveConfig({
        review: { instructions: [{ glob: ' db/** ', rule: ' reversibility ' }] },
      }).review.instructions,
    ).toEqual([{ glob: 'db/**', rule: 'reversibility' }])
  })

  it('rejects non-array input too — a mis-typed key must not silently deaden rules', () => {
    expect(() =>
      resolveConfig({ review: { instructions: 'db/**' as never } }),
    ).toThrow(/review\.instructions must be an array/)
    expect(resolveConfig({ review: { instructions: [] } }).review.instructions).toEqual([])
  })

  it('throws a validation error naming the malformed entry', () => {
    expect(() =>
      resolveConfig({
        review: { instructions: [{ glob: '', rule: 'x' }] },
      }),
    ).toThrow(/review\.instructions\[0\]/)
    expect(() =>
      resolveConfig({
        review: { instructions: [{ glob: 'db/**', rule: 5 } as never] },
      }),
    ).toThrow(/review\.instructions\[0\].*rule/)
    expect(() =>
      parseInstructions([{ glob: 'a', rule: 'ok' }, { glob: 'b/**' }]),
    ).toThrow(/review\.instructions\[1\]/)
  })
})

describe('buildCodeReviewMessages instructions block', () => {
  it('appends per-path rules after the rubric, omitting the block when empty', () => {
    const withRules = userText(
      buildCodeReviewMessages('o/r', '1', 'diff', 0, 1, [], ['Migrations must be reversible']),
    )
    expect(withRules).toContain('Repo rules for files in this chunk')
    expect(withRules).toContain('- Migrations must be reversible')
    const without = userText(buildCodeReviewMessages('o/r', '1', 'diff'))
    expect(without).not.toContain('Repo rules')
  })
})

describe('code-review per-chunk instruction injection', () => {
  it('injects a rule only into chunks carrying matching files', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'argus-inst-'))
    // Both files exceed CHUNK_TOKEN_TARGET (~24000 chars): each splits into
    // single-file chunks of ~4k tokens that never pack with the other file's
    // chunks, so every chunk is provably one file family.
    const big = (line: (i: number) => string) =>
      Array.from({ length: 1400 }, (_, i) => line(i)).join('\n') + '\n'
    materializeFixture(
      repo,
      {
        'db/migrations/001.sql': 'SELECT 1\n',
        'src/ui/a.tsx': 'export const a = 1\n',
      },
      {
        'db/migrations/001.sql': big((i) => `ALTER TABLE t ADD COLUMN c${i} int;`),
        'src/ui/a.tsx': big((i) => `export const u${i} = <span>a${i}</span>`),
      },
    )
    const cwd = await mkdtemp(join(tmpdir(), 'argus-inst-cwd-'))
    const reportDir = join(cwd, 'report')
    await writeFile(
      join(cwd, 'argus-reviewer.config.json'),
      JSON.stringify({
        decisionModel: '',
        reportDir,
        review: {
          instructions: [
            { glob: 'db/**', rule: 'Migrations must be reversible' },
            { glob: '**/*.tsx', rule: 'Flag missing aria labels' },
          ],
        },
      }),
    )
    // 6 chunk calls (3 per file) + 1 synthesis; queue has slack.
    const client = new StubClient(Array.from({ length: 8 }, () => PASS))
    const code = await main(['code-review', '--fixture', repo, '--report-dir', reportDir], {
      cwd,
      env: { ...MIN_ENV, OPENROUTER_API_KEY: 'test-key' },
      out: () => {},
      err: () => {},
      createClient: () => client,
    })
    expect(code).toBe(0)
    const texts = client.calls.map((c) => userText(c.messages))
    // Chunk prompts carry the diff; the synthesis prompt does not.
    const chunkTexts = texts.filter((t) => t.includes('```diff'))
    const dbChunks = chunkTexts.filter((t) => t.includes('db/migrations/001.sql'))
    const uiChunks = chunkTexts.filter((t) => t.includes('src/ui/a.tsx'))
    expect(dbChunks.length).toBeGreaterThan(0)
    expect(uiChunks.length).toBeGreaterThan(0)
    for (const t of dbChunks) {
      expect(t).toContain('Repo rules for files in this chunk')
      expect(t).toContain('Migrations must be reversible')
      expect(t).not.toContain('aria labels')
    }
    for (const t of uiChunks) {
      expect(t).toContain('Flag missing aria labels')
      expect(t).not.toContain('reversible')
    }
  })

  it('ARGUS_REVIEW_INSTRUCTIONS (JSON) overrides config; invalid JSON warns and keeps config', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'argus-inst-'))
    materializeFixture(repo, { 'a.ts': 'x\n' }, { 'a.ts': 'y\n' })
    const cwd = await mkdtemp(join(tmpdir(), 'argus-inst-cwd-'))
    const reportDir = join(cwd, 'report')
    await writeFile(
      join(cwd, 'argus-reviewer.config.json'),
      JSON.stringify({
        decisionModel: '',
        reportDir,
        review: { instructions: [{ glob: '**', rule: 'config rule' }] },
      }),
    )
    const good = new StubClient([PASS])
    const code = await main(['code-review', '--fixture', repo, '--report-dir', reportDir], {
      cwd,
      env: {
        ...MIN_ENV,
        OPENROUTER_API_KEY: 'test-key',
        ARGUS_REVIEW_INSTRUCTIONS: '[{"glob":"**","rule":"env rule"}]',
      },
      out: () => {},
      err: () => {},
      createClient: () => good,
    })
    expect(code).toBe(0)
    const text = userText(good.calls[0]?.messages ?? [])
    expect(text).toContain('env rule')
    expect(text).not.toContain('config rule')

    const bad = new StubClient([PASS])
    const errs: string[] = []
    const code2 = await main(['code-review', '--fixture', repo, '--report-dir', reportDir], {
      cwd,
      env: {
        ...MIN_ENV,
        OPENROUTER_API_KEY: 'test-key',
        ARGUS_REVIEW_INSTRUCTIONS: '[{"glob":""}]',
      },
      out: () => {},
      err: (l) => errs.push(l),
      createClient: () => bad,
    })
    expect(code2).toBe(0)
    expect(errs.join('\n')).toContain('ARGUS_REVIEW_INSTRUCTIONS')
    expect(userText(bad.calls[0]?.messages ?? [])).toContain('config rule')
  })

  it('a malformed config entry fails the load naming the entry', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'argus-inst-'))
    materializeFixture(repo, { 'a.ts': 'x\n' }, { 'a.ts': 'y\n' })
    const cwd = await mkdtemp(join(tmpdir(), 'argus-inst-cwd-'))
    const reportDir = join(cwd, 'report')
    await writeFile(
      join(cwd, 'argus-reviewer.config.json'),
      JSON.stringify({
        reportDir,
        review: { instructions: [{ glob: 'db/**' }] },
      }),
    )
    const errs: string[] = []
    const code = await main(['code-review', '--fixture', repo, '--report-dir', reportDir], {
      cwd,
      env: { ...MIN_ENV, OPENROUTER_API_KEY: 'test-key' },
      out: () => {},
      err: (l) => errs.push(l),
      createClient: () => {
        throw new Error('config must fail before the model is reached')
      },
    })
    expect(code).not.toBe(0)
    expect(errs.join('\n')).toContain('review.instructions[0]')
  })
})
