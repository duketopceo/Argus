import { describe, expect, it } from 'vitest'

import { DecisionClient } from '../../src/vision/decisions.js'
import {
  materializeMergeBaseDiff,
  MAX_CANDIDATES,
  scanDiffForSecrets,
  scanSecrets,
} from '../../src/review/secrets.js'
import type { ExecFn } from '../../src/detect.js'

// Credential-shaped literals are built by concatenation — a static
// provider-shaped string trips GitHub push protection.
const SK_LIVE = `sk${'_live_'}${'Fixt'.repeat(6)}`
const SK_LIVE_REMOVED = `sk${'_live_'}${'dead'.repeat(6)}`
const AKIA = `AKIA${'IOSFODNN7EXAMPLE'}`

const DIFF = [
  'diff --git a/docs/keys.md b/docs/keys.md',
  '--- a/docs/keys.md',
  '+++ b/docs/keys.md',
  '@@ -1,2 +1,3 @@',
  ' existing context line',
  `+AWS example: ${AKIA} is documented`,
  '+more context',
  'diff --git a/.env.production b/.env.production',
  '--- /dev/null',
  '+++ b/.env.production',
  '@@ -0,0 +1,2 @@',
  `+STRIPE_KEY=${SK_LIVE}`,
  '+OTHER=value',
  `-REMOVED_KEY=${SK_LIVE_REMOVED}`,
].join('\n')

function jevClient(noulByIdx: number[]): DecisionClient {
  const f = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      questions: Record<string, unknown>
    }
    const answers: Record<string, { noul: number }> = {}
    Object.keys(body.questions).forEach((id) => {
      const idx = parseInt(id.replace('cand_', ''), 10)
      answers[id] = { noul: noulByIdx[idx] ?? 0 }
    })
    return new Response(
      JSON.stringify({
        answers,
        model: 'typesafe/jev-1.13-20260917',
        usage: { input_tokens: 100, output_tokens: 10, cost: 0.00001 },
      }),
      { status: 200 },
    )
  }) as unknown as typeof fetch
  return new DecisionClient({ apiKey: 'k', fetch: f })
}

