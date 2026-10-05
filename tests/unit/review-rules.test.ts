import { describe, expect, it } from 'vitest'

import { parseRuleIds, resolveConfig } from '../../src/config.js'
import {
  REVIEW_RULE_IDS,
  REVIEW_RULES,
  RULE_HITS_CAP,
  runRules,
  type ReviewRule,
} from '../../src/review/rules.js'

/** Unified diff adding `added` lines to `file` (post-change line numbering). */
function diffOf(file: string, added: string[]): string {
  const body = added.map((l) => `+${l}`).join('\n')
  return (
    `diff --git a/${file} b/${file}\n` +
    `--- a/${file}\n+++ b/${file}\n` +
    `@@ -0,0 +1,${added.length} @@\n${body}\n`
  )
}

describe('runRules', () => {
  it('happy: hardcoded IP URL in code becomes a nit finding citing the pattern class', async () => {
    const r = await runRules(diffOf('src/server.ts', [`const api = 'http://10.0.0.5:8080/v1'`]))
    const hit = r.findings.find((f) => f.severity === 'nit' && f.category === 'security')
    expect(hit?.file).toBe('src/server.ts')
    expect(hit?.line).toBe(1)
    expect(hit?.message).toContain('url-with-ip-host')
    expect(r.records).toContainEqual(
      expect.objectContaining({ rule: 'hardcoded-endpoint', file: 'src/server.ts', line: 1 }),
    )
    expect(r.ran).toEqual(expect.arrayContaining(REVIEW_RULE_IDS))
  })

  it('hardcoded bare-IP assignment is a nit finding', async () => {
    const r = await runRules(diffOf('src/db.ts', [`const host = "10.1.2.3"`]))
    expect(r.findings.some((f) => f.message.includes('ip-literal-assignment'))).toBe(true)
  })

  it('loopback and unspecified addresses are suppressed, not findings', async () => {
    const r = await runRules(
      diffOf('src/server.ts', [
        `const dev = 'http://127.0.0.1:3000'`,
        `const host = "0.0.0.0"`,
      ]),
    )
    expect(r.findings).toHaveLength(0)
    expect(r.records.filter((x) => x.rule === 'hardcoded-endpoint')).toHaveLength(2)
    expect(r.records.every((x) => x.suppressed === 'loopback/unspecified host')).toBe(true)
  })

  it('edge: a match inside a sample manifest is suppressed as data-not-code', async () => {
    const r = await runRules(
      diffOf('fixtures/sample.yaml', [`endpoint: http://10.0.0.9:8080`]),
    )
    expect(r.findings.filter((f) => f.category === 'security')).toHaveLength(0)
    expect(r.records).toContainEqual(
      expect.objectContaining({
        rule: 'hardcoded-endpoint',
        file: 'fixtures/sample.yaml',
        suppressed: 'data/prose path',
      }),
    )
  })

  it('TODO markers in code are nits; in docs they are suppressed', async () => {
    const r = await runRules(
      diffOf('src/x.ts', [`// TODO: wire retry`]) + diffOf('docs/guide.md', [`TODO: fill in`]),
    )
    const todo = r.findings.filter((f) => f.category === 'maintainability')
    expect(todo).toHaveLength(1)
    expect(todo[0]?.file).toBe('src/x.ts')
    expect(r.records).toContainEqual(
      expect.objectContaining({
        rule: 'leftover-todo',
        file: 'docs/guide.md',
        suppressed: 'data/prose path',
      }),
    )
  })

  it('sync calls are nits in src but suppressed in tests and scripts', async () => {
    const r = await runRules(
      diffOf('src/io.ts', [`const data = readFileSync(p)`]) +
        diffOf('scripts/build.mjs', [`execSync('tsc')`]) +
        diffOf('tests/unit/x.test.ts', [`const f = readFileSync('golden')`]),
    )
    const sync = r.findings.filter((f) => f.category === 'performance')
    expect(sync).toHaveLength(1)
    expect(sync[0]?.file).toBe('src/io.ts')
    expect(
      r.records.filter(
        (x) => x.rule === 'sync-in-async' && x.suppressed === 'non-production path',
      ),
    ).toHaveLength(2)
  })

  it('the secrets rule runs through the registry and reports via secretsScan', async () => {
    const r = await runRules(
      diffOf('src/keys.ts', [`const key = 'AKIAIOSFODNN7EXAMPLE'`]),
    )
    expect(r.secretsScan).toBeDefined()
    expect(r.secretsScan?.records).toHaveLength(1)
    // Unadjudicated (no client) — risk, never bug.
    const hit = r.findings.find((f) => f.file === 'src/keys.ts')
    expect(hit?.severity).toBe('risk')
    expect(hit?.p).toBeUndefined()
    expect(r.records).toContainEqual(
      expect.objectContaining({ rule: 'secrets', detail: 'aws-access-key' }),
    )
  })

  it('error: a throwing rule records a failure and the lane completes', async () => {
    const throwing: ReviewRule = {
      id: 'explodes',
      description: 'test rule',
      run() {
        throw new Error('kaboom')
      },
    }
    const todoRule = REVIEW_RULES.find((r) => r.id === 'leftover-todo')
    const r = await runRules(diffOf('src/x.ts', [`// TODO: x`]), {
      rules: [throwing, ...(todoRule !== undefined ? [todoRule] : [])],
      enabled: ['explodes', 'leftover-todo'],
    })
    expect(r.failures).toEqual([{ rule: 'explodes', error: 'kaboom' }])
    // Failures are the audit channel — no double-record under records.
    expect(r.records.some((x) => x.rule === 'explodes')).toBe(false)
    // The surviving rule still produced its finding.
    expect(r.findings.some((f) => f.category === 'maintainability')).toBe(true)
  })

  it('a swapped-in registry runs by default when enabled is omitted', async () => {
    const custom: ReviewRule = {
      id: 'custom-rule',
      description: 'test rule',
      run: () => ({
        findings: [{ file: 'src/x.ts', severity: 'nit', message: 'custom ran' }],
        records: [],
      }),
    }
    const r = await runRules(diffOf('src/x.ts', [`anything`]), { rules: [custom] })
    expect(r.ran).toEqual(['custom-rule'])
    expect(r.findings.some((f) => f.message === 'custom ran')).toBe(true)
  })

  it('severity ceiling: an unadjudicated bug claim is demoted to risk and audited', async () => {
    const loud: ReviewRule = {
      id: 'loud',
      description: 'test rule',
      run: () => ({
        findings: [{ file: 'src/x.ts', line: 1, severity: 'bug', message: 'claims bug' }],
        records: [],
      }),
    }
    const r = await runRules(diffOf('src/x.ts', [`const a = 1`]), {
      rules: [loud],
      enabled: ['loud'],
    })
    expect(r.findings[0]?.severity).toBe('risk')
    expect(r.records).toContainEqual(
      expect.objectContaining({ rule: 'loud', suppressed: 'severity-ceiling' }),
    )
  })

  it('adjudicated bug claims (p present) keep bug severity', async () => {
    const proven: ReviewRule = {
      id: 'proven',
      description: 'test rule',
      run: () => ({
        findings: [{ file: 'src/x.ts', line: 1, severity: 'bug', message: 'proven', p: 0.9 }],
        records: [],
      }),
    }
    const r = await runRules(diffOf('src/x.ts', [`const a = 1`]), {
      rules: [proven],
      enabled: ['proven'],
    })
    expect(r.findings[0]?.severity).toBe('bug')
  })

  it('enabled: a subset list runs only those rules', async () => {
    const r = await runRules(diffOf('src/x.ts', [`const key = 'AKIAIOSFODNN7EXAMPLE'`]), {
      enabled: ['leftover-todo'],
    })
    expect(r.ran).toEqual(['leftover-todo'])
    expect(r.secretsScan).toBeUndefined()
    expect(r.findings).toHaveLength(0)
  })

  it('enabled: [] disables the lane entirely', async () => {
    const r = await runRules(diffOf('src/x.ts', [`const key = 'AKIAIOSFODNN7EXAMPLE'`]), {
      enabled: [],
    })
    expect(r.ran).toEqual([])
    expect(r.findings).toEqual([])
    expect(r.secretsScan).toBeUndefined()
  })

  it('hit cap: findings truncate at the cap with an aggregate overflow finding', async () => {
    const spam: ReviewRule = {
      id: 'spam',
      description: 'test rule',
      run: () => ({
        findings: Array.from({ length: RULE_HITS_CAP + 3 }, (_, i) => ({
          file: 'src/x.ts',
          line: i + 1,
          severity: 'nit',
          message: `hit ${i}`,
        })),
        records: Array.from({ length: RULE_HITS_CAP + 3 }, (_, i) => ({
          file: 'src/x.ts',
          line: i + 1,
          detail: `hit ${i}`,
        })),
      }),
    }
    const r = await runRules(diffOf('src/x.ts', [`const a = 1`]), {
      rules: [spam],
      enabled: ['spam'],
    })
    expect(r.findings).toHaveLength(RULE_HITS_CAP + 1) // cap + aggregate
    expect(r.findings.at(-1)?.message).toContain('over the')
    // Records stay complete — every hit is an audit entry.
    expect(r.records.filter((x) => x.rule === 'spam' && x.detail.startsWith('hit'))).toHaveLength(
      RULE_HITS_CAP + 3,
    )
  })
})

describe('parseRuleIds + config wiring', () => {
  it('accepts registered ids and defaults to all when unset', () => {
    expect(parseRuleIds(undefined)).toEqual(REVIEW_RULE_IDS)
    expect(parseRuleIds(['secrets', 'leftover-todo'])).toEqual(['secrets', 'leftover-todo'])
  })

  it('rejects unknown ids naming the entry', () => {
    expect(() => parseRuleIds(['secrts'])).toThrow(/review\.rules\[0\].*secrts/)
    expect(() => parseRuleIds('secrets')).toThrow(/must be an array/)
  })

  it('resolveConfig wires review.rules end to end', () => {
    expect(resolveConfig({ review: { rules: ['leftover-todo'] } }).review.rules).toEqual([
      'leftover-todo',
    ])
    expect(resolveConfig({}).review.rules).toEqual(REVIEW_RULE_IDS)
    expect(() => resolveConfig({ review: { rules: ['nope'] } })).toThrow(/nope/)
  })
})
