import { describe, expect, it } from 'vitest'

import { buildCodeReviewMessages } from '../../src/cli.js'
import { resolveConfig } from '../../src/config.js'
import { isReviewProfile, packRubric, REVIEW_PROFILES } from '../../src/review/packs.js'

function promptText(messages: ReturnType<typeof buildCodeReviewMessages>): string {
  const user = messages[1]
  if (user === undefined) throw new Error('no user message')
  const part = user.content[0]
  if (part === undefined || part.type !== 'text') throw new Error('no text part')
  return part.text
}

describe('review packs', () => {
  it('recognizes exactly the three documented profiles', () => {
    expect(REVIEW_PROFILES).toEqual(['security', 'perf', 'debloat'])
    expect(isReviewProfile('security')).toBe(true)
    expect(isReviewProfile('perf')).toBe(true)
    expect(isReviewProfile('debloat')).toBe(true)
    expect(isReviewProfile('style')).toBe(false)
    expect(isReviewProfile('')).toBe(false)
  })

  it('no profiles → prompt identical to before (no rubric block)', () => {
    const text = promptText(buildCodeReviewMessages('o/r', '1', 'diff text'))
    expect(text).not.toContain('Active review lenses')
    expect(packRubric([])).toBeUndefined()
    expect(packRubric(undefined)).toBeUndefined()
  })

  it('each pack appends its rubric to the built prompt', () => {
    const titles = { security: 'Security lens', perf: 'Performance lens', debloat: 'Debloat lens' }
    for (const profile of REVIEW_PROFILES) {
      const text = promptText(buildCodeReviewMessages('o/r', '1', 'diff', 0, 1, [profile]))
      expect(text).toContain('Active review lenses')
      expect(text).toContain(titles[profile])
    }
  })

  it('packs compose — security+perf both active in one prompt', () => {
    const text = promptText(
      buildCodeReviewMessages('o/r', '1', 'diff', 0, 1, ['security', 'perf']),
    )
    expect(text).toContain('Security lens')
    expect(text).toContain('Performance lens')
    expect(text).not.toContain('Debloat lens')
  })

  it('security rubric requires literal masking in reported findings', () => {
    const rubric = packRubric(['security'])
    expect(rubric).toContain('never reproduce')
  })

  it('unknown profile names are dropped at config load', () => {
    const c = resolveConfig({ review: { profiles: ['security', 'style' as never] } })
    expect(c.review.profiles).toEqual(['security'])
  })

  it('non-array profiles input falls back to the empty default', () => {
    const c = resolveConfig({ review: { profiles: 'security' as never } })
    expect(c.review.profiles).toEqual([])
  })

  it('duplicate profiles dedupe', () => {
    const c = resolveConfig({ review: { profiles: ['perf', 'perf', 'debloat'] } })
    expect(c.review.profiles).toEqual(['perf', 'debloat'])
  })
})
