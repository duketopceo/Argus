import { describe, expect, it } from 'vitest'

import type { ExecFn } from '../../src/detect.js'
import { discoverOcr } from '../../src/review/static.js'

function fakeExec(r: { stdout: string; stderr: string; code: number }): ExecFn {
  return async () => r
}

describe('discoverOcr', () => {
  it('reports not-installed on exit 127', async () => {
    const d = await discoverOcr('ocr', fakeExec({ stdout: '', stderr: '', code: 127 }))
    expect(d.found).toBe(false)
    expect(d.reason).toBe('not-installed')
  })

  it('reports found with version on exit 0', async () => {
    const d = await discoverOcr('ocr', fakeExec({ stdout: 'ocr 1.2.3', stderr: '', code: 0 }))
    expect(d.found).toBe(true)
    expect(d.version).toBe('ocr 1.2.3')
  })

  it('reports crashed on any other nonzero exit', async () => {
    const d = await discoverOcr('ocr', fakeExec({ stdout: '', stderr: 'panic', code: 2 }))
    expect(d.found).toBe(false)
    expect(d.reason).toBe('crashed')
  })
})
