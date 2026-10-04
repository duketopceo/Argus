import { describe, expect, it } from 'vitest'

import {
  conclusionFromReport,
  renderCommentHead,
  renderManifestComment,
  renderMissingKeyComment,
  SENTINEL,
} from '../../src/report/comment.js'
import { RunReport } from '../../src/report/run.js'
import { fixtureManifest } from '../fixtures/manifest.js'

const meta = { version: '0.4.0', runUrl: 'https://github.com/run/1' }

// U4/R6: the TS reference renders the sticky grammar straight from the shared
// manifest view-model. Whole bodies are pinned against the action renderer
// by tests/unit/comment-golden.test.ts; these cover the reference on its own.
describe('renderManifestComment', () => {
  it('renders header, verdict line, every lane in canonical order, folds and footer', () => {
    const body = renderManifestComment(fixtureManifest(), meta)

    expect(body.startsWith(`${SENTINEL}\n### Argus: ⊘ failed\n`)).toBe(true)
    expect(body.split(SENTINEL)).toHaveLength(2)
    expect(body).toContain('**flow failed, a0 inconclusive** · head `abc1234` · $0.006200 · 120.0s')
    expect(body).toContain('| ● passed | review | 2 findings | ▰▱▱▱ suspected | $0.004200 |')
    expect(body).toContain(
      '| ⊘ failed | flow | landing.test.ts: assertion failed | ▰▰▰▱ exercised | $0.001500 |',
    )
    expect(body).toContain('| ● passed | app | expected state verified | ▰▰▰▱ exercised | $0.000500 |')
    expect(body).toContain(
      '| ◐ inconclusive | a0 | delegation returned — self-reported | ▰▱▱▱ suspected | unmetered |',
    )
    expect(body).toContain('No code review report is attached to this run.')
    expect(body).toContain('<summary>Spend ledger</summary>')
    expect(body).toContain('| Total |  | 8 | 8000 | $0.006200 |')
    expect(body).toContain('**Fingerprint cache:** 2 hit(s) · 1 miss(es) · 1 heal(s)')
    expect(body).toContain('- Head binding: match, checkout matches the intended PR head')
    expect(body.trimEnd().endsWith(
      '<sub>Argus 0.4.0 · [workflow run and evidence](https://github.com/run/1) · self-hosted, BYOK</sub>',
    )).toBe(true)
  })

  it('renders unselected lanes as skipped rows in canonical position', () => {
    const manifest = fixtureManifest()
    manifest.lanes.app.selected = false
    manifest.lanes.app.status = 'skipped'
    const body = renderManifestComment(manifest, meta)
    expect(body).toContain('| – skipped | app | not selected |  |  |')
    expect(body.indexOf('| app |')).toBeGreaterThan(body.indexOf('| review |'))
    expect(body.indexOf('| app |')).toBeLessThan(body.indexOf('| a0 |'))
  })

  it('masks secret-shaped tokens in lane detail before they reach a PR', () => {
    const manifest = fixtureManifest()
    manifest.lanes.flow.reason = 'auth failed: sk-or-v1-abcdef12345'
    const body = renderManifestComment(manifest, meta)
    expect(body).not.toContain('sk-or-v1-abcdef12345')
    expect(body).toContain('auth failed: •••')
  })

  it('omits the run link when there is none', () => {
    const body = renderManifestComment(fixtureManifest(), { version: '0.4.0' })
    expect(body).toContain('<sub>Argus 0.4.0 · self-hosted, BYOK</sub>')
  })
})

describe('renderCommentHead', () => {
  it('ends at the findings summary, before any fold', () => {
    const head = renderCommentHead({ body: 'manifest', manifest: fixtureManifest() })
    expect(head).not.toContain('<details>')
    expect(head.trimEnd().split('\n').at(-1)).toBe('No code review report is attached to this run.')
  })

  it('never shows a positive verdict on a failed run', () => {
    const head = renderCommentHead({
      body: 'review-only',
      ok: false,
      codeReview: { ok: true, skipped: false, verdict: 'approve', findings: [] },
    })
    expect(head).toContain('### Argus: ⊘ failed\n')
  })
})

describe('renderMissingKeyComment', () => {
  it('is a neutral skip with a copyable fix line', () => {
    const body = renderMissingKeyComment(meta)
    expect(body).toContain('### Argus: – skipped\n')
    expect(body).toContain('neutral, not a failure')
    expect(body).toContain('`gh secret set OPENROUTER_API_KEY`')
  })
})

describe('conclusionFromReport', () => {
  it('maps pass, fail and missing-key to the correct check-run conclusion', () => {
    const report = { ok: true } as RunReport
    expect(conclusionFromReport(report)).toBe('success')
    expect(conclusionFromReport({ ...report, ok: false })).toBe('failure')
    expect(conclusionFromReport(undefined, true)).toBe('neutral')
  })
})
