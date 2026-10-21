import { symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { resolveConfig, type ProviderRules } from '../../src/config.js'
import type { VisionClient } from '../../src/engine/loop.js'
import type { IndexEntry, RepoIndex } from '../../src/index/scan.js'
import { maskToolRecord, repoTools, TOOL_READ_CAP } from '../../src/review/tools.js'
import type { CallCost, CallKind } from '../../src/vision/cost.js'
import {
  OpenRouterClient,
  type JsonSchema,
  type Message,
  type ToolLoopResult,
  type ToolSpec,
} from '../../src/vision/openrouter.js'
import { useTmpDir } from '../helpers/tmp.js'
import { reply, runReview } from './review-pipeline.helpers.js'

const tmp = useTmpDir('review-tools')

function entry(path: string, over: Partial<IndexEntry> = {}): IndexEntry {
  return { path, imports: [], importedBy: [], contentHash: 'x'.repeat(64), ...over }
}

function index(entries: IndexEntry[]): RepoIndex {
  return { schemaVersion: 1, generatedAt: new Date().toISOString(), root: '/tmp', entries } as RepoIndex
}

const READ_SPEC: ToolSpec = {
  name: 'read_file',
  description: 'read',
  parameters: { type: 'object', properties: { path: { type: 'string' } } },
}

describe('repoTools executor', () => {
  it('reads an indexed file and returns its content', async () => {
    const dir = await tmp()
    await writeFile(join(dir, 'a.ts'), 'export const A = 1\n')
    const tools = repoTools({ cwd: dir, index: index([entry('a.ts')]) })
    expect(tools).toBeDefined()
    const out = await tools!.run('read_file', { path: 'a.ts' })
    expect(out).toContain('export const A = 1')
  })

  it('returns undefined without an index — no ungated reads', () => {
    expect(repoTools({ cwd: '/tmp', index: undefined })).toBeUndefined()
  })

  it('refuses .git/config (not indexable)', async () => {
    const dir = await tmp()
    const tools = repoTools({ cwd: dir, index: index([entry('a.ts')]) })!
    expect(await tools.run('read_file', { path: '.git/config' })).toMatch(/^error: .*not in the repository index/)
  })

  it('refuses credential-shaped paths even when indexed (.env)', async () => {
    const dir = await tmp()
    await writeFile(join(dir, '.env'), 'OPENROUTER_API_KEY=sk-secret')
    const tools = repoTools({ cwd: dir, index: index([entry('.env')]) })!
    expect(await tools.run('read_file', { path: '.env' })).toMatch(/refused \(credential-shaped\)/)
  })

  it('refuses a symlink escaping the checkout', async () => {
    const dir = await tmp()
    const outside = await tmp()
    await writeFile(join(outside, 'secret.txt'), 'leak')
    await symlink(join(outside, 'secret.txt'), join(dir, 'linked.txt'))
    const tools = repoTools({ cwd: dir, index: index([entry('linked.txt')]) })!
    expect(await tools.run('read_file', { path: 'linked.txt' })).toMatch(/escapes the checkout/)
  })

  it('refuses unindexed, absolute and traversal paths', async () => {
    const dir = await tmp()
    const tools = repoTools({ cwd: dir, index: index([entry('a.ts')]) })!
    expect(await tools.run('read_file', { path: 'b.ts' })).toMatch(/not in the repository index/)
    expect(await tools.run('read_file', { path: '/etc/passwd' })).toMatch(/not a safe repo-relative path/)
    expect(await tools.run('read_file', { path: '../a.ts' })).toMatch(/not a safe repo-relative path/)
  })

  it('truncates large reads at the cap', async () => {
    const dir = await tmp()
    await writeFile(join(dir, 'big.ts'), 'y'.repeat(TOOL_READ_CAP + 128))
    const tools = repoTools({ cwd: dir, index: index([entry('big.ts')]) })!
    const out = await tools.run('read_file', { path: 'big.ts' })
    expect(out).toContain('truncated')
    expect(out.length).toBeLessThan(TOOL_READ_CAP + 256)
  })

  it('masks secret literals in read results', async () => {
    const dir = await tmp()
    await writeFile(join(dir, 'c.ts'), 'const t = "ghp_abcdefghijklmnopqrstuvwxyz0123456789"\n')
    const tools = repoTools({ cwd: dir, index: index([entry('c.ts')]) })!
    const out = await tools.run('read_file', { path: 'c.ts' })
    expect(out).not.toContain('ghp_')
    expect(out).toContain('***')
  })

  it('refuses an in-checkout symlink aliasing a credential-shaped file', async () => {
    const dir = await tmp()
    await writeFile(join(dir, 'real.env'), 'OPENROUTER_API_KEY=sk-secret')
    await symlink(join(dir, 'real.env'), join(dir, 'alias.txt'))
    const tools = repoTools({ cwd: dir, index: index([entry('alias.txt'), entry('real.env')]) })!
    expect(await tools.run('read_file', { path: 'alias.txt' })).toMatch(/resolves to a different path/)
  })

  it('masks a full PEM private key block, body included', async () => {
    const dir = await tmp()
    const pem = [
      '-----BEGIN PRIVATE KEY-----',
      'MIIEvwIBADANBgkqhkiG9w0BAQEFAASCBKkwggSlAgEAAoIBAQC7',
      'dGVzdGtleWJvZHlmb3J0ZXN0aW5ncHVycG9zZXM=',
      '-----END PRIVATE KEY-----',
    ].join('\n')
    await writeFile(join(dir, 'key.ts'), `const k = \`\n${pem}\n\`\n`)
    const tools = repoTools({ cwd: dir, index: index([entry('key.ts')]) })!
    const out = await tools.run('read_file', { path: 'key.ts' })
    expect(out).not.toContain('MIIEvwIBADANBgkqhkiG9w0BAQEFAASCBKkwggSlAgEAAoIBAQC7')
    expect(out).not.toContain('dGVzdGtleWJvZHlmb3J0ZXN0aW5ncHVycG9zZXM=')
    expect(out).toContain('***')
  })

  it('masks a PEM block truncated mid-body', async () => {
    const dir = await tmp()
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEvwIBADANBgkqhkiG9w0BAQEFAASCBKkwggSlAg'
    await writeFile(join(dir, 'k2.ts'), pem + '\n')
    const tools = repoTools({ cwd: dir, index: index([entry('k2.ts')]) })!
    const out = await tools.run('read_file', { path: 'k2.ts' })
    expect(out).not.toContain('MIIEvwIBADANBgkqhkiG9w0BAQEFAASCBKkwggSlAg')
  })

  it('search_index matches path and purpose, bounded', async () => {
    const dir = await tmp()
    const tools = repoTools({
      cwd: dir,
      index: index([entry('src/spend.ts', { purpose: 'org spend journal' }), entry('src/other.ts')]),
    })!
    const out = await tools.run('search_index', { query: 'spend' })
    expect(out).toContain('src/spend.ts')
    expect(out).toContain('org spend journal')
    expect(out).not.toContain('src/other.ts')
    expect(await tools.run('search_index', { query: '' })).toMatch(/^error:/)
  })

  it('find_tests_for returns importing tests and same-name siblings', async () => {
    const dir = await tmp()
    const tools = repoTools({
      cwd: dir,
      index: index([
        entry('src/a.ts', { importedBy: ['src/util.ts', 'tests/a.test.ts'] }),
        entry('tests/a.test.ts'),
        entry('tests/unit/a.spec.ts'),
      ]),
    })!
    const out = await tools.run('find_tests_for', { path: 'src/a.ts' })
    expect(out).toContain('tests/a.test.ts')
    expect(out).toContain('tests/unit/a.spec.ts')
    expect(out).not.toContain('src/util.ts')
  })

  it('tool specs disclose base-ref staleness on the issue_comment lane', () => {
    const tools = repoTools({ cwd: '/tmp', index: index([entry('a.ts')]), staleBase: true })!
    expect(tools.specs.every((s) => s.description.includes('base ref'))).toBe(true)
  })

  it('maskToolRecord masks secret literals in args and result', () => {
    const masked = maskToolRecord({
      name: 'read_file',
      args: { path: 'x.ts', note: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' },
      ok: true,
      result: 'aws key AKIAABCDEFGHIJKLMNOP here',
      round: 0,
    })
    expect(JSON.stringify(masked.args)).not.toContain('ghp_')
    expect(masked.result).not.toContain('AKIAABCDEFGHIJKLMNOP')
  })
})

interface StubCall {
  url: string
  body: string | undefined
}

function stubFetch(responses: unknown[]) {
  let i = 0
  const calls: StubCall[] = []
  const fn: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push({ url, body: typeof init?.body === 'string' ? init.body : undefined })
    const resp = responses[i++]
    if (resp === undefined) throw new Error('No more stubbed responses')
    return new Response(JSON.stringify(resp), { status: 200 })
  }
  return { fetch: fn, calls }
}

function orResp(over: { toolCalls?: unknown[]; content?: string; cost?: number; finish?: string; model?: string } = {}) {
  return {
    id: 'gen-t',
    model: over.model ?? 'test/model',
    choices: [
      {
        message: {
          content: over.content ?? '{"findings":[]}',
          ...(over.toolCalls !== undefined ? { tool_calls: over.toolCalls } : {}),
        },
        finish_reason: over.finish ?? 'stop',
      },
    ],
    usage: { total_tokens: 10, cost: over.cost ?? 0.001 },
  }
}

function call(name: string, args: string, id = 'c1') {
  return { id, type: 'function', function: { name, arguments: args } }
}

const MSG: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'review' }] }]

