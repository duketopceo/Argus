import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { filesFromUnifiedDiff, loadFixture, main } from '../../src/cli.js'
import { scanDiffForSecrets } from '../../src/review/secrets.js'
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

/** Build a git repo: commit baseFiles on `pr`, tag argus-fixture-base, apply headFiles, commit. */
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

const SECRET_LITERAL = 'api_key = "demo0123456789abcdef"'

describe('filesFromUnifiedDiff', () => {
  it('parses added, modified, and deleted file names', () => {
    const diff = [
      'diff --git a/new.ts b/new.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/new.ts',
      '@@ -0,0 +1 @@',
      '+added',
      'diff --git a/mod.ts b/mod.ts',
      '--- a/mod.ts',
      '+++ b/mod.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'diff --git a/gone.ts b/gone.ts',
      'deleted file mode 100644',
      '--- a/gone.ts',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-bye',
    ].join('\n')
    const files = filesFromUnifiedDiff(diff)
    expect(files.map((f) => f.filename)).toEqual(['new.ts', 'mod.ts', 'gone.ts'])
    expect(files[0]?.patch).toContain('+added')
  })
})

describe('loadFixture', () => {
  it('returns files, meta, and diff for a materialized fixture repo', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'argus-fix-'))
    materializeFixture(
      dir,
      { 'src/a.ts': 'export const a = 1\n' },
      { 'src/a.ts': 'export const a = 2\n', 'docs/s.md': '# doc\n' },
    )
    const fx = await loadFixture(dir)
    expect('skipped' in fx).toBe(false)
    if ('skipped' in fx) return
    expect(fx.files.map((f) => f.filename).sort()).toEqual(['docs/s.md', 'src/a.ts'])
    expect(fx.meta.isFork).toBe(false)
    expect(fx.diff).toContain('+export const a = 2')
  })

  it('skips cleanly when argus-fixture-base is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'argus-fix-'))
    execFileSync('git', ['-C', dir, 'init'])
    const fx = await loadFixture(dir)
    expect('skipped' in fx).toBe(true)
    if ('skipped' in fx) expect(fx.skipped).toContain('argus-fixture-base')
  })
})

