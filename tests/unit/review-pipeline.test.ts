import { describe, expect, it } from 'vitest'

import { lines, reply, runReview, ScriptedClient } from './review-pipeline.helpers.js'

describe('review scope exclusions', () => {
  it('keeps fixture, golden and dist paths out of the model input and reports it', async () => {
    const client = new ScriptedClient([reply([])])
    const r = await runReview({
      head: {
        'src/a.ts': 'export const a = 1\n',
        'fixtures/manifests/m.json': '{"file":"src/discount.ts"}\n',
        'tests/goldens/comment/g.md': 'src/pager.ts\n',
        'dist/cli.js': 'var x\n',
      },
      client,
    })
    expect(r.code).toBe(0)
    expect(client.prompts).toHaveLength(1)
    expect(client.prompts[0]).toContain('src/a.ts')
    expect(client.prompts[0]).not.toContain('discount.ts')
    expect(client.prompts[0]).not.toContain('pager.ts')
    expect(r.report.scope).toMatchObject({ totalFiles: 4, reviewedFiles: 1, excludedFiles: 3 })
    expect(r.report.summary).toContain('Reviewed 1 of 4 changed files')
  })

  it('config exclude list overrides the defaults', async () => {
    const client = new ScriptedClient([reply([])])
    const r = await runReview({
      head: { 'src/a.ts': 'a\n', 'fixtures/f.json': '{}\n', 'gen/x.ts': 'g\n' },
      client,
      config: { review: { exclude: ['gen/**'] } },
    })
    expect(client.prompts[0]).toContain('fixtures/f.json')
    expect(client.prompts[0]).not.toContain('gen/x.ts')
    expect(r.report.scope.excludedFiles).toBe(1)
  })

  it('skips with a reason when every file is excluded', async () => {
    const client = new ScriptedClient([])
    const r = await runReview({ head: { 'dist/a.js': 'x\n' }, client })
    expect(r.report.skipped).toBe(true)
    expect(r.report.summary).toContain('review.exclude')
  })
})


describe('finding validation', () => {
  it('drops findings outside the diff and reports counts and reasons', async () => {
    const client = new ScriptedClient([
      reply([
        { file: 'src/a.ts', line: 2, severity: 'bug', category: 'correctness', message: 'L2: real' },
        { file: 'src/discount.ts', line: 6, severity: 'bug', category: 'correctness', message: 'L6: ghost' },
        { file: 'src/a.ts', line: 90, severity: 'risk', category: 'correctness', message: 'L90: past eof' },
      ]),
    ])
    const r = await runReview({
      base: { 'src/a.ts': lines(5) },
      head: { 'src/a.ts': lines(5).replace('line 2', 'LINE 2') },
      client,
    })
    expect(r.report.findings.map((x: { message: string }) => x.message)).toEqual(['L2: real'])
    expect(r.report.validation.dropped).toBe(2)
    expect(r.report.validation.byReason).toEqual({ file_not_in_diff: 1, line_outside_diff: 1 })
    expect(r.report.validation.examples).toHaveLength(2)
  })

  it('downgrades the verdict when every blocking finding was dropped', async () => {
    const client = new ScriptedClient([
      reply([{ file: 'src/ghost.ts', line: 1, severity: 'bug', category: 'correctness', message: 'L1: ghost' }]),
    ])
    const r = await runReview({ head: { 'src/a.ts': 'x\n' }, client })
    expect(r.report.findings).toHaveLength(0)
    expect(r.report.verdict).toBe('pass')
  })
})

describe('test-file handling', () => {
  it('caps a test-file bug at nit and lets the verdict follow', async () => {
    const client = new ScriptedClient([
      reply([
        { file: 'tests/a.test.ts', line: 1, severity: 'bug', category: 'correctness', message: 'L1: assertion restates behavior' },
      ]),
    ])
    const r = await runReview({
      head: { 'src/a.ts': 'x\n', 'tests/a.test.ts': 'expect(1).toBe(1)\n' },
      client,
    })
    expect(r.report.findings[0].severity).toBe('nit')
    expect(r.report.verdict).toBe('approve')
    expect(r.report.testFileCapped).toBe(1)
    expect(client.prompts[0]).toContain('assertions describe expected behavior')
  })
})

describe('large PRs', () => {
  const big = (i: number) => ({ [`src/f${i}.ts`]: lines(1500, `f${i}`) })
  const head = Object.assign({}, ...Array.from({ length: 6 }, (_, i) => big(i))) as Record<string, string>

  it('reviews every chunk and says how much was reviewed', async () => {
    const client = new ScriptedClient(Array.from({ length: 20 }, () => reply([], 'pass')))
    const r = await runReview({ head, client })
    expect(r.code).toBe(0)
    expect(client.prompts.length).toBeGreaterThan(2)
    expect(r.report.scope.reviewedFiles).toBe(6)
    expect(r.report.scope.chunks).toBe(r.report.scope.reviewedChunks)
    expect(r.report.summary).toMatch(/Reviewed 6 of 6 changed files \(\d+ of \d+ chunks/)
  })

  it('a failed chunk is disclosed and the rest of the review survives', async () => {
    const probe = new ScriptedClient(Array.from({ length: 20 }, () => reply([], 'pass')))
    await runReview({ head, client: probe })
    const n = probe.prompts.length - 1 // minus synthesis
    const replies: (ReturnType<typeof reply> | Error)[] = []
    for (let i = 0; i < n; i++) {
      replies.push(
        i === 1
          ? new Error('boom')
          : reply([{ file: 'src/f0.ts', line: 1, severity: 'nit', category: 'other', message: 'L1: n' }], 'approve'),
      )
    }
    replies.push(reply([], 'approve'))
    const r = await runReview({ head, client: new ScriptedClient(replies) })
    expect(r.code).toBe(0)
    expect(r.report.scope.failedChunks).toBe(1)
    expect(r.report.scope.reviewedFiles).toBeLessThan(6)
    expect(r.report.summary).toMatch(/Reviewed \d of 6 changed files/)
    expect(r.report.verdict).toBe('needs_changes')
    expect(r.report.ok).toBe(false)
  })

  it('still fails when no chunk could be reviewed', async () => {
    const r = await runReview({ head, client: new ScriptedClient(Array.from({ length: 20 }, () => new Error('down'))) })
    expect(r.code).toBe(1)
  })
})