describe('completeWithTools', () => {
  it('runs one read round then returns the final answer with the transcript', async () => {
    const { fetch, calls } = stubFetch([
      orResp({ toolCalls: [call('read_file', '{"path":"src/a.ts"}')], finish: 'tool_calls' }),
      orResp({ content: '{"findings":[{"file":"src/a.ts"}]}' }),
    ])
    const client = new OpenRouterClient({ apiKey: 'k', fetch })
    const seen: string[] = []
    const r = await client.completeWithTools({
      model: 'test/model',
      messages: MSG,
      tools: [READ_SPEC],
      execute: async (name, args) => {
        seen.push(`${name}:${JSON.stringify(args)}`)
        return 'file body'
      },
    })
    expect(r.content).toContain('src/a.ts')
    expect(r.rounds).toBe(2)
    expect(r.costs).toHaveLength(2)
    expect(r.toolCalls).toHaveLength(1)
    expect(r.toolCalls[0].name).toBe('read_file')
    expect(r.toolCalls[0].ok).toBe(true)
    expect(r.toolCalls[0].result).toBe('file body')
    expect(seen).toEqual(['read_file:{"path":"src/a.ts"}'])

    const first = JSON.parse(calls[0].body ?? '{}')
    expect(first.tools[0].function.name).toBe('read_file')
    expect(first.tool_choice).toBe('auto')
    const second = JSON.parse(calls[1].body ?? '{}')
    const msgs = second.messages as Record<string, unknown>[]
    const assistant = msgs.find((m) => m.role === 'assistant' && m.tool_calls !== undefined)
    const toolMsg = msgs.find((m) => m.role === 'tool')
    expect(assistant).toBeDefined()
    expect(toolMsg?.tool_call_id).toBe('c1')
    expect((toolMsg?.content as { text: string }[])[0].text).toBe('file body')
  })

  it('stops at maxRounds, disarms tools, and returns abortReason rounds', async () => {
    const { fetch, calls } = stubFetch([
      orResp({ toolCalls: [call('read_file', '{"path":"a"}')], finish: 'tool_calls' }),
      orResp({ toolCalls: [call('read_file', '{"path":"b"}')], finish: 'tool_calls' }),
      orResp({ content: '{"findings":[]}' }),
    ])
    const client = new OpenRouterClient({ apiKey: 'k', fetch })
    const r = await client.completeWithTools({
      model: 'test/model',
      messages: MSG,
      tools: [READ_SPEC],
      execute: async () => 'body',
      maxRounds: 2,
    })
    expect(r.abortReason).toBe('rounds')
    expect(r.rounds).toBe(3)
    expect(r.toolCalls).toHaveLength(2)
    // Final round keeps tools defined (tool messages are in history) but
    // disarms them via tool_choice 'none'.
    const last = JSON.parse(calls[2].body ?? '{}')
    expect(last.tools).toBeDefined()
    expect(last.tool_choice).toBe('none')
  })

  it('aborts on canSpend=false with abortReason budget, costs still ledgered', async () => {
    const { fetch, calls } = stubFetch([
      orResp({ toolCalls: [call('read_file', '{"path":"a"}')], finish: 'tool_calls', cost: 0.05 }),
      orResp({ content: '{"findings":[]}' }),
    ])
    const client = new OpenRouterClient({ apiKey: 'k', fetch })
    const spends: number[] = []
    const r = await client.completeWithTools({
      model: 'test/model',
      messages: MSG,
      tools: [READ_SPEC],
      execute: async () => 'body',
      canSpend: (spent) => {
        spends.push(spent)
        return false
      },
    })
    expect(r.abortReason).toBe('budget')
    expect(r.costs.reduce((s, c) => s + c.costUsd, 0)).toBeCloseTo(0.051)
    expect(spends[0]).toBeCloseTo(0.05)
    expect(JSON.parse(calls[1].body ?? '{}').tool_choice).toBe('none')
  })

  it('feeds unknown-tool and bad-args errors back to the model and continues', async () => {
    const { fetch, calls } = stubFetch([
      orResp({
        toolCalls: [call('hack_planet', '{}'), call('read_file', 'not json')],
        finish: 'tool_calls',
      }),
      orResp({ content: '{"findings":[]}' }),
    ])
    const client = new OpenRouterClient({ apiKey: 'k', fetch })
    const r = await client.completeWithTools({
      model: 'test/model',
      messages: MSG,
      tools: [READ_SPEC],
      execute: async () => 'should not run',
    })
    expect(r.toolCalls).toHaveLength(2)
    expect(r.toolCalls[0].ok).toBe(false)
    expect(r.toolCalls[0].result).toContain('unknown tool')
    expect(r.toolCalls[1].result).toContain('not valid JSON')
    const second = JSON.parse(calls[1].body ?? '{}')
    const toolMsgs = (second.messages as Record<string, unknown>[]).filter((m) => m.role === 'tool')
    expect(toolMsgs).toHaveLength(2)
    expect(r.content).toContain('findings')
  })

  it('caps tool calls per round — overflow gets an error reply, unexecuted', async () => {
    const { fetch, calls } = stubFetch([
      orResp({
        toolCalls: Array.from({ length: 10 }, (_, i) => call('read_file', `{"path":"f${i}"}`, `c${i}`)),
        finish: 'tool_calls',
      }),
      orResp({ content: '{"findings":[]}' }),
    ])
    const client = new OpenRouterClient({ apiKey: 'k', fetch })
    let executed = 0
    const r = await client.completeWithTools({
      model: 'test/model',
      messages: MSG,
      tools: [READ_SPEC],
      execute: async () => {
        executed++
        return 'body'
      },
    })
    expect(executed).toBe(8)
    expect(r.toolCalls).toHaveLength(10)
    expect(r.toolCalls[9].ok).toBe(false)
    expect(r.toolCalls[9].result).toContain('cap')
    // All ten call ids got tool replies — providers require one each.
    const second = JSON.parse(calls[1].body ?? '{}')
    expect((second.messages as { role: string }[]).filter((m) => m.role === 'tool')).toHaveLength(10)
  })

  it('carries a failed candidate\'s billed rounds into the result', async () => {
    let n = 0
    const fetch: typeof fetch = async () => {
      n++
      if (n === 1) {
        return new Response(
          JSON.stringify(orResp({ toolCalls: [call('read_file', '{"path":"a"}')], finish: 'tool_calls', cost: 0.07 })),
          { status: 200 },
        )
      }
      if (n === 2) throw new Error('boom mid-loop')
      return new Response(JSON.stringify(orResp({ content: '{"ok":1}', model: 'good/model' })), { status: 200 })
    }
    const client = new OpenRouterClient({ apiKey: 'k', fetch })
    const r = await client.completeWithTools({
      model: 'bad/model',
      escalationModels: ['good/model'],
      messages: MSG,
      tools: [READ_SPEC],
      execute: async () => 'body',
    })
    // The failed candidate's round + tool call ride into the success result.
    expect(r.costs).toHaveLength(2)
    expect(r.costs[0].costUsd).toBeCloseTo(0.07)
    expect(r.toolCalls).toHaveLength(1)
    expect(r.toolCalls[0].result).toBe('body')
  })

  it('falls back to the next candidate model when the loop throws', async () => {
    let n = 0
    const fetch: typeof fetch = async () => {
      n++
      if (n === 1) throw new Error('boom')
      return new Response(JSON.stringify(orResp({ content: '{"ok":1}', model: 'good/model' })), { status: 200 })
    }
    const client = new OpenRouterClient({ apiKey: 'k', fetch })
    const r = await client.completeWithTools({
      model: 'bad/model',
      escalationModels: ['good/model'],
      messages: MSG,
      tools: [READ_SPEC],
      execute: async () => 'x',
    })
    expect(r.content).toBe('{"ok":1}')
    expect(r.model).toBe('good/model')
  })
})