function failingClient(): DecisionClient {
  const f = (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch
  return new DecisionClient({ apiKey: 'k', fetch: f })
}

describe('scanDiffForSecrets', () => {
  it('finds secret-shaped literals on added lines with file+line positions', () => {
    const cands = scanDiffForSecrets(DIFF)
    expect(cands).toHaveLength(2)
    expect(cands[0]).toMatchObject({ file: 'docs/keys.md', line: 2, patternClass: 'aws-access-key' })
    expect(cands[1]).toMatchObject({
      file: '.env.production',
      line: 1,
      patternClass: 'stripe-live',
    })
  })

  it('does not scan removed or context lines', () => {
    const cands = scanDiffForSecrets(DIFF)
    expect(cands.every((c) => !c.literal.includes('dead'))).toBe(true)
  })

  it('masks the literal inside contextExcerpt', () => {
    const cands = scanDiffForSecrets(DIFF)
    expect(cands[1]?.contextExcerpt).toContain('***')
    expect(cands[1]?.contextExcerpt).not.toContain(SK_LIVE)
  })

  it('detects private keys, github pats, slack tokens, jwt, generic assignments', () => {
    const diff = [
      '+++ b/f.txt',
      '@@ -0,0 +1,6 @@',
      '+-----BEGIN OPENSSH PRIVATE KEY-----',
      `+tok = ghp_${'abcdefghijklmnopqrstuvwxyz0123456789'}`,
      `+x = xoxb-${'123456789012-abcdefghij'}`,
      `+jwt = eyJ${'hbGciOiJIUzI1NiJ9'}.eyJ${'zdWIiOiIxMjM0NTY3ODkwIn0'}.${'abc123def456'}`,
      '+api_key = "abcd1234efgh5678"',
      '+password = "hunter2"',
    ].join('\n')
    const cands = scanDiffForSecrets(diff)
    const classes = cands.map((c) => c.patternClass)
    expect(classes).toContain('private-key')
    expect(classes).toContain('github-pat')
    expect(classes).toContain('slack-token')
    expect(classes).toContain('jwt')
    expect(classes).toContain('generic-assignment')
    // hunter2 is 7 chars — below the 12-char generic-assignment floor.
    expect(cands.filter((c) => c.literal === 'hunter2')).toHaveLength(0)
  })
})

describe('scanSecrets', () => {
  it('Jev below threshold → suppressed audit record, no finding', async () => {
    const r = await scanSecrets({
      diff: DIFF,
      client: jevClient([0.03, 0.03]),
      threshold: 0.3,
    })
    expect(r.findings).toHaveLength(0)
    expect(r.records).toHaveLength(2)
    expect(r.records.every((rec) => rec.suppressed === true && rec.adjudicated)).toBe(true)
    expect(JSON.stringify(r)).not.toContain(AKIA)
    expect(JSON.stringify(r)).not.toContain(SK_LIVE)
  })

  it('Jev at/above threshold → masked bug finding', async () => {
    const r = await scanSecrets({
      diff: DIFF,
      client: jevClient([0.03, 0.85]),
      threshold: 0.3,
    })
    expect(r.findings).toHaveLength(1)
    expect(r.findings[0]).toMatchObject({ file: '.env.production', severity: 'bug' })
    expect(r.records[0]?.suppressed).toBe(true)
    expect(r.records[1]?.pLive).toBe(0.85)
    expect(JSON.stringify(r.findings)).not.toContain(SK_LIVE)
  })

  it('Jev failure → every candidate unadjudicated risk finding, nothing suppressed', async () => {
    const r = await scanSecrets({ diff: DIFF, client: failingClient() })
    expect(r.findings).toHaveLength(2)
    expect(r.findings.every((f) => f.severity === 'risk')).toBe(true)
    expect(r.records.every((rec) => rec.adjudicated === false && rec.suppressed === undefined)).toBe(
      true,
    )
  })

  it('no client (decisionModel unset) → regex-only unadjudicated mode', async () => {
    const r = await scanSecrets({ diff: DIFF })
    expect(r.findings).toHaveLength(2)
    expect(r.records.every((rec) => rec.adjudicated === false)).toBe(true)
  })

  it('caps candidates at MAX_CANDIDATES and reports overflow count-only', async () => {
    const many = Array.from(
      { length: MAX_CANDIDATES + 25 },
      (_, i) => `+token = "abcd1234efgh5678ijkl${i}"`,
    )
    const diff = ['+++ b/f.txt', '@@ -0,0 +1,75 @@', ...many].join('\n')
    const r = await scanSecrets({ diff })
    expect(r.records).toHaveLength(MAX_CANDIDATES)
    expect(r.overflow).toBe(25)
  })
})

describe('materializeMergeBaseDiff', () => {
  it('returns the git diff when the base object exists', async () => {
    const exec: ExecFn = async (_cmd, args) => {
      if (args.includes('cat-file')) return { code: 0, stdout: '', stderr: '' }
      if (args.includes('diff')) return { code: 0, stdout: 'diff body', stderr: '' }
      return { code: 1, stdout: '', stderr: 'unexpected' }
    }
    const r = await materializeMergeBaseDiff({ cwd: '/x', baseSha: 'abc123', exec })
    expect(r).toEqual({ diff: 'diff body' })
  })

  it('fetches a missing base with token env, never in argv', async () => {
    let sawFetch = false
    const exec: ExecFn = async (_cmd, args, _t, env) => {
      if (args.includes('cat-file')) return { code: 1, stdout: '', stderr: '' }
      if (args.includes('fetch')) {
        sawFetch = true
        expect(args.join(' ')).not.toContain('x-access-token')
        const b64 = env?.GIT_CONFIG_VALUE_0?.split(' ').pop() ?? ''
        expect(Buffer.from(b64, 'base64').toString()).toBe('x-access-token:tok')
        return { code: 0, stdout: '', stderr: '' }
      }
      if (args.includes('diff')) return { code: 0, stdout: 'd', stderr: '' }
      return { code: 1, stdout: '', stderr: '' }
    }
    const r = await materializeMergeBaseDiff({ cwd: '/x', baseSha: 'abc123', token: 'tok', exec })
    expect(sawFetch).toBe(true)
    expect(r).toEqual({ diff: 'd' })
  })

  it('missing base + no token → skipped reason, zero silent loss', async () => {
    const exec: ExecFn = async () => ({ code: 1, stdout: '', stderr: '' })
    const r = await materializeMergeBaseDiff({ cwd: '/x', baseSha: 'abc123', exec })
    expect(r).toMatchObject({ skipped: expect.stringContaining('abc123') })
  })

  it('fetch failure → skipped reason', async () => {
    const exec: ExecFn = async () => ({ code: 1, stdout: '', stderr: 'fetch failed' })
    const r = await materializeMergeBaseDiff({ cwd: '/x', baseSha: 'abc123', token: 't', exec })
    expect(r).toMatchObject({ skipped: expect.any(String) })
  })
})