describe('code-review --fixture', () => {
  it('runs the real review+secrets pipeline with zero GitHub API calls', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'argus-fix-'))
    materializeFixture(
      repo,
      { 'src/a.ts': 'export const a = 1\n' },
      { 'src/a.ts': 'export const a = 2\n', 'cfg.env': `${SECRET_LITERAL}\n` },
    )
    const cwd = await mkdtemp(join(tmpdir(), 'argus-fix-cwd-'))
    const reportDir = join(cwd, 'report')
    // decisionModel '' disables adjudication — deterministic regex-only lane.
    await writeFile(
      join(cwd, 'argus-reviewer.config.json'),
      JSON.stringify({ decisionModel: '', reportDir }),
    )
    const client = new StubClient([
      {
        content: JSON.stringify({
          summary: 'found a bug',
          verdict: 'needs_changes',
          findings: [
            { file: 'src/a.ts', line: 1, severity: 'bug', category: 'correctness', message: 'L1: bug' },
          ],
        }),
      },
    ])
    const out: string[] = []
    const err: string[] = []
    // No GITHUB_TOKEN / GITHUB_REPOSITORY — any api.github.com call would fail.
    const code = await main(['code-review', '--fixture', repo, '--report-dir', reportDir], {
      cwd,
      env: { ...MIN_ENV, OPENROUTER_API_KEY: 'test-key' },
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      createClient: () => client,
    })
    expect(code).toBe(0)
    const report = JSON.parse(await readFile(join(reportDir, 'code-review.json'), 'utf8'))
    expect(report.verdict).toBe('needs_changes')
    // Model finding + secrets-lane finding (masked) both present.
    expect(report.findings.length).toBe(2)
    const secretFinding = report.findings.find((f: { category?: string }) => f.category === 'security')
    expect(secretFinding).toBeDefined()
    expect(JSON.stringify(report)).not.toContain(SECRET_LITERAL)
    expect(report.secretsScan.records.length).toBe(1)
    expect(report.secretsScan.records[0].adjudicated).toBe(false)
    // Stage lines streamed to the configured cache dir.
    const live = await readFile(join(cwd, '.argus-reviewer-cache', 'live.ndjson'), 'utf8')
    expect(live).toContain('fixture mode')
    expect(live).toContain('report written')
    // Only the code-model call happened — no decisions call (disabled), no GH.
    expect(client.calls).toHaveLength(1)
  })

  it('round-trips suggestion + startLine into code-review.json', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'argus-fix-'))
    materializeFixture(
      repo,
      { 'src/a.ts': 'export const a = 1\n' },
      { 'src/a.ts': 'export const a = 2\nexport const b = 1\n' },
    )
    const cwd = await mkdtemp(join(tmpdir(), 'argus-fix-cwd-'))
    const reportDir = join(cwd, 'report')
    await writeFile(
      join(cwd, 'argus-reviewer.config.json'),
      JSON.stringify({ decisionModel: '', reportDir }),
    )
    const client = new StubClient([
      {
        content: JSON.stringify({
          summary: 'found a bug',
          verdict: 'needs_changes',
          findings: [
            {
              file: 'src/a.ts',
              line: 2,
              startLine: 1,
              severity: 'bug',
              category: 'correctness',
              message: 'L2: bug',
              suggestion: 'export const a = 3\nexport const b = 2',
            },
          ],
        }),
      },
    ])
    const code = await main(['code-review', '--fixture', repo, '--report-dir', reportDir], {
      cwd,
      env: { ...MIN_ENV, OPENROUTER_API_KEY: 'test-key' },
      out: () => {},
      err: () => {},
      createClient: () => client,
    })
    expect(code).toBe(0)
    const report = JSON.parse(await readFile(join(reportDir, 'code-review.json'), 'utf8'))
    const finding = report.findings.find((f: { file: string }) => f.file === 'src/a.ts')
    expect(finding.suggestion).toBe('export const a = 3\nexport const b = 2')
    expect(finding.startLine).toBe(1)
  })

  it('ARGUS_CODE_MODEL env overrides the checkout config code_model', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'argus-fix-'))
    materializeFixture(
      repo,
      { 'src/a.ts': 'export const a = 1\n' },
      { 'src/a.ts': 'export const a = 2\n' },
    )
    const cwd = await mkdtemp(join(tmpdir(), 'argus-fix-cwd-'))
    const reportDir = join(cwd, 'report')
    await writeFile(
      join(cwd, 'argus-reviewer.config.json'),
      JSON.stringify({ decisionModel: '', code_model: 'config/model', reportDir }),
    )
    const client = new StubClient([
      { content: JSON.stringify({ summary: 'ok', verdict: 'pass', findings: [] }) },
    ])
    const code = await main(['code-review', '--fixture', repo, '--report-dir', reportDir], {
      cwd,
      env: { ...MIN_ENV, OPENROUTER_API_KEY: 'test-key', ARGUS_CODE_MODEL: 'env/model' },
      out: () => {},
      err: () => {},
      createClient: () => client,
    })
    expect(code).toBe(0)
    // Operator env beats the checkout's config value.
    expect(client.calls[0]?.model).toBe('env/model')
  })

  it('ARGUS_REVIEW_PROFILES env appends the pack rubric to the review prompt', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'argus-fix-'))
    materializeFixture(
      repo,
      { 'src/a.ts': 'export const a = 1\n' },
      { 'src/a.ts': 'export const a = 2\n' },
    )
    const cwd = await mkdtemp(join(tmpdir(), 'argus-fix-cwd-'))
    const reportDir = join(cwd, 'report')
    await writeFile(
      join(cwd, 'argus-reviewer.config.json'),
      JSON.stringify({ decisionModel: '', reportDir }),
    )
    const client = new StubClient([
      { content: JSON.stringify({ summary: 'ok', verdict: 'pass', findings: [] }) },
    ])
    const code = await main(['code-review', '--fixture', repo, '--report-dir', reportDir], {
      cwd,
      env: {
        ...MIN_ENV,
        OPENROUTER_API_KEY: 'test-key',
        ARGUS_REVIEW_PROFILES: 'security, bogus, perf',
      },
      out: () => {},
      err: () => {},
      createClient: () => client,
    })
    expect(code).toBe(0)
    const userMsg = client.calls[0]?.messages[1]?.content[0]
    const text = userMsg?.type === 'text' ? userMsg.text : ''
    expect(text).toContain('Active review lenses')
    expect(text).toContain('Security lens')
    expect(text).toContain('Performance lens')
    expect(text).not.toContain('Debloat')
    expect(text).not.toContain('bogus')
  })

  it('restores original suggestions after synthesis; synthesized-only fields drop', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'argus-fix-'))
    // ~1200 added lines per file — each patch alone exceeds the 6000-token
    // chunk target, so the run takes the multi-chunk + synthesis path.
    const big = (v: string) =>
      Array.from({ length: 1200 }, (_, i) => `export const ${v}${i} = ${i}`).join('\n') + '\n'
    materializeFixture(repo, {}, { 'src/a.ts': big('a'), 'src/b.ts': big('b') })
    const cwd = await mkdtemp(join(tmpdir(), 'argus-fix-cwd-'))
    const reportDir = join(cwd, 'report')
    await writeFile(
      join(cwd, 'argus-reviewer.config.json'),
      JSON.stringify({ decisionModel: '', reportDir }),
    )
    const client = new StubClient([
      // Chunk 1 (src/a.ts): grounded finding with a suggestion.
      {
        content: JSON.stringify({
          summary: 's',
          verdict: 'needs_changes',
          findings: [
            {
              file: 'src/a.ts',
              line: 900,
              startLine: 890,
              severity: 'bug',
              category: 'correctness',
              message: 'L900: bug — overflow',
              suggestion: 'export const a899 = 1',
            },
          ],
        }),
      },
      // Chunk 2 (src/b.ts): a nit the synthesis drops.
      {
        content: JSON.stringify({
          summary: 's',
          verdict: 'approve',
          findings: [
            { file: 'src/b.ts', line: 5, severity: 'nit', category: 'convention', message: 'L5: nit' },
          ],
        }),
      },
      // Synthesis: same a.ts finding (re-emitted fields must lose to the
      // original) plus a brand-new finding whose suggestion has no pre-image.
      {
        content: JSON.stringify({
          summary: 's',
          verdict: 'needs_changes',
          findings: [
            {
              file: 'src/a.ts',
              line: 900,
              startLine: 800,
              severity: 'bug',
              category: 'correctness',
              message: 'L900: bug — overflow',
              suggestion: 'SYNTHESIZED',
            },
            {
              file: 'src/b.ts',
              line: 50,
              startLine: 45,
              severity: 'bug',
              category: 'correctness',
              message: 'L50: new synthesized bug',
              suggestion: 'fix()',
            },
          ],
        }),
      },
    ])
    const code = await main(['code-review', '--fixture', repo, '--report-dir', reportDir], {
      cwd,
      env: { ...MIN_ENV, OPENROUTER_API_KEY: 'test-key' },
      out: () => {},
      err: () => {},
      createClient: () => client,
    })
    expect(code).toBe(0)
    expect(client.calls).toHaveLength(3) // 2 chunks + synthesis
    const report = JSON.parse(await readFile(join(reportDir, 'code-review.json'), 'utf8'))
    expect(report.findings).toHaveLength(2)
    const a = report.findings.find((f: { file: string }) => f.file === 'src/a.ts')
    expect(a.suggestion).toBe('export const a899 = 1')
    expect(a.startLine).toBe(890)
    const b = report.findings.find((f: { file: string }) => f.file === 'src/b.ts')
    expect(b.message).toBe('L50: new synthesized bug')
    expect(b.suggestion).toBeUndefined()
    expect(b.startLine).toBeUndefined()
  })

  it('fixture diff produces deterministic secret candidates', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'argus-fix-'))
    materializeFixture(repo, {}, { 'cfg.env': `${SECRET_LITERAL}\n` })
    const fx = await loadFixture(repo)
    if ('skipped' in fx) throw new Error(fx.skipped)
    const candidates = scanDiffForSecrets(fx.diff)
    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.file).toBe('cfg.env')
    expect(candidates[0]?.line).toBe(1)
    expect(candidates[0]?.patternClass).toBe('generic-assignment')
  })

  it('exits non-zero with a clear message when OPENROUTER_API_KEY is missing', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'argus-fix-'))
    materializeFixture(repo, { 'a.ts': 'x\n' }, { 'a.ts': 'y\n' })
    const cwd = await mkdtemp(join(tmpdir(), 'argus-fix-cwd-'))
    const err: string[] = []
    const code = await main(['code-review', '--fixture', repo, '--report-dir', join(cwd, 'r')], {
      cwd,
      env: MIN_ENV, // deliberately no OPENROUTER_API_KEY
      out: () => {},
      err: (l) => err.push(l),
    })
    expect(code).toBe(1)
    expect(err.join('\n')).toContain('OPENROUTER_API_KEY')
  })
})
