import { describe, expect, it } from 'vitest'

import { DEFAULTS, resolveStaticLaneConfig } from '../../src/review/static.js'

describe('resolveStaticLaneConfig', () => {
  it('defaults to disabled when given {}', () => {
    expect(resolveStaticLaneConfig({}).enabled).toBe(false)
  })

  it('defaults timeout to 180_000', () => {
    expect(resolveStaticLaneConfig({}).timeoutMs).toBe(180_000)
    expect(DEFAULTS.timeoutMs).toBe(180_000)
  })

  it('accepts explicit bin', () => {
    const c = resolveStaticLaneConfig({ enabled: true, bin: '/opt/ocr' })
    expect(c.bin).toBe('/opt/ocr')
    expect(c.enabled).toBe(true)
  })

  it('throws on timeoutMs: -1', () => {
    expect(() => resolveStaticLaneConfig({ timeoutMs: -1 })).toThrow()
  })
})
