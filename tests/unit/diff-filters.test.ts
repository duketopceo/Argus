import { describe, expect, it } from 'vitest'

import {
  diffLineRanges,
  diffLineTexts,
  filterRevertNits,
  filterToDiffLines,
  type ReviewFinding,
} from '../../src/cli.js'

const PATCH = [
  '@@ -10,4 +10,5 @@ function x() {',
  ' const a = 1',
  '+const b = 2',
  '-const c = 3',
  '+const c = 4',
  ' const d = 5',
  ' const z = 0',
  '@@ -40,3 +41,4 @@ function y() {',
  '+const e = 6',
  ' const f = 7',
  '-const g = 8',
  '+const g = 9',
  ' const h = 10',
].join('\n')

const FILE = { filename: 'src/a.ts', patch: PATCH }

const finding = (over: Partial<ReviewFinding> = {}): ReviewFinding => ({
  file: 'src/a.ts',
  line: 11,
  severity: 'nit',
  category: 'correctness',
  message: 'L11: 🔵 nit: rename `b`',
  ...over,
})

describe('diffLineRanges', () => {
  it('maps each hunk header to a new-side [start, end] range', () => {
    const ranges = diffLineRanges([FILE]).get('src/a.ts')
    expect(ranges).toEqual([
      [10, 14],
      [41, 44],
    ])
  })

  it('treats a +N,0 hunk as covering no new-side lines', () => {
    const patch = '@@ -5,3 +5,0 @@'
    expect(diffLineRanges([{ filename: 'f.ts', patch }]).get('f.ts')).toEqual([])
  })

  it('handles a missing patch', () => {
    expect(diffLineRanges([{ filename: 'f.ts' }]).get('f.ts')).toEqual([])
  })

  it('defaults a +N header without a count to one line', () => {
    const patch = '@@ -7 +9 @@'
    expect(diffLineRanges([{ filename: 'f.ts', patch }]).get('f.ts')).toEqual([[9, 9]])
  })

  it('ignores hunk-shaped text inside content lines', () => {
    // A line whose content embeds a hunk header must not fabricate ranges —
    // only headers at line start count.
    const patch = [
      '@@ -1,2 +1,3 @@',
      '+docs mention @@ -50,5 +900,900 @@ as an example',
      ' real line',
    ].join('\n')
    expect(diffLineRanges([{ filename: 'f.ts', patch }]).get('f.ts')).toEqual([[1, 3]])
  })
})

describe('diffLineTexts', () => {
  it('maps added and context lines by new-side number; removed lines consume old-side only', () => {
    const texts = diffLineTexts([FILE]).get('src/a.ts')
    expect(texts?.get(10)).toBe('const a = 1')
    expect(texts?.get(11)).toBe('const b = 2')
    expect(texts?.get(12)).toBe('const c = 4') // replacement for removed -const c = 3
    expect(texts?.get(13)).toBe('const d = 5')
    expect(texts?.get(14)).toBe('const z = 0')
    expect(texts?.get(41)).toBe('const e = 6')
    expect(texts?.get(42)).toBe('const f = 7')
    expect(texts?.get(43)).toBe('const g = 9') // replacement for removed -const g = 8
    expect(texts?.get(44)).toBe('const h = 10')
    expect(texts?.get(45)).toBeUndefined()
  })

  it('handles a missing patch', () => {
    expect(diffLineTexts([{ filename: 'f.ts' }]).get('f.ts')?.size).toBe(0)
  })
})

describe('filterToDiffLines', () => {
  const ranges = diffLineRanges([FILE])

  it('keeps findings anchored inside a hunk, including the range boundary', () => {
    const inHunk = finding({ line: 11 })
    const boundary = finding({ line: 14 })
    const { kept, dropped } = filterToDiffLines([inHunk, boundary], ranges)
    expect(kept).toHaveLength(2)
    expect(dropped).toHaveLength(0)
  })

  it('drops findings citing a line in an inter-hunk gap or off the file', () => {
    const gap = finding({ line: 20 })
    const offFile = finding({ file: 'src/other.ts', line: 1 })
    const { kept, dropped } = filterToDiffLines([gap, offFile], ranges)
    expect(kept).toHaveLength(0)
    expect(dropped).toHaveLength(2)
  })

  it('keeps line-less (file-level) findings', () => {
    const { kept } = filterToDiffLines([finding({ line: undefined })], ranges)
    expect(kept).toHaveLength(1)
  })

  it('never drops verdict-driving findings — bug, risk, security-category, blocking severities', () => {
    const bug = finding({ severity: 'bug', line: 999 })
    const risk = finding({ severity: 'risk', line: 999 })
    const secNit = finding({ category: 'security', line: 999 })
    const blockingNit = finding({ severity: 'nit', line: 999 })
    const { kept, dropped } = filterToDiffLines([bug, risk, secNit, blockingNit], ranges, [
      'bug',
      'nit',
    ])
    expect(kept).toHaveLength(4)
    expect(dropped).toHaveLength(0)
  })

  it('drops an unanchored nit when it is not a blocking severity', () => {
    const nit = finding({ severity: 'nit', line: 999 })
    const { kept, dropped } = filterToDiffLines([nit], ranges, ['bug'])
    expect(kept).toHaveLength(0)
    expect(dropped).toHaveLength(1)
  })
})

describe('filterRevertNits', () => {
  const texts = diffLineTexts([FILE])

  it('drops a nit asking to remove text the cited line contains', () => {
    const f = finding({ line: 11, message: 'L11: 🔵 nit: remove `b = 2`' })
    const { kept, dropped } = filterRevertNits([f], texts)
    expect(dropped).toHaveLength(1)
    expect(kept).toHaveLength(0)
  })

  it('drops a q asking to revert quoted wording on the cited line', () => {
    const f = finding({ line: 12, severity: 'q', message: "L12: ❓ q: revert 'c = 4'" })
    const { dropped } = filterRevertNits([f], texts)
    expect(dropped).toHaveLength(1)
  })

  it('keeps a nit whose quoted target is not on the cited line', () => {
    const f = finding({ line: 11, message: 'L11: 🔵 nit: remove `nonexistent`' })
    const { kept } = filterRevertNits([f], texts)
    expect(kept).toHaveLength(1)
  })

  it('never drops bug/risk or security-category findings, even when the text matches', () => {
    const bug = finding({ severity: 'bug', line: 11, message: 'L11: 🔴 bug: remove `b = 2`' })
    const sec = finding({
      severity: 'nit',
      category: 'security',
      line: 11,
      message: 'L11: 🔵 nit: remove `b = 2`',
    })
    const { kept, dropped } = filterRevertNits([bug, sec], texts)
    expect(kept).toHaveLength(2)
    expect(dropped).toHaveLength(0)
  })

  it('never drops a nit whose severity is configured as blocking', () => {
    const f = finding({ line: 11, message: 'L11: 🔵 nit: remove `b = 2`' })
    const { kept } = filterRevertNits([f], texts, ['bug', 'nit'])
    expect(kept).toHaveLength(1)
  })

  it('drops "replace X with X" self-replace nits', () => {
    const f = finding({
      line: 11,
      message: "L11: 🔵 nit: replace 'b = 2' with 'b = 2'",
    })
    const { dropped } = filterRevertNits([f], texts)
    expect(dropped).toHaveLength(1)
  })

  it('keeps findings without a line', () => {
    const f = finding({ line: undefined, message: 'remove `b = 2`' })
    const { kept } = filterRevertNits([f], texts)
    expect(kept).toHaveLength(1)
  })
})
