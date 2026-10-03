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
  manifestRaw?: string
  inlinePlan?: unknown
}

function load(name: string): Fixture {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8')) as Fixture
}

/** Fixtures U4 renders to goldens. stale/corrupt/oversize feed U5's degraded states. */
const RENDERED = ['passed', 'failed', 'mixed-four-lane', 'review-only', 'missing-key', 'hostile']

function renderCjs(f: Fixture): string {
  const meta = { version: f.version, runUrl: f.runUrl }
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
    expect(names).toEqual(
      [...RENDERED, 'stale', 'corrupt', 'oversize'].sort(),
    )
  })

  it.each(RENDERED)('%s renders exactly its golden', (name) => {
    const body = renderCjs(load(name))
    const path = join(GOLDENS, `${name}.md`)
    if (UPDATE || !existsSync(path)) {
      if (!UPDATE) throw new Error(`missing golden ${path}; run with UPDATE_GOLDENS=1`)
      writeFileSync(path, body)
    }
    expect(body).toBe(readFileSync(path, 'utf8'))
  })

  it.each(RENDERED)('%s follows the R6 grammar with a first screen of at most 12 lines', (name) => {
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
    expect(summary).not.toMatch(/^(<details>|<sub>)/)
    expect(content[i + 1]).toMatch(/^(<details>|<sub>)/)
    const screen = firstScreen(body).slice(1).filter((l) => l !== '')
    expect(screen.length).toBeLessThanOrEqual(12)
    // Footer is last: version, run link, self-hosted BYOK.
    const footer = content[content.length - 1]!
    expect(footer).toBe(
      '<sub>Argus 0.4.0 · [workflow run and evidence](https://github.com/acme/shop/actions/runs/123456) · self-hosted, BYOK</sub>',
    )
  })

  it.each(RENDERED)('%s contains no emoji and no em-dash', (name) => {
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

    it('oversize: the full body exceeds the 20 KB comment budget', () => {
      expect(Buffer.byteLength(renderCjs(load('oversize')))).toBeGreaterThan(20 * 1024)
    })
  })
})
