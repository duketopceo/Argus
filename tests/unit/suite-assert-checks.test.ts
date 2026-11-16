import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Td } from '../../src/api.js'

/**
 * `td.assert` resolves to a result object, which is always truthy. A check
 * written `if (!ok)` therefore never fires. These tests load the repo's own
 * td-DSL suite and prove every test body throws when its assertion fails and
 * passes when it holds, so a dead check cannot come back.
 */
const suiteDir = join(import.meta.dirname, '..', '..', 'evals', 'suite')

interface Captured {
  name: string
  fn: (td: Td) => Promise<void>
}

async function loadSuite(file: string): Promise<Captured[]> {
  const captured: Captured[] = []
  const g = globalThis as unknown as { test?: (name: string, fn: Captured['fn']) => void }
  const previous = g.test
  g.test = (name, fn) => {
    captured.push({ name, fn })
  }
  try {
    await import(`${pathToFileURL(join(suiteDir, file)).href}?t=${Math.random()}`)
  } finally {
    g.test = previous
  }
  return captured
}

function stubTd(verdict: 'pass' | 'fail'): Td {
  const handle = { click: async () => {}, doubleClick: async () => {} }
  return {
    find: () => handle,
    type: async () => {},
    pressKeys: async () => {},
    wait: async () => {},
    scroll: async () => {},
    assert: async () => ({ verdict, reasoning: 'stub', cached: false }),
  } as unknown as Td
}

describe('evals/suite assertion checks', () => {
  const files = readdirSync(suiteDir).filter((f) => f.endsWith('.test.ts'))

  it('finds the suite files', () => {
    expect(files.length).toBeGreaterThanOrEqual(3)
  })

  for (const file of files) {
    it(`${file} throws when the assertion fails`, async () => {
      const tests = await loadSuite(file)
      expect(tests.length).toBeGreaterThan(0)
      for (const t of tests) {
        await expect(t.fn(stubTd('fail'))).rejects.toThrow()
      }
    })

    it(`${file} passes when the assertion holds`, async () => {
      const tests = await loadSuite(file)
      for (const t of tests) {
        await expect(t.fn(stubTd('pass'))).resolves.toBeUndefined()
      }
    })
  }
})
