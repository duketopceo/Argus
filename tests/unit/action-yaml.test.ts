import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// GitHub's action loader rejects an unquoted plain scalar that contains ": "
// ("Mapping values are not allowed in this context"), which breaks every
// workflow pinned to the action. There is no YAML parser in the dependency
// tree, so this guards the one shape that bit us: plain one-line values.
describe('action/action.yml', () => {
  const lines = readFileSync(join(__dirname, '../../action/action.yml'), 'utf8').split('\n')

  it('has no unquoted plain scalar containing ": "', () => {
    const bad = lines
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => {
        const m = /^\s*[\w-]+: (.+)$/.exec(line)
        if (!m) return false
        const value = m[1]
        if (/^["'|>]/.test(value)) return false
        return value.includes(': ')
      })
      .map(({ line, n }) => `${n}: ${line.trim()}`)
    expect(bad).toEqual([])
  })
})
