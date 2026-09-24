import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { main } from '../../src/cli.js'
import type { VisionClient } from '../../src/engine/loop.js'
import type { CallCost } from '../../src/vision/cost.js'
import type { JsonSchema, Message } from '../../src/vision/openrouter.js'
import type { ProviderRules } from '../../src/config.js'
import {
  classifyHeadBinding,
  isHeadBindingConclusive,
  readCheckoutSha,
} from '../../src/report/manifest.js'

describe('head binding', () => {
  it('reads a checkout SHA through the injected git runner', async () => {
    const sha = await readCheckoutSha('/repo', async (cmd, args) => {
      expect(cmd).toBe('git')
      expect(args).toEqual(['-C', '/repo', 'rev-parse', 'HEAD'])
      return { code: 0, stdout: 'abc123\n', stderr: '' }
    })
    expect(sha).toBe('abc123')
  })

  it('degrades to unknown when git identity cannot be read', async () => {
    const sha = await readCheckoutSha('/repo', async () => ({
      code: 1,
      stdout: '',
      stderr: 'no git',
    }))
    expect(sha).toBeUndefined()
  })

  it('classifies matching, mismatching, and unavailable identities', () => {
    expect(classifyHeadBinding('abc', 'abc', 'github').status).toBe('match')
    expect(classifyHeadBinding('abc', 'def', 'github')).toMatchObject({
      status: 'mismatch',
      intendedSha: 'abc',
      checkoutSha: 'def',
    })
    expect(classifyHeadBinding(undefined, 'abc', 'github').status).toBe('unknown')
    expect(classifyHeadBinding('abc', undefined, 'github').status).toBe('unknown')
  })

  it('treats only matched and fixture-bound heads as conclusive', () => {
    expect(isHeadBindingConclusive(classifyHeadBinding('abc', 'abc', 'github'))).toBe(true)
    expect(isHeadBindingConclusive(classifyHeadBinding('fixture', 'checkout', 'fixture'))).toBe(
      true,
    )
    expect(isHeadBindingConclusive(classifyHeadBinding('abc', 'def', 'github'))).toBe(false)
    expect(isHeadBindingConclusive(classifyHeadBinding(undefined, 'abc', 'github'))).toBe(false)
    expect(isHeadBindingConclusive(undefined)).toBe(false)
  })

  it('does not compare a fixture head with the caller checkout', () => {
    expect(classifyHeadBinding('fixture-head', 'other-checkout', 'fixture')).toMatchObject({
      status: 'not_applicable',
      source: 'fixture',
    })
  })

  it.each(['mismatch', 'unknown'] as const)(
    'marks a live review inconclusive when head binding is %s',
    async (bindingStatus) => {
      const cwd = await mkdtemp(join(tmpdir(), 'argus-head-binding-'))
      const reportDir = join(cwd, 'report')
      const git = (args: string[]) =>
        execFileSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
          encoding: 'utf8',
        }).trim()
      git(['init', '-b', 'main'])
      await writeFile(join(cwd, 'src.ts'), 'export const value = 1\n')
      await writeFile(
        join(cwd, 'argus-reviewer.config.json'),
        JSON.stringify({ decisionModel: '', reportDir }),
      )
      git(['add', '-A'])
      git(['commit', '-m', 'head'])
      const checkoutSha = git(['rev-parse', 'HEAD'])
      const intendedSha = bindingStatus === 'mismatch' ? 'different-head' : undefined

      const response = (body: unknown) =>
        ({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => body,
        }) as Response
      vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('/pulls/1/files')) {
          return response([
            {
              filename: 'src.ts',
              patch: '@@ -1 +1 @@\n-export const value = 1\n+export const value = 2',
            },
          ])
        }
        if (url.includes('/pulls/1')) {
          if (bindingStatus === 'unknown') throw new Error('PR metadata unavailable')
          return response({
            head: { sha: intendedSha, repo: { fork: false } },
            base: { sha: 'base-sha' },
            author_association: 'MEMBER',
            labels: [],
          })
        }
        if (url.includes('/compare/')) {
          return response({ merge_base_commit: { sha: 'base-sha' } })
        }
        if (url.includes('/check-runs')) {
          return response({ check_runs: [] })
        }
        throw new Error(`unexpected fetch: ${url}`)
      })

      const client: VisionClient = {
        complete: async (_opts: {
          model: string
          messages: Message[]
          schema?: JsonSchema
          escalationModels?: string[]
          provider?: ProviderRules
          kind?: string
        }) => ({
          id: 'stub',
          content: JSON.stringify({ summary: 'reviewed', verdict: 'approve', findings: [] }),
          cost: {
            model: 'test/model',
            provider: 'stub',
            tokens: 1,
            costUsd: 0,
            kind: 'code',
          } as CallCost,
          model: 'test/model',
        }),
      }
      try {
        const code = await main(['code-review', '--report-dir', reportDir], {
          cwd,
          env: {
            PATH: process.env.PATH ?? '',
            HOME: process.env.HOME ?? '',
            GITHUB_REPOSITORY: 'o/r',
            GITHUB_TOKEN: 'token',
            OPENROUTER_API_KEY: 'test-key',
            ARGUS_REVIEWER_TRACE: JSON.stringify({
              repo: 'o/r',
              pr: '1',
              ...(intendedSha !== undefined ? { commit: intendedSha } : {}),
            }),
          },
          out: () => undefined,
          err: () => undefined,
          createClient: () => client,
        })
        expect(code).toBe(0)
        const report = JSON.parse(await readFile(join(reportDir, 'code-review.json'), 'utf8')) as {
          ok: boolean
          headBinding: { status: string; intendedSha: string; checkoutSha: string }
          summary: string
        }
        expect(report.headBinding).toMatchObject({
          status: bindingStatus,
          ...(intendedSha !== undefined ? { intendedSha } : {}),
          checkoutSha,
        })
        expect(report.ok).toBe(false)
        expect(report.summary).toContain('Head binding inconclusive')
      } finally {
        vi.unstubAllGlobals()
      }
    },
  )
})
