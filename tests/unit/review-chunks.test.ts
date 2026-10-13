import { describe, expect, it } from 'vitest'

import { planChunks } from '../../src/review/chunks.js'
import { reply, runReview, ScriptedClient } from './review-pipeline.helpers.js'

const bigBody = (n: number, tag: string): string =>
  Array.from({ length: n }, (_, i) => `const ${tag}${i} = ${i} // padding padding padding padding`).join('\n') + '\n'

describe('planChunks', () => {
  const file = (filename: string, patch: string) => ({ filename, patch })
  const order = (plan: ReturnType<typeof planChunks>) => plan.flatMap((c) => c.files)

  it('groups files of one directory into adjacent chunks', () => {
    const p = 'x'.repeat(2500 * 4)
    const plan = planChunks([
      file('b/one.ts', p),
      file('a/one.ts', p),
      file('b/two.ts', p),
      file('a/two.ts', p),
    ])
    expect(order(plan)).toEqual(['b/one.ts', 'b/two.ts', 'a/one.ts', 'a/two.ts'])
    expect(plan).toHaveLength(2)
  })

  it('bundles a source file with its test and spec siblings in one chunk', () => {
    const p = 'x'.repeat(1800 * 4)
    const plan = planChunks([
      file('src/foo.ts', p),
      file('src/bar.ts', p),
      file('src/foo.test.ts', p),
      file('src/foo.spec.ts', p),
    ])
    const idx = new Map<string, number>()
    plan.forEach((c, i) => c.files.forEach((f) => idx.set(f, i)))
    expect(idx.get('src/foo.ts')).toBe(idx.get('src/foo.test.ts'))
    expect(idx.get('src/foo.ts')).toBe(idx.get('src/foo.spec.ts'))
    expect(idx.get('src/foo.ts')).not.toBe(idx.get('src/bar.ts'))
    expect(order(plan)).toEqual(['src/foo.ts', 'src/foo.test.ts', 'src/foo.spec.ts', 'src/bar.ts'])
  })

  it('bundles across __tests__/__snapshots__ dirs and .snap/.stories suffixes', () => {
    const p = 'x'.repeat(1100 * 4)
    const plan = planChunks([
      file('src/foo.ts', p),
      file('src/__tests__/foo.ts', p),
      file('src/__snapshots__/foo.test.ts.snap', p),
      file('src/foo.stories.ts', p),
      file('src/unrelated.ts', 'x'.repeat(1500 * 4)),
    ])
    const chunkOf = (f: string) => plan.findIndex((c) => c.files.includes(f))
    expect(chunkOf('src/foo.ts')).toBe(chunkOf('src/__tests__/foo.ts'))
    expect(chunkOf('src/foo.ts')).toBe(chunkOf('src/__snapshots__/foo.test.ts.snap'))
    expect(chunkOf('src/foo.ts')).toBe(chunkOf('src/foo.stories.ts'))
    expect(chunkOf('src/foo.ts')).not.toBe(chunkOf('src/unrelated.ts'))
  })

  it('pulls an interleaved test next to its source even across a big sibling', () => {
    const big = 'x'.repeat(5000 * 4)
    const small = 'x'.repeat(200 * 4)
    const plan = planChunks([
      file('d/foo.ts', small),
      file('d/huge.ts', big),
      file('d/foo.test.ts', small),
    ])
    const chunkOf = (f: string) => plan.findIndex((c) => c.files.includes(f))
    expect(chunkOf('d/foo.ts')).toBe(chunkOf('d/foo.test.ts'))
  })

  it('splits a single oversized patch at hunk boundaries, keeping every hunk', () => {
    const hunk = (n: number) => `@@ -${n},1 +${n},1 @@\n${'+y'.repeat(5000)}\n`
    const patch = 'diff --git a/x b/x\n+++ b/x\n' + [1, 2, 3, 4].map(hunk).join('')
    const plan = planChunks([file('big.ts', patch)])
    expect(plan.length).toBeGreaterThan(1)
    const joined = plan.map((c) => c.text).join('\n')
    for (const n of [1, 2, 3, 4]) expect(joined).toContain(`@@ -${n},1 +${n},1 @@`)
    expect(plan[1]?.text).toContain('big.ts (part 2/')
    expect(plan.every((c) => c.files.includes('big.ts'))).toBe(true)
  })
})

describe('chunked review of large PRs', () => {
  const head: Record<string, string> = {}
  for (let i = 0; i < 12; i++) head[`pkg${i % 3}/f${i}.ts`] = bigBody(200, `v${i}`)

  it('reviews every chunk, merges findings, and says how much was reviewed', async () => {
    const queue = []
    // chunk replies carry one finding each, then a synthesis reply
    const finding = (file: string) =>
      reply([{ file, line: 1, severity: 'bug', category: 'correctness', message: 'L1: 🔴 bug: x. fix.' }])
    for (let i = 0; i < 40; i++) queue.push(finding(`pkg0/f0.ts`))
    const client = new ScriptedClient(queue)
    const r = await runReview({ head, client })
    expect(r.code).toBe(0)
    const chunkCalls = client.prompts.filter((p) => p.includes('Review chunk'))
    expect(chunkCalls.length).toBeGreaterThan(2)
    for (const f of Object.keys(head)) {
      expect(client.prompts.some((p) => p.includes(`### ${f}`))).toBe(true)
    }
    expect(r.report.scope).toMatchObject({
      totalFiles: 12,
      reviewedFiles: 12,
      chunksTotal: chunkCalls.length,
      chunksReviewed: chunkCalls.length,
      unreviewedFiles: 0,
    })
    expect(r.report.summary).toContain(`Reviewed all ${chunkCalls.length} chunks (12 of 12 files)`)
  })

  it('stops before a chunk the budget cannot cover, and reports the partial coverage', async () => {
    const queue = []
    for (let i = 0; i < 40; i++) queue.push(reply([]))
    const client = new ScriptedClient(queue)
    // stub cost is $0.001 per call; $0.0025 funds two chunks, not three
    const r = await runReview({ head, client, config: { codeReviewBudgetUsd: 0.0025 } })
    const chunkCalls = client.prompts.length
    expect(chunkCalls).toBe(2)
    expect(r.report.visionCostUsd).toBeLessThanOrEqual(0.0025)
    expect(r.report.scope.chunksReviewed).toBe(2)
    expect(r.report.scope.chunksTotal).toBeGreaterThan(2)
    expect(r.report.scope.unreviewedFiles).toBeGreaterThan(0)
    expect(r.report.scope.reviewedFiles + r.report.scope.unreviewedFiles).toBe(12)
    expect(r.report.summary).toMatch(/Reviewed 2 of \d+ chunks \(\d+ of 12 files\)/)
    expect(r.report.budgetExceeded).toBe(true)
  })
})
