import { describe, expect, it } from 'vitest'

import { parseRuleIds, resolveConfig } from '../../src/config.js'
import {
  REVIEW_RULE_IDS,
  REVIEW_RULES,
  RULE_HITS_CAP,
  RULE_RECORDS_CAP,
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
    expect(r.findings.filter((f) => f.category === 'security')).toHaveLength(0)
    expect(r.records.filter((x) => x.rule === 'hardcoded-endpoint')).toHaveLength(2)
    expect(
      r.records
        .filter((x) => x.rule === 'hardcoded-endpoint')
        .every((x) => x.suppressed === 'loopback/unspecified host'),
    ).toBe(true)
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
    const todo = r.findings.filter((f) => f.category === 'convention')
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
    expect(r.findings.some((f) => f.category === 'convention')).toBe(true)
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

  it('record cap: over-cap records collapse into a count-preserving aggregate', async () => {
    const flood: ReviewRule = {
      id: 'flood',
      description: 'test rule',
      run: () => ({
        findings: [],
        records: Array.from({ length: RULE_RECORDS_CAP + 7 }, (_, i) => ({
          file: 'src/x.ts',
          line: i + 1,
          detail: `hit ${i}`,
        })),
      }),
    }
    const r = await runRules(diffOf('src/x.ts', [`const a = 1`]), {
      rules: [flood],
      enabled: ['flood'],
    })
    expect(r.records.filter((x) => x.detail.startsWith('hit'))).toHaveLength(RULE_RECORDS_CAP)
    const agg = r.records.find((x) => x.suppressed === 'record-cap')
    expect(agg?.detail).toBe(`7 hit(s) over the ${RULE_RECORDS_CAP}-record cap`)
  })

  it('a demoted bug claim rewrites the `bug:` message prefix, never emits it', async () => {
    const loud: ReviewRule = {
      id: 'loud',
      description: 'test rule',
      run: () => ({
        findings: [
          { file: 'src/x.ts', line: 1, severity: 'bug', message: 'L1: bug: claims loudly' },
        ],
        records: [],
      }),
    }
    const r = await runRules(diffOf('src/x.ts', [`const a = 1`]), {
      rules: [loud],
      enabled: ['loud'],
    })
    expect(r.findings[0]?.severity).toBe('risk')
    // Severity-derived readers parse the prefix — demoted text must not
    // still claim `bug:`.
    expect(r.findings[0]?.message).not.toContain('bug:')
    expect(r.findings[0]?.message).toContain('risk:')
  })

  it('the runner stamps rule provenance, overwriting any spoofed field', async () => {
    const spoofer: ReviewRule = {
      id: 'real-rule',
      description: 'test rule',
      run: () => ({
        findings: [
          {
            file: 'src/x.ts',
            line: 1,
            severity: 'nit',
            message: 'spoofed',
            rule: 'secrets',
          } as never,
        ],
        records: [{ file: 'src/x.ts', detail: 'x', rule: 'secrets' } as never],
      }),
    }
    const r = await runRules(diffOf('src/x.ts', [`const a = 1`]), {
      rules: [spoofer],
      enabled: ['real-rule'],
    })
    expect(r.findings[0]?.rule).toBe('real-rule')
    expect(r.records.find((x) => x.detail === 'x')?.rule).toBe('real-rule')
  })

  it('a malformed RuleOutput resolves into failures, not a crash', async () => {
    const bad = (out: unknown): ReviewRule => ({
      id: 'bad',
      description: 'test rule',
      run: () => out as never,
    })
    for (const out of [undefined, { findings: 'x' }, { records: [], findings: undefined }, 'str']) {
      const r = await runRules(diffOf('src/x.ts', [`const a = 1`]), {
        rules: [bad(out)],
        enabled: ['bad'],
      })
      expect(r.failures).toEqual([
        { rule: 'bad', error: 'malformed RuleOutput (needs { findings, records })' },
      ])
      expect(r.findings).toEqual([])
    }
  })

  it('an async rule rejection is a failure, not a lane abort', async () => {
    const rejecting: ReviewRule = {
      id: 'rejects',
      description: 'test rule',
      run: async () => {
        throw new Error('async kaboom')
      },
    }
    const r = await runRules(diffOf('src/x.ts', [`const a = 1`]), {
      rules: [rejecting],
      enabled: ['rejects'],
    })
    expect(r.failures).toEqual([{ rule: 'rejects', error: 'async kaboom' }])
    expect(r.ran).toEqual(['rejects'])
  })

  it('a dotted-quad-prefixed domain is not an IP — no loopback suppression bypass', async () => {
    const r = await runRules(
      diffOf('src/u.ts', [`const u = 'https://127.0.0.1.evil.com/x'`]),
    )
    // The captured `127.0.0.1` prefix must not suppress: this is a domain
    // literal, so the rule records/fires nothing (not a bare-IP hit).
    expect(
      r.records.filter((x) => x.rule === 'hardcoded-endpoint'),
    ).toHaveLength(0)
    expect(r.findings.filter((f) => f.message.includes('hardcoded'))).toHaveLength(0)
  })

  it('quoted `+++ "b/..."` headers attribute hits to the decoded path', async () => {
    const diff =
      'diff --git "a/my f.ts" "b/my f.ts"\n' +
      '--- "a/my f.ts"\n' +
      '+++ "b/my f.ts"\n' +
      '@@ -0,0 +1 @@\n' +
      '+const host = "10.9.8.7"\n'
    const r = await runRules(diff)
    const hit = r.findings.find((f) => f.message.includes('hardcoded'))
    expect(hit?.file).toBe('my f.ts')
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

// U5 coverage rules — dep-diff and missing-test. The fixture diffs carry
// context and removed lines because dep-diff tracks deps-block membership.
const PKG_DIFF =
  'diff --git a/package.json b/package.json\n' +
  '--- a/package.json\n+++ b/package.json\n' +
  '@@ -1,8 +1,10 @@\n' +
  ' {\n' +
  '   "name": "app",\n' +
  '   "dependencies": {\n' +
  '-    "left-pad": "^1.0.0",\n' +
  '+    "left-pad": "^2.0.0",\n' +
  '+    "new-lib": "^0.4.1",\n' +
  '+    "right-pad": "^1.1.0"\n' +
  '-    "right-pad": "^1.0.0",\n' +
  '   },\n' +
  '   "devDependencies": {\n' +
  '+    "vitest": "^4.0.0"\n' +
  '   }\n' +
  ' }\n'

describe('dep-diff', () => {
  it('new dependency and major bump are nit findings; minor bump is record-only', async () => {
    const r = await runRules(PKG_DIFF)
    const msgs = r.findings.map((f) => f.message).join('\n')
    expect(msgs).toContain('new dependency `new-lib@^0.4.1`')
    expect(msgs).toContain('new dependency `vitest@^4.0.0`')
    expect(msgs).toContain('major version jump `left-pad ^1.0.0 -> ^2.0.0`')
    expect(msgs).not.toContain('right-pad')
    expect(r.records).toContainEqual(
      expect.objectContaining({ rule: 'dep-diff', detail: 'version-jump right-pad ^1.0.0->^1.1.0', suppressed: 'minor/patch bump' }),
    )
  })

  it('mid-block adds without a visible opener still flag version-spec values', async () => {
    // Real failure mode: esbuild landed deep inside devDependencies, so the
    // block opener was outside the hunk's context window.
    const diff =
      'diff --git a/package.json b/package.json\n' +
      '--- a/package.json\n+++ b/package.json\n' +
      '@@ -58,6 +60,7 @@\n' +
      '     "@resvg/resvg-js": "^2.6.2",\n' +
      '     "@types/node": "^26.6.2",\n' +
      '     "electron": "^44.2.0",\n' +
      '+    "esbuild": "^0.28.2",\n' +
      '     "eslint": "^10.11.0",\n' +
      '     "globals": "^17.12.0"\n' +
      '@@ -30,4 +31,5 @@\n' +
      '     "build": "tsc -p tsconfig.build.json",\n' +
      '+    "build:parity": "esbuild action/parity-entry.mjs --bundle",\n' +
      '     "test": "vitest run"\n'
    const r = await runRules(diff)
    const msgs = r.findings.map((f) => f.message).join('\n')
    expect(msgs).toContain('new dependency `esbuild@^0.28.2`')
    expect(msgs).not.toContain('build:parity')
  })

  it('second-hunk dep entries carry their own line numbers', async () => {
    // diffLines must reset newLine on every @@ header — a second-hunk add
    // used to inherit the first hunk's offset and point at a wrong line.
    const diff =
      'diff --git a/package.json b/package.json\n' +
      '--- a/package.json\n+++ b/package.json\n' +
      '@@ -10,4 +10,5 @@\n' +
      '     "a": "^1.0.0",\n' +
      '+    "dep-one": "^1.0.0",\n' +
      '     "b": "^1.0.0"\n' +
      '@@ -200,4 +201,5 @@\n' +
      '     "c": "^1.0.0",\n' +
      '+    "dep-two": "^2.0.0",\n' +
      '     "d": "^1.0.0"\n'
    const r = await runRules(diff)
    const two = r.findings.find((f) => f.message.includes('dep-two'))
    expect(two?.line).toBe(202)
  })

  it('deps-block state does not leak across hunks', async () => {
    // An unclosed deps opener in hunk 1 used to keep blockIsDeps=true into
    // hunk 2, letting a mid-scripts command bypass the version-spec gate
    // and fabricate a "new dependency" finding.
    const diff =
      'diff --git a/package.json b/package.json\n' +
      '--- a/package.json\n+++ b/package.json\n' +
      '@@ -10,5 +10,6 @@\n' +
      '   "dependencies": {\n' +
      '     "a": "^1.0.0",\n' +
      '+    "dep-one": "^1.0.0",\n' +
      '     "b": "^1.0.0",\n' +
      '@@ -60,4 +61,5 @@\n' +
      '     "build": "tsc",\n' +
      '+    "fmt": "prettier --write .",\n' +
      '     "test": "vitest run"\n'
    const r = await runRules(diff)
    const msgs = r.findings.map((f) => f.message).join('\n')
    expect(msgs).toContain('dep-one')
    expect(msgs).not.toContain('fmt')
    expect(r.findings.filter((f) => f.category === 'dependencies')).toHaveLength(1)
  })

  it('non-version-spec entries and metadata keys are ignored', async () => {
    const diff =
      'diff --git a/package.json b/package.json\n' +
      '--- a/package.json\n+++ b/package.json\n' +
      '@@ -1,3 +1,4 @@\n' +
      ' {\n' +
      '+  "version": "2.0.0",\n' +
      '+  "new-lib": "not-a-dep",\n' +
      '   "name": "app"\n' +
      ' }\n'
    const r = await runRules(diff)
    expect(r.findings.filter((f) => f.category === 'dependencies')).toHaveLength(0)
  })

  it('fixture manifests are suppressed with a record', async () => {
    const diff =
      'diff --git a/fixtures/pkg/package.json b/fixtures/pkg/package.json\n' +
      '--- a/fixtures/pkg/package.json\n+++ b/fixtures/pkg/package.json\n' +
      '@@ -1,4 +1,5 @@\n' +
      ' {\n' +
      '   "dependencies": {\n' +
      '+    "new-lib": "^1.0.0"\n' +
      '   }\n' +
      ' }\n'
    const r = await runRules(diff)
    expect(r.findings.filter((f) => f.category === 'dependencies')).toHaveLength(0)
    expect(r.records).toContainEqual(
      expect.objectContaining({ rule: 'dep-diff', suppressed: 'data/prose path' }),
    )
  })
})

describe('missing-test', () => {
  it('source-only diff gets one nit on the highest-churn file', async () => {
    const diff = diffOf('src/a.ts', ['const a = 1', 'const b = 2', 'const c = 3']) +
      diffOf('src/b.ts', ['const x = 1'])
    const r = await runRules(diff)
    const hit = r.findings.find((f) => f.category === 'testing')
    expect(hit?.file).toBe('src/a.ts')
    expect(hit?.message).toContain('2 source file(s)')
  })

  it('any test-file change silences the rule', async () => {
    const diff = diffOf('src/a.ts', ['const a = 1']) +
      diffOf('tests/a.test.ts', ['test(1)'])
    const r = await runRules(diff)
    expect(r.findings.filter((f) => f.category === 'testing')).toHaveLength(0)
  })

  it('docs-only and generated-only diffs do not fire', async () => {
    const r = await runRules(
      diffOf('docs/guide.md', ['# hi']) + diffOf('dist/index.js', ['x()']),
    )
    expect(r.findings.filter((f) => f.category === 'testing')).toHaveLength(0)
  })

  it.each(['scripts/gen.ts', 'fixtures/f.ts', 'dist/gen.ts'])(
    'excluded path %s does not fire (isolates each predicate)',
    async (path) => {
      const r = await runRules(diffOf(path, ['const x = 1']))
      expect(r.findings.filter((f) => f.category === 'testing')).toHaveLength(0)
    },
  )
})
