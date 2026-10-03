import { describe, expect, it } from 'vitest'

import { reply, runReview, ScriptedClient } from './review-pipeline.helpers.js'

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

