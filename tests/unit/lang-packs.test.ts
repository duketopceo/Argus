import { describe, expect, it } from 'vitest'

import { buildCodeReviewMessages } from '../../src/cli.js'
import { resolveConfig } from '../../src/config.js'
import {
  LANG_PACK_IDS,
  packRubric,
  selectLangPacks,
} from '../../src/review/packs.js'

function promptText(
  messages: ReturnType<typeof buildCodeReviewMessages>,
): string {
  const user = messages[1]
  if (user === undefined) throw new Error('no user message')
  const part = user.content[0]
  if (part === undefined || part.type !== 'text') throw new Error('no text part')
  return part.text
}

describe('language review packs (U10)', () => {
  it('selects ts + sql from a mixed chunk and keeps declaration order', () => {
    expect(selectLangPacks(['src/a.ts', 'db/migrate.sql', 'README.md'])).toEqual([
      'ts',
      'sql',
    ])
    expect(LANG_PACK_IDS).toEqual(['ts', 'py', 'go', 'sql'])
  })

  it('unknown extensions contribute nothing', () => {
    expect(selectLangPacks(['README.md', 'Makefile', 'foo.unknown'])).toEqual([])
    expect(packRubric([], selectLangPacks(['docs/note.md']))).toBeUndefined()
  })

  it('.ts + .sql chunk prompt carries both language lenses', () => {
    const langs = selectLangPacks(['src/a.ts', 'db/q.sql'])
    const text = promptText(
      buildCodeReviewMessages('o/r', '1', 'diff', 0, 1, [], [], langs),
    )
    expect(text).toContain('Active language lenses')
    expect(text).toContain('TypeScript/JavaScript lens')
    expect(text).toContain('SQL lens')
    expect(text).not.toContain('Python lens')
  })

  it('composes with review profiles', () => {
    const text = promptText(
      buildCodeReviewMessages(
        'o/r',
        '1',
        'diff',
        0,
        1,
        ['security'],
        [],
        selectLangPacks(['main.py']),
      ),
    )
    expect(text).toContain('Active review lenses')
    expect(text).toContain('Security lens')
    expect(text).toContain('Active language lenses')
    expect(text).toContain('Python lens')
  })

  it('review.langPacks defaults true; literal false opts out', () => {
    expect(resolveConfig({}).review.langPacks).toBe(true)
    expect(resolveConfig({ review: { langPacks: false } }).review.langPacks).toBe(false)
    expect(resolveConfig({ review: { langPacks: 'no' as never } }).review.langPacks).toBe(
      true,
    )
  })

  it('maps common JS/TS extensions to the ts pack', () => {
    expect(selectLangPacks(['a.tsx', 'b.mjs', 'c.cjs', 'd.jsx'])).toEqual(['ts'])
  })

  it('maps .go and .py', () => {
    expect(selectLangPacks(['pkg/x.go', 'scripts/y.py'])).toEqual(['py', 'go'])
  })
})
