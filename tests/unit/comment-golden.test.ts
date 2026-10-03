import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// @ts-expect-error plain-node action helper, no type declarations
import * as sticky from '../../action/sticky-comment.cjs'
import {
  renderCommentHead,
  renderManifestComment,
  renderMissingKeyComment,
  SENTINEL,
  type CommentInput,
} from '../../src/report/comment.js'
import type { RunManifest } from '../../src/report/manifest.js'
import * as vocab from '../../src/report/viewmodel.js'
import { renderReviewComments, type ReviewFinding } from '../../src/cli.js'

/**
 * Comment goldens (plan U4, KTD3). Each fixture in fixtures/manifests/ is one
 * sticky-comment input; the action renderer (action/sticky-comment.cjs) turns
 * it into the committed markdown under tests/goldens/comment/. Review the
 * rendered diff, then regenerate with:
 *
 *   UPDATE_GOLDENS=1 npx vitest run tests/unit/comment-golden.test.ts
 *
 * The TS reference renderer (src/report/comment.ts) must agree with the
 * golden's first screen for every fixture, and with the whole body for
 * manifest-only fixtures.
 */

const ROOT = join(import.meta.dirname, '..', '..')
const FIXTURES = join(ROOT, 'fixtures', 'manifests')
const GOLDENS = join(ROOT, 'tests', 'goldens', 'comment')
const UPDATE = process.env.UPDATE_GOLDENS === '1'

interface Fixture extends CommentInput {
  $comment: string
  version: string
  runUrl: string
  prHeadSha?: string
  /** File text of run-manifest.json; null means the file is absent. */
  manifestRaw?: string | null
  inlinePlan?: unknown
}

function load(name: string): Fixture {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8')) as Fixture
}

/** Fixtures rendered through a body renderer directly (U4, plus U5's oversize). */
const RENDERED = ['passed', 'failed', 'mixed-four-lane', 'review-only', 'missing-key', 'hostile', 'oversize']
/** U5 manifest states: rendered through the action's body selection (renderSticky). */
const DEGRADED = ['stale', 'corrupt', 'missing-manifest']
const ALL = [...RENDERED, ...DEGRADED]

const BUDGET = 20 * 1024
const RUN_NONCE = '123456'

function renderCjs(f: Fixture): string {
  const meta = { version: f.version, runUrl: f.runUrl }
  if (f.manifestRaw !== undefined || f.prHeadSha !== undefined) {
    const raw = f.manifestRaw === null ? undefined : (f.manifestRaw ?? JSON.stringify(f.manifest))
    const manifestState = sticky.resolveManifest(raw, { headSha: f.prHeadSha, nonce: RUN_NONCE })
    return sticky.renderSticky(
      {
        hasKey: true,
        runDisabled: false,
        eventName: 'pull_request',
        report: f.report,
        codeReview: f.codeReview,
        manifestState,
        ok: f.ok,
        reportDir: 'argus-reviewer-report',
        staleEvidence: [],
        runUrl: f.runUrl,
      },
      meta,
    ) as string
  }
  switch (f.body) {
    case 'missing-key':
      return sticky.renderMissingKeyBody(meta) as string
    case 'no-report':
      return sticky.renderNoReportBody(f.reportDir, f.runUrl, meta) as string
    case 'manifest':
      return sticky.renderManifestBody(f.manifest, f.codeReview, f.runUrl, meta) as string
    case 'review-only':
      return sticky.renderReviewOnlyBody(f.codeReview, f.runUrl, f.ok, f.inlinePlan, f.manifest, meta) as string
    case 'full':
      return sticky.renderBody(f.report, f.codeReview, f.runUrl, f.ok, f.inlinePlan, f.manifest, meta) as string
  }
}

/** Lines before the first fold (the first screen), sentinel included. */
function firstScreen(body: string): string[] {
  const lines = body.split('\n')
  const fold = lines.findIndex((l) => l.startsWith('<details>'))
  const footer = lines.findIndex((l) => l.startsWith('<sub>'))
  const end = fold === -1 ? footer : fold
  return lines.slice(0, end === -1 ? lines.length : end)
}

function laneTable(body: string): string[] {
  return body.split('\n').filter((l) => /^\| [^|]+ \| (review|flow|app|a0) \|/.test(l))
}

const EMOJI = /\p{Extended_Pictographic}|\u{FE0F}|[\u{1F1E6}-\u{1F1FF}]/u