describe('review.repoTools config', () => {
  it('defaults off and only a literal true opts in', () => {
    expect(resolveConfig().review.repoTools).toBe(false)
    expect(resolveConfig({ review: { repoTools: true } }).review.repoTools).toBe(true)
    expect(resolveConfig({ review: { repoTools: 'yes' as unknown as boolean } }).review.repoTools).toBe(false)
  })
})

const STUB_COST: CallCost = { model: 'm', provider: 'stub', tokens: 10, costUsd: 0.001, kind: 'code' }

/** Review client whose tool loop performs one real executor read, then answers. */
class ToolClient implements VisionClient {
  reads: string[] = []
  async complete(): Promise<{ id: string; content: string; cost: CallCost; model: string }> {
    return { id: 'c', content: reply([]).content, cost: STUB_COST, model: 'm' }
  }
  async completeWithTools(opts: {
    model: string
    messages: Message[]
    schema?: JsonSchema
    provider?: ProviderRules
    kind?: CallKind
    tools: ToolSpec[]
    execute: (name: string, args: Record<string, unknown>) => Promise<string>
    canSpend?: (spent: number) => boolean
  }): Promise<ToolLoopResult> {
    const result = await opts.execute('read_file', { path: 'src/caller.ts' })
    this.reads.push(result)
    const allowed = opts.canSpend?.(0.002) ?? true
    return {
      id: 't',
      content: reply([
        { file: 'src/a.ts', line: 1, severity: 'bug', category: 'correctness', message: 'caller ignores the null branch' },
      ]).content,
      costs: [{ ...STUB_COST }, { ...STUB_COST }],
      model: 'm',
      toolCalls: [
        { name: 'read_file', args: { path: 'src/caller.ts' }, ok: !result.startsWith('error:'), result, round: 0 },
      ],
      rounds: 2,
      ...(allowed ? {} : { abortReason: 'budget' as const }),
    }
  }
}

