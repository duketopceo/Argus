import { describe, expect, it } from 'vitest'

import { parseHunks, validateFindings } from '../../src/review/validate.js'

const PATCH = [
  '@@ -10,3 +10,4 @@ fn',
  ' ctx a',
  '+added b',
  ' ctx c',
  ' ctx d',
  '@@ -50,2 +51,2 @@',
  '-old',
  '+new',
  ' ctx',
].join('\n')

const NEW_FILE = ['@@ -0,0 +1,3 @@', '+one', '+two', '+three'].join('\n')

const files = [
  { filename: 'src/a.ts', patch: PATCH },
  { filename: 'src/new.ts', patch: NEW_FILE },
  { filename: 'src/gone.ts', patch: '@@ -1,2 +0,0 @@\n-a\n-b' },
]

const f = (file: string, line?: number) => ({
  file,
  ...(line !== undefined ? { line } : {}),
  severity: 'bug',
  message: 'm',
})

describe('parseHunks', () => {
  it('reads new-side ranges and detects new and deleted files', () => {
    expect(parseHunks(PATCH).ranges).toEqual([
      [10, 13],
      [51, 52],
    ])
    expect(parseHunks(NEW_FILE)).toMatchObject({ ranges: [[1, 3]], newFileLength: 3 })
    expect(parseHunks('@@ -1,2 +0,0 @@\n-a\n-b').deleted).toBe(true)
  })
})

describe('validateFindings', () => {
  it('keeps findings inside changed hunks (with tolerance) and without a line', () => {
    const r = validateFindings([f('src/a.ts', 11), f('src/a.ts', 15), f('src/a.ts')], files)
    expect(r.kept).toHaveLength(3)
    expect(r.dropped).toHaveLength(0)
  })

  it('drops files that are not in the diff, with a reason', () => {
    const r = validateFindings([f('src/discount.ts', 6), f('./src/a.ts', 11)], files)
    expect(r.kept).toHaveLength(1)
    expect(r.dropped).toEqual([{ file: 'src/discount.ts', line: 6, reason: 'file_not_in_diff' }])
  })

  it('labels findings on excluded paths separately', () => {
    const r = validateFindings([f('fixtures/m.json', 1)], files, new Set(['fixtures/m.json']))
    expect(r.dropped[0]?.reason).toBe('file_excluded')
  })

  it('drops lines far outside the hunks and beyond the end of a new file', () => {
    const r = validateFindings(
      [f('src/a.ts', 278), f('src/a.ts', 30), f('src/new.ts', 4), f('src/new.ts', 3)],
      files,
    )
    expect(r.dropped.map((d) => [d.line, d.reason])).toEqual([
      [278, 'line_outside_diff'],
      [30, 'line_outside_diff'],
      [4, 'line_beyond_file'],
    ])
    expect(r.kept).toHaveLength(1)
  })

  it('drops findings on files deleted at head', () => {
    const r = validateFindings([f('src/gone.ts', 1)], files)
    expect(r.dropped[0]?.reason).toBe('file_deleted')
  })
})
