import { describe, expect, it } from 'vitest'

import { dependentCone, invalidateForDiff } from '../../src/index/invalidate.js'
import { INDEX_SCHEMA_VERSION, RepoIndex } from '../../src/index/scan.js'

function indexOf(entries: Array<[string, string[]]>): RepoIndex {
  // [path, importedBy]
  return {
    schemaVersion: INDEX_SCHEMA_VERSION,
    generatedAt: '',
    root: '',
    entries: entries.map(([path, importedBy]) => ({ path, imports: [], importedBy, contentHash: 'x' })),
  }
}

const GLOBS = ['ui/src/**']

describe('invalidateForDiff', () => {
  it('marks stale when a changed file is inside the source surface', () => {
    const r = invalidateForDiff(['ui/src/pages/Dev.tsx'], undefined, GLOBS, [])
    expect(r.stale).toBe(true)
    expect(r.changedInSurface).toContain('ui/src/pages/Dev.tsx')
  })

  it('marks stale when a shared component used by a page changes (dependent cone)', () => {
    const index = indexOf([
      ['ui/src/components/Card.tsx', ['ui/src/pages/Dev.tsx']],
      ['ui/src/pages/Dev.tsx', []],
    ])
    const r = invalidateForDiff(['ui/src/components/Card.tsx'], index, GLOBS, [])
    expect(r.stale).toBe(true)
    expect(r.reason).toContain('ui/src/pages/Dev.tsx')
  })

  it('does not invalidate on docs-only changes', () => {
    const index = indexOf([
      ['ui/src/pages/Dev.tsx', []],
      ['README.md', []],
    ])
    const r = invalidateForDiff(['README.md', 'docs/plan.md'], index, GLOBS, [])
    expect(r.stale).toBe(false)
  })

  it('does not invalidate on an empty diff', () => {
    expect(invalidateForDiff([], undefined, GLOBS, []).stale).toBe(false)
  })

  it('without sourceGlobs, a change in a test file’s cone invalidates', () => {
    const index = indexOf([
      ['e2e/helpers.ts', ['e2e/flow.test.ts']],
      ['e2e/flow.test.ts', []],
    ])
    const r = invalidateForDiff(['e2e/helpers.ts'], index, undefined, ['e2e/flow.test.ts'])
    expect(r.stale).toBe(true)
  })
})

describe('dependentCone', () => {
  it('walks transitive importedBy edges', () => {
    const index = indexOf([
      ['a.ts', ['b.ts']],
      ['b.ts', ['c.ts']],
      ['c.ts', []],
    ])
    expect(dependentCone(index, ['a.ts'])).toEqual(new Set(['a.ts', 'b.ts', 'c.ts']))
  })
})