const INDEX_JSON = JSON.stringify({
  schemaVersion: 1,
  generatedAt: '2026-01-01T00:00:00Z',
  root: '/x',
  entries: [
    { path: 'src/a.ts', imports: [], importedBy: ['src/caller.ts'], contentHash: 'a'.repeat(64) },
    { path: 'src/caller.ts', imports: ['src/a.ts'], importedBy: [], contentHash: 'b'.repeat(64), purpose: 'calls a' },
  ],
})

describe('code-review tool lane (U9)', () => {
  it('model reads an undiffed indexed caller; transcript + diff-anchored finding land in the report', async () => {
    const client = new ToolClient()
    const { report, err } = await runReview({
      base: {
        'argus.index.json': INDEX_JSON,
        'src/a.ts': 'export const a = 1\n',
        'src/caller.ts': 'import { a } from "./a"\nexport const call = () => a ?? 0\n',
      },
      head: { 'src/a.ts': 'export const a = 2\n' },
      client,
      config: { review: { repoTools: true } },
    })
    expect(err.join('\n')).not.toContain('running without tools')
    // The undiffed caller came back through the real jailed read.
    expect(client.reads[0]).toContain('export const call')
    // Transcript recorded on the report, round count + call + masked result.
    expect(report.toolUse.rounds).toBe(2)
    expect(report.toolUse.calls).toHaveLength(1)
    expect(report.toolUse.calls[0].name).toBe('read_file')
    expect(report.toolUse.calls[0].result).toContain('export const call')
    // Every loop round was ledgered.
    expect(report.calls.length).toBe(2)
    // The finding reasoning cited caller context but stays anchored to the diff.
    expect(report.findings.some((f: { file: string }) => f.file === 'src/a.ts')).toBe(true)
    expect(report.findings.some((f: { file: string }) => f.file === 'src/caller.ts')).toBe(false)
  })

  it('repoTools on without an index warns and falls back to the plain path', async () => {
    const { report, err } = await runReview({
      base: { 'src/a.ts': 'export const a = 1\n' },
      head: { 'src/a.ts': 'export const a = 2\n' },
      client: new ToolClient(),
      config: { review: { repoTools: true } },
    })
    expect(err.join('\n')).toContain('running without tools')
    expect(report.toolUse).toBeUndefined()
    expect(report.ok).toBe(true)
  })
})
