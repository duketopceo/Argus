import { describe, expect, it } from 'vitest'

import { planChunks } from '../../src/cli.js'

const hunk = (n: number, body: number): string =>
  `@@ -${n * 100},1 +${n * 100},1 @@\n` + `+${'x'.repeat(body)}\n`

describe('planChunks', () => {
  it('splits one oversize patch at hunk boundaries without dropping a hunk', () => {
    const hunks = Array.from({ length: 8 }, (_, i) => hunk(i + 1, 12_000))
    const plan = planChunks([{ filename: 'src/big.ts', patch: hunks.join('') }])
    expect(plan.chunks.length).toBeGreaterThan(1)
    expect(plan.splitFiles).toBe(1)
    const all = plan.chunks.join('\n')
    for (let i = 1; i <= 8; i++) expect(all).toContain(`@@ -${i * 100},1`)
    expect(plan.chunks[1]).toContain('src/big.ts')
    expect(plan.chunks[1]).toMatch(/part 2 of /)
  })

  it('reports which files each chunk carries', () => {
    const plan = planChunks([
      { filename: 'a.ts', patch: hunk(1, 60_000) },
      { filename: 'b.ts', patch: hunk(1, 60_000) },
    ])
    expect(plan.chunkFiles).toEqual([['a.ts'], ['b.ts']])
  })
})