describe('comment goldens (U4)', () => {
  it('has a fixture for every planned state and a golden for every rendered one', () => {
    const names = readdirSync(FIXTURES).map((f) => f.replace(/\.json$/, '')).sort()
    expect(names).toEqual([...ALL].sort())
  })

  it.each(ALL)('%s renders exactly its golden', (name) => {
    const body = renderCjs(load(name))
    const path = join(GOLDENS, `${name}.md`)
    if (UPDATE || !existsSync(path)) {
      if (!UPDATE) throw new Error(`missing golden ${path}; run with UPDATE_GOLDENS=1`)
      writeFileSync(path, body)
    }
    expect(body).toBe(readFileSync(path, 'utf8'))
  })

  it.each(ALL)('%s follows the R6 grammar with a first screen of at most 12 lines', (name) => {
    const body = renderCjs(load(name))
    const lines = body.split('\n')
    expect(lines[0]).toBe(SENTINEL)
    expect(body.split(SENTINEL)).toHaveLength(2)
    // Non-blank lines after the sentinel, in order: header, verdict line,
    // lane table (head, rule, rows), findings summary, then folds or footer.
    const content = lines.slice(1).filter((l) => l !== '')
    expect(content[0]).toMatch(/^### Argus: \S+ [a-z][a-z ]*$/)
    expect(content[1]).toMatch(/^\*\*/)
    expect(content[2]).toBe('| Status | Lane | Result | Proof | Spend |')
    expect(content[3]).toBe('|---|---|---|---|--:|')
    let i = 4
    while (content[i]?.startsWith('| ')) i++
    expect(i).toBeGreaterThan(4)
    const summary = content[i]!
    expect(summary).not.toMatch(/^(<details>|<sub>|> )/)
    // Optional notices (manifest state, ignored evidence) sit between the
    // findings summary and the folds, one quoted line each.
    let j = i + 1
    while (content[j]?.startsWith('> ')) j++
    expect(content[j]).toMatch(/^(<details>|<sub>)/)
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(BUDGET)
    const screen = firstScreen(body).slice(1).filter((l) => l !== '')
    expect(screen.length).toBeLessThanOrEqual(12)
    // Footer is last: version, run link, self-hosted BYOK.
    const footer = content[content.length - 1]!
    expect(footer).toBe(
      '<sub>Argus 0.4.0 · [workflow run and evidence](https://github.com/acme/shop/actions/runs/123456) · self-hosted, BYOK</sub>',
    )
  })

  it.each(ALL)('%s contains no emoji and no em-dash', (name) => {
    const body = renderCjs(load(name))
    for (const [n, line] of body.split('\n').entries()) {
      expect(EMOJI.test(line), `L${n + 1}: ${line}`).toBe(false)
      expect(line.includes('—'), `L${n + 1}: ${line}`).toBe(false)
    }
  })

  it('mixed four-lane: needs changes, canonical lane order, app skipped, 6-decimal total', () => {
    const body = renderCjs(load('mixed-four-lane'))
    expect(body).toContain('### Argus: ⊘ needs changes\n')
    expect(laneTable(body).map((r) => r.split(' | ')[1])).toEqual(['review', 'flow', 'app', 'a0'])
    expect(laneTable(body)[2]).toBe('| – skipped | app | not selected |  |  |')
    const verdict = body.split('\n')[3]!
    expect(verdict).toBe(
      '**2 findings reproduced** in `src/discount.ts` · head `a1b2c3d` · $0.004210 · 38.1s',
    )
    expect(body).toContain('◆ 2 bugs · ◈ 1 risk · ○ 0 nits · 1 high-confidence · 1 suggestion ready to commit')
    for (const summary of ['Findings (3)', 'Heals (1): review before merging', 'Spend ledger', 'Diagnostics']) {
      expect(body).toContain(`<summary>${summary}</summary>`)
    }
  })

  it('an inconclusive a0 lane renders inconclusive with one proof notch, never passed', () => {
    const row = laneTable(renderCjs(load('mixed-four-lane'))).find((r) => r.includes('| a0 |'))
    expect(row).toBe('| ◐ inconclusive | a0 | agent report is self-reported | ▰▱▱▱ suspected | unmetered |')
    expect(row).not.toContain('passed')
  })

  it('missing key: neutral skipped status line and a copyable fix line', () => {
    const body = renderCjs(load('missing-key'))
    expect(body).toContain('### Argus: – skipped\n')
    expect(body).toMatch(/neutral, not a failure/)
    expect(body).toContain('`gh secret set OPENROUTER_API_KEY`')
    expect(body).not.toContain('<details>')
  })

  it('hostile strings: secrets masked, pipes escaped, backticks cannot break out', () => {
    const body = renderCjs(load('hostile'))
    for (const leak of ['sk-or-v1-leak-here', 'ghp_abcdefghijklmnop', 'sk-or-v1-headleak']) {
      expect(body).not.toContain(leak)
    }
    const app = laneTable(body).find((r) => r.includes('| app |'))!
    expect(app).toContain('line one line two \\| pipe-break')
    expect(app.match(/(?<!\\)\|/g)).toHaveLength(6)
  })

  it('no-report body uses the same layout and fences the report path', () => {
    const body = sticky.renderNoReportBody('/w/out`dir', 'https://github.com/run/1', { version: '0.4.0' }) as string
    const content = body.split('\n').filter((l) => l !== '')
    expect(content.slice(0, 4)).toEqual([
      SENTINEL,
      '### Argus: ⊘ failed',
      '**No report:** the run step produced no `run.json` under ``/w/out`dir``. The commit status fails closed.',
      '| Status | Lane | Result | Proof | Spend |',
    ])
    expect(content.at(-1)).toBe(
      '<sub>Argus 0.4.0 · [workflow run and evidence](https://github.com/run/1) · self-hosted, BYOK</sub>',
    )
    const ts = renderCommentHead({ body: 'no-report', reportDir: '/w/out`dir' })
    expect(laneTable(ts)).toEqual(laneTable(body))
  })

  describe('TS reference renderer parity (KTD2)', () => {
    it.each(RENDERED)('%s: identical first screen and lane table', (name) => {
      const f = load(name)
      const cjs = renderCjs(f)
      const ts = renderCommentHead(f)
      expect(laneTable(ts)).toEqual(laneTable(cjs))
      expect(ts).toBe(firstScreen(cjs).join('\n'))
    })

    it.each(['passed', 'hostile'])('%s without a code review: manifest body is identical in full', (name) => {
      // The TS reference has no code-review folds; compare the manifest-only shape.
      const f: Fixture = { ...load(name), codeReview: undefined }
      expect(f.body).toBe('manifest')
      expect(renderManifestComment(f.manifest as RunManifest, { runUrl: f.runUrl, version: f.version })).toBe(
        renderCjs(f),
      )
    })

    it('missing-key body is identical in full', () => {
      const f = load('missing-key')
      expect(renderMissingKeyComment({ version: f.version, runUrl: f.runUrl })).toBe(renderCjs(f))
    })

    it('the action keeps a copy of the glyph vocabulary equal to the view-model', () => {
      expect(sticky.STATUS_GLYPH).toEqual(vocab.STATUS_GLYPH)
      expect(sticky.SEVERITY_GLYPH).toEqual(vocab.SEVERITY_GLYPH)
      expect(sticky.SEVERITY_LABEL).toEqual(vocab.SEVERITY_LABEL)
      expect(sticky.PROOF_LEVELS).toEqual([...vocab.PROOF_LEVELS])
      expect(sticky.VERDICT_STATUS).toEqual(vocab.VERDICT_STATUS)
      expect(sticky.VERDICT_LABEL).toEqual(vocab.VERDICT_LABEL)
      for (const level of [...vocab.PROOF_LEVELS, 'not_exercised', undefined, 'toString']) {
        expect(sticky.proofMeter(level)).toBe(vocab.proofMeter(level))
      }
    })
  })

  describe('degraded-state fixtures are what they claim (consumed by U5)', () => {
    it('stale: a valid manifest bound to another head', () => {
      const f = load('stale')
      expect(sticky.validManifest(f.manifest)).toBe(true)
      expect(f.prHeadSha).toMatch(/^[0-9a-f]{40}$/)
      expect(f.manifest!.identity.intendedHeadSha).not.toBe(f.prHeadSha)
    })

    it('corrupt: the manifest text does not parse', () => {
      const f = load('corrupt')
      expect(f.manifest).toBeUndefined()
      expect(() => JSON.parse(f.manifestRaw!)).toThrow()
    })

    it('oversize: the uncollapsed body exceeds the 20 KB comment budget', () => {
      const f = load('oversize')
      const meta = { version: f.version, runUrl: f.runUrl, budgetBytes: Infinity }
      const full = sticky.renderBody(f.report, f.codeReview, f.runUrl, f.ok, f.inlinePlan, f.manifest, meta) as string
      expect(Buffer.byteLength(full)).toBeGreaterThan(BUDGET)
    })
  })
})

describe('comment error and degraded states (U5)', () => {
  const summaryOf = (body: string) =>
    [...body.matchAll(/<summary>([^<]*)<\/summary>/g)].map((m) => m[1])

  it('stale: shows both short SHAs and the re-run fix, never the stale lanes', () => {
    const body = renderCjs(load('stale'))
    expect(body).toContain('### Argus: ⊘ failed\n')
    expect(body).toContain('**Manifest stale:** manifest `a1b2c3d` ≠ head `fffffff`')
    expect(body).toMatch(/^Fix: re-run the workflow/m)
    // The ignored manifest's lanes and spend never render.
    expect(body).not.toContain('| a0 |')
    expect(body).not.toContain('$0.002900')
  })

  it('stale: a head SHA field holding planted text renders "unknown"', () => {
    const f = load('stale')
    const planted = structuredClone(f.manifest!)
    planted.identity.intendedHeadSha = '[click](https://evil.example) `x`'
    const state = sticky.resolveManifest(JSON.stringify(planted), { headSha: f.prHeadSha, nonce: RUN_NONCE })
    expect(state).toMatchObject({ state: 'stale', manifestSha: undefined, headSha: 'fffffff' })
    const body = sticky.renderSticky(
      { hasKey: true, runDisabled: false, eventName: 'pull_request', manifestState: state, ok: false, staleEvidence: [], runUrl: f.runUrl },
      { version: f.version, runUrl: f.runUrl },
    ) as string
    expect(body).toContain('manifest unknown ≠ head `fffffff`')
    expect(body).not.toContain('evil.example')
    expect(body).not.toContain('click')
  })

  it('corrupt: the "manifest unreadable" banner with a fix line, not an empty body', () => {
    const body = renderCjs(load('corrupt'))
    expect(body).toContain('**Manifest unreadable:**')
    expect(body).toMatch(/^Fix: /m)
    expect(body).toContain('<sub>Argus 0.4.0')
  })

  it('a manifest that parses but fails validation is unreadable too', () => {
    const state = sticky.resolveManifest('{"schemaVersion":2}', { headSha: 'a'.repeat(40), nonce: '1' })
    expect(state).toEqual({ state: 'unreadable', reason: 'invalid' })
  })

  it('missing: the "no manifest" banner with a fix line, not an empty body', () => {
    const body = renderCjs(load('missing-manifest'))
    expect(body).toContain('**No manifest:**')
    expect(body).toMatch(/^Fix: /m)
    expect(body).toContain('<sub>Argus 0.4.0')
  })

  it('a missing manifest on issue_comment (no verify step) renders the no-report body, no banner', () => {
    const body = sticky.renderSticky(
      {
        hasKey: true,
        runDisabled: false,
        eventName: 'issue_comment',
        manifestState: sticky.resolveManifest(undefined, { headSha: 'a'.repeat(40), nonce: '1' }),
        ok: false,
        reportDir: 'argus-reviewer-report',
        staleEvidence: [],
        runUrl: 'https://github.com/run/1',
      },
      { version: '0.4.0' },
    ) as string
    expect(body).toContain('**No report:**')
    expect(body).not.toContain('No manifest')
  })

  it('a degraded manifest beside surviving reports adds one notice line, not a new body', () => {
    const f = load('failed')
    const body = sticky.renderSticky(
      {
        hasKey: true,
        runDisabled: false,
        eventName: 'pull_request',
        report: f.report,
        codeReview: f.codeReview,
        manifestState: sticky.resolveManifest('{"trunc', { headSha: 'a'.repeat(40), nonce: '1' }),
        ok: f.ok,
        staleEvidence: ['run.json'],
        runUrl: f.runUrl,
      },
      { version: f.version, runUrl: f.runUrl },
    ) as string
    const notices = body.split('\n').filter((l) => l.startsWith('> '))
    expect(notices).toHaveLength(2)
    expect(notices[0]).toMatch(/^> \*\*Manifest unreadable:\*\*.*Fix: /)
    expect(notices[1]).toContain('`run.json`')
    // Footer stays last (R6).
    expect(body.trimEnd().split('\n').at(-1)).toMatch(/^<sub>/)
  })

  it('oversize: under 20 KB with Diagnostics and Spend ledger collapsed, then Findings, footer links the run', () => {
    const body = renderCjs(load('oversize'))
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(BUDGET)
    const collapsed = body.split('\n').filter((l) => /^<details><summary>.*omitted.*<\/details>$/.test(l))
    expect(collapsed.map((l) => /<summary>([^:<]*)/.exec(l)![1])).toEqual([
      'Findings (60)',
      'Spend ledger',
      'Diagnostics',
    ])
    expect(summaryOf(body)).toContain('Tests (2)')
    expect(body).toContain('[workflow run and evidence](https://github.com/acme/shop/actions/runs/123456)')
  })

  it('collapses in the fixed order and stops once under budget: Findings stay open', () => {
    const f = load('failed')
    // Diagnostics alone overflows: 120 long trace entries.
    const trace = Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`k${i}`, 'v'.repeat(180)]))
    const report = { ...f.report, trace }
    const meta = { version: f.version, runUrl: f.runUrl }
    const full = sticky.renderBody(report, f.codeReview, f.runUrl, f.ok, undefined, undefined, { ...meta, budgetBytes: Infinity }) as string
    expect(Buffer.byteLength(full)).toBeGreaterThan(BUDGET)
    const body = sticky.renderBody(report, f.codeReview, f.runUrl, f.ok, undefined, undefined, meta) as string
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(BUDGET)
    expect(body).toMatch(/^<details><summary>Diagnostics: omitted/m)
    expect(summaryOf(body)).toEqual(expect.arrayContaining(['Findings (1)', 'Spend ledger', 'Tests (2)']))
  })

  it('keeps the @argus persist payload when the Findings fold collapses', () => {
    const f = load('oversize')
    const payload = '<!-- argus-probe-persist ' + 'A'.repeat(64) + ' -->'
    const cr = { ...f.codeReview, persistPayload: payload }
    const body = sticky.renderBody(f.report, cr, f.runUrl, f.ok, undefined, undefined, { version: f.version, runUrl: f.runUrl }) as string
    expect(body).toMatch(/^<details><summary>Findings \(60\): omitted/m)
    expect(body.split(payload)).toHaveLength(2)
  })
})

