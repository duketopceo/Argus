import { describe, expect, it } from 'vitest'

import { DEFAULT_REVIEW_EXCLUDE, globMatch, partitionByExclude } from '../../src/review/scope.js'
import { resolveConfig } from '../../src/config.js'

describe('globMatch', () => {
  it('handles **, *, and nested lockfiles', () => {
    expect(globMatch('dist/**', 'dist/cli.js')).toBe(true)
    expect(globMatch('dist/**', 'dist/a/b/c.js')).toBe(true)
    expect(globMatch('dist/**', 'src/dist/c.js')).toBe(false)
    expect(globMatch('**/*.generated.*', 'src/a/b.generated.ts')).toBe(true)
    expect(globMatch('**/*.generated.*', 'b.generated.ts')).toBe(true)
    expect(globMatch('**/package-lock.json', 'package-lock.json')).toBe(true)
    expect(globMatch('**/package-lock.json', 'web/package-lock.json')).toBe(true)
    expect(globMatch('*.md', 'docs/a.md')).toBe(false)
  })
})

describe('partitionByExclude', () => {
  const names = [
    'src/cli.ts',
    'dist/cli.js',
    'fixtures/manifests/a.json',
    'tests/goldens/comment/x.md',
    'package-lock.json',
    'web/yarn.lock',
    'src/x.generated.ts',
    'assets/brand/export/logo.svg',
    'tests/unit/a.test.ts',
  ]
  const files = names.map((filename) => ({ filename, patch: '@@ -1 +1 @@\n+x' }))

  it('skips generated, fixture and vendored paths by default', () => {
    const { kept, excluded } = partitionByExclude(files, DEFAULT_REVIEW_EXCLUDE)
    expect(kept.map((f) => f.filename)).toEqual(['src/cli.ts', 'tests/unit/a.test.ts'])
    expect(excluded).toHaveLength(7)
  })

  it('an empty list excludes nothing', () => {
    expect(partitionByExclude(files, []).excluded).toHaveLength(0)
  })
})

describe('review.exclude config', () => {
  it('defaults to the built-in list', () => {
    expect(resolveConfig({}).review.exclude).toEqual(DEFAULT_REVIEW_EXCLUDE)
  })
  it('a configured list replaces the defaults; junk degrades to defaults', () => {
    expect(resolveConfig({ review: { exclude: ['gen/**'] } }).review.exclude).toEqual(['gen/**'])
    expect(resolveConfig({ review: { exclude: [] } }).review.exclude).toEqual([])
    expect(
      resolveConfig({ review: { exclude: 'nope' as unknown as string[] } }).review.exclude,
    ).toEqual(DEFAULT_REVIEW_EXCLUDE)
  })
})
