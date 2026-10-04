import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { main } from '../../src/cli.js'
import type { VisionClient } from '../../src/engine/loop.js'
import type { CallCost, CallKind } from '../../src/vision/cost.js'
import type { Message } from '../../src/vision/openrouter.js'

export const MIN_ENV = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' }

export type Reply = { content: string } | Error

/** Scripted code-model client; records the prompt text of every call. */
export class ScriptedClient implements VisionClient {
  prompts: string[] = []
  constructor(private queue: Reply[]) {}
  async complete(opts: {
    model: string
    messages: Message[]
    kind?: CallKind
  }): Promise<{ id: string; content: string; cost: CallCost; model: string }> {
    this.prompts.push(
      opts.messages.flatMap((m) => m.content.map((p) => (p.type === 'text' ? p.text : ''))).join('\n'),
    )
    const next = this.queue.shift()
    if (next === undefined) throw new Error('ScriptedClient queue exhausted')
    if (next instanceof Error) throw next
    const cost: CallCost = { model: opts.model, provider: 'stub', tokens: 10, costUsd: 0.001, kind: 'code' }
    return { id: 'stub', content: next.content, cost, model: opts.model }
  }
}

export function materialize(
  dir: string,
  base: Record<string, string>,
  head: Record<string, string>,
): void {
  const git = (args: string[]) =>
    execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args])
  const write = (files: Record<string, string>) => {
    for (const [name, content] of Object.entries(files)) {
      execFileSync('mkdir', ['-p', join(dir, name, '..')])
      execFileSync('sh', ['-c', `cat > '${join(dir, name)}'`], { input: content })
    }
  }
  execFileSync('git', ['-C', dir, 'init', '-b', 'pr'])
  write(base)
  git(['add', '-A'])
  git(['commit', '--allow-empty', '-m', 'base'])
  git(['branch', 'argus-fixture-base'])
  write(head)
  git(['add', '-A'])
  git(['commit', '--allow-empty', '-m', 'head'])
}

export interface RunResult {
  code: number
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  report: Record<string, any>
  out: string[]
  err: string[]
}

export async function runReview(opts: {
  base?: Record<string, string>
  head: Record<string, string>
  client: VisionClient
  config?: Record<string, unknown>
  args?: string[]
  env?: Record<string, string>
  deps?: Record<string, unknown>
}): Promise<RunResult> {
  const repo = await mkdtemp(join(tmpdir(), 'argus-rv-'))
  materialize(repo, opts.base ?? {}, opts.head)
  const cwd = await mkdtemp(join(tmpdir(), 'argus-rv-cwd-'))
  const reportDir = join(cwd, 'report')
  await writeFile(
    join(cwd, 'argus-reviewer.config.json'),
    JSON.stringify({ decisionModel: '', reportDir, ...(opts.config ?? {}) }),
  )
  const out: string[] = []
  const err: string[] = []
  const code = await main(['code-review', '--fixture', repo, '--report-dir', reportDir, ...(opts.args ?? [])], {
    cwd,
    env: { ...MIN_ENV, OPENROUTER_API_KEY: 'test-key', ...(opts.env ?? {}) },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    createClient: () => opts.client,
    ...(opts.deps ?? {}),
  } as never)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let report: Record<string, any> = {}
  try {
    report = JSON.parse(await readFile(join(reportDir, 'code-review.json'), 'utf8'))
  } catch {
    // no report written (hard failure)
  }
  return { code, report, out, err }
}

export const lines = (n: number, prefix = 'line'): string =>
  Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join('\n') + '\n'

export const reply = (findings: unknown[], verdict = 'needs_changes'): Reply => ({
  content: JSON.stringify({ summary: 'ok', verdict, findings }),
})