/**
 * Inline review goldens (U6, DESIGN.md 7.2). The inline comments and the
 * formal review body a reviewer sees on the diff, rendered from fixed inputs.
 */
describe('inline review goldens (U6)', () => {
  const INLINE = join(ROOT, 'tests', 'goldens', 'inline')
  const findings: ReviewFinding[] = [
    {
      file: 'src/discount.ts',
      line: 19,
      severity: 'bug',
      category: 'correctness',
      message: 'L19: 🔴 bug: Loop bound `i <= len(events)` reads one past the end when `i == len(events)`. Use `<`.',
      suggestion: 'for (let i = 0; i < events.length; i++) {',
      evidence: { status: 'reproduced', detail: 'probe fails on head, passes on base' },
    },
    {
      file: 'src/discount.ts',
      line: 42,
      severity: 'risk',
      category: 'performance',
      message: 'L42: 🟡 risk: no retry on 429 from the pricing API. Wrap the call in `withBackoff(3)`.',
      evidence: { status: 'corroborated', detail: 'test check `unit (22)` failed on this head' },
    },
    {
      file: 'src/cart.ts',
      line: 7,
      severity: 'nit',
      category: 'convention',
      message: 'L7: 🔵 nit: `tmp` names a long-lived value. Rename to `subtotal`.',
      evidence: { status: 'inconclusive', detail: 'no repo index; run `argus-reviewer index` first' },
    },
  ]
  const comments = renderReviewComments(findings, 20).comments
  const review = sticky.reviewBody({ verdict: 'needs_changes', provenBlockers: 1, highConfidenceBlockers: 1 }) as string
  const downgraded = sticky.reviewBody(
    { verdict: 'needs_changes', provenBlockers: 1, highConfidenceBlockers: 0 },
    {
      text: 'Posted as a comment instead of requesting changes: GitHub did not allow a change request here.',
      diagnostic: 'GitHub API 422: Can not request changes on your own pull request',
    },
  ) as string
  const cases: [string, string][] = [
    ['bug-reproduced-suggestion', comments[0]!.body],
    ['risk-corroborated', comments[1]!.body],
    ['nit-no-evidence', comments[2]!.body],
    ['review-body', review],
    ['review-body-downgraded', downgraded],
  ]

  it.each(cases)('%s renders exactly its golden', (name, body) => {
    const path = join(INLINE, `${name}.md`)
    if (UPDATE || !existsSync(path)) {
      if (!UPDATE) throw new Error(`missing golden ${path}; run with UPDATE_GOLDENS=1`)
      writeFileSync(path, body)
    }
    expect(body).toBe(readFileSync(path, 'utf8'))
  })

  it.each(cases)('%s carries no emoji and no em-dash', (_name, body) => {
    expect(body).not.toMatch(EMOJI)
    expect(body).not.toContain('\u2014')
  })
})
