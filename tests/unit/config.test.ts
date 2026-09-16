import { describe, expect, it } from 'vitest'

import { DEFAULT_SANDBOX, resolveConfig } from '../../src/config.js'

describe('resolveConfig sandbox', () => {
  it('populates disabled defaults when sandbox is absent (KTD5)', () => {
    const config = resolveConfig()
    expect(config.sandbox).toEqual({
      enabled: false,
      // image is resolved at probe time to node:<host major>-slim.
      image: undefined,
      maxProbes: 3,
      timeoutMs: 120_000,
      memory: '2g',
      cpus: '2',
      pidsLimit: 256,
      allowForks: false,
    })
    expect(config.sandbox).toEqual(DEFAULT_SANDBOX)
  })

  it('fills unspecified fields of a partial sandbox block with defaults', () => {
    const config = resolveConfig({ sandbox: { enabled: true } })
    expect(config.sandbox.enabled).toBe(true)
    expect(config.sandbox.image).toBeUndefined()
    expect(config.sandbox.maxProbes).toBe(3)
    expect(config.sandbox.timeoutMs).toBe(120_000)
    expect(config.sandbox.memory).toBe('2g')
    expect(config.sandbox.cpus).toBe('2')
    expect(config.sandbox.pidsLimit).toBe(256)
    expect(config.sandbox.allowForks).toBe(false)
  })

  it('keeps explicit overrides', () => {
    const config = resolveConfig({
      sandbox: {
        enabled: true,
        image: 'node:20-slim',
        maxProbes: 5,
        timeoutMs: 60_000,
        memory: '4g',
        cpus: '4',
        pidsLimit: 128,
        allowForks: true,
      },
    })
    expect(config.sandbox).toEqual({
      enabled: true,
      image: 'node:20-slim',
      maxProbes: 5,
      timeoutMs: 60_000,
      memory: '4g',
      cpus: '4',
      pidsLimit: 128,
      allowForks: true,
    })
  })

  it('normalizes non-finite maxProbes/timeoutMs/pidsLimit to defaults', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const config = resolveConfig({ sandbox: { maxProbes: bad, timeoutMs: bad, pidsLimit: bad } })
      expect(config.sandbox.maxProbes).toBe(DEFAULT_SANDBOX.maxProbes)
      expect(config.sandbox.timeoutMs).toBe(DEFAULT_SANDBOX.timeoutMs)
      expect(config.sandbox.pidsLimit).toBe(DEFAULT_SANDBOX.pidsLimit)
    }
  })

  it('normalizes non-positive and fractional numeric fields like recordStepCap', () => {
    const bad = resolveConfig({ sandbox: { maxProbes: 0, timeoutMs: -5, pidsLimit: 0 } })
    expect(bad.sandbox.maxProbes).toBe(DEFAULT_SANDBOX.maxProbes)
    expect(bad.sandbox.timeoutMs).toBe(DEFAULT_SANDBOX.timeoutMs)
    expect(bad.sandbox.pidsLimit).toBe(DEFAULT_SANDBOX.pidsLimit)
    expect(resolveConfig({ sandbox: { maxProbes: 2.9 } }).sandbox.maxProbes).toBe(2)
  })

  it('returns a fresh sandbox per resolve — no shared state with defaults', () => {
    const a = resolveConfig()
    a.sandbox.maxProbes = 99
    expect(resolveConfig().sandbox.maxProbes).toBe(DEFAULT_SANDBOX.maxProbes)
    expect(DEFAULT_SANDBOX.maxProbes).toBe(3)
  })
})
