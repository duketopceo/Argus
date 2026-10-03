/* eslint-disable no-control-regex -- asserting on terminal escape sequences is the point */
import { describe, expect, it } from 'vitest'

import { createScreen, diffFrame } from '../../scripts/tui/screen.mjs'

// Cursor-position sequences in a write: one per touched row.
const rowsTouched = (s: string): number[] =>
  [...s.matchAll(/\x1b\[(\d+);1H/g)].map((m) => Number(m[1]))

function fakeOut() {
  const writes: string[] = []
  return { writes, write: (s: string) => (writes.push(s), true) }
}

describe('line differ (R17)', () => {
  const a = ['argus watch', '', 'Verify', '  review passed', '  flow failed', '  app passed', 'q quit']

  it('writes every line on the first frame', () => {
    expect(rowsTouched(diffFrame(undefined, a))).toEqual([1, 2, 3, 4, 5, 6, 7])
  })

  it('writes nothing when the frame is unchanged', () => {
    expect(diffFrame(a, [...a])).toBe('')
  })

  it('writes only the changed line when one lane differs', () => {
    const b = [...a]
    b[4] = '  flow passed'
    const out = diffFrame(a, b)
    expect(rowsTouched(out)).toEqual([5])
    expect(out).toContain('  flow passed')
    expect(out).not.toContain('review')
    // Clears the rest of the row so a shorter line leaves no tail.
    expect(out).toContain('\x1b[K')
  })

  it('clears rows a shorter frame no longer uses', () => {
    const out = diffFrame(a, a.slice(0, 5))
    expect(rowsTouched(out)).toEqual([6, 7])
    expect(out.match(/\x1b\[2K/g)).toHaveLength(2)
  })
})

describe('screen lifecycle', () => {
  it('enters the alternate screen, hides the cursor, and restores both on leave', () => {
    const out = fakeOut()
    const s = createScreen(out)
    s.enter()
    expect(out.writes.join('')).toContain('\x1b[?1049h')
    expect(out.writes.join('')).toContain('\x1b[?25l')
    s.leave()
    s.leave()
    const all = out.writes.join('')
    expect(all.match(/\x1b\[\?1049l/g)).toHaveLength(1)
    expect(all).toContain('\x1b[?25h')
  })

  it('draws diffs between frames and redraws in full after a resize', () => {
    const out = fakeOut()
    const s = createScreen(out)
    s.enter()
    s.draw(['a', 'b', 'c'])
    out.writes.length = 0
    s.draw(['a', 'B', 'c'])
    expect(rowsTouched(out.writes.join(''))).toEqual([2])
    out.writes.length = 0
    s.draw(['a', 'B', 'c'])
    expect(out.writes.join('')).toBe('')
    s.invalidate()
    s.draw(['a', 'B', 'c'])
    const full = out.writes.join('')
    expect(full).toContain('\x1b[2J')
    expect(rowsTouched(full)).toEqual([1, 2, 3])
  })

  it('does not draw after leave', () => {
    const out = fakeOut()
    const s = createScreen(out)
    s.enter()
    s.leave()
    out.writes.length = 0
    s.draw(['late frame'])
    expect(out.writes).toEqual([])
  })
})
