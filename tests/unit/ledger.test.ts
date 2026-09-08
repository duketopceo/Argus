import { describe, expect, it } from 'vitest'
import { Ledger } from '../../src/vision/ledger.js'

const sampleCall = {
  model: 'qwen/qwen3.7-flash',
  provider: 'deepinfra',
  tokens: 100,
  costUsd: 0.001,
  kind: 'ground' as const,
}

describe('Ledger', () => {
  it('allows a call that fits inside the budget', () => {
    const ledger = new Ledger(1.0)
    expect(ledger.canSpend(0.5)).toBe(true)
    expect(ledger.budgetExceeded).toBe(false)
    expect(ledger.replayOnly).toBe(false)
  })

  it('rejects a call that would exceed the budget and flags budget_exceeded + replay-only', () => {
    const ledger = new Ledger(0.05)
    ledger.recordCall({ ...sampleCall, costUsd: 0.04 })
    expect(ledger.canSpend(0.02)).toBe(false)
    expect(ledger.budgetExceeded).toBe(true)
    expect(ledger.replayOnly).toBe(true)
  })

  it('keeps the cap binding after it is first exceeded', () => {
    const ledger = new Ledger(0.05)
    ledger.recordCall({ ...sampleCall, costUsd: 0.06 })
    expect(ledger.canSpend(0.001)).toBe(false)
    expect(ledger.budgetExceeded).toBe(true)
    expect(ledger.replayOnly).toBe(true)
  })

  it('records sandbox wall-clock seconds', async () => {
    const ledger = new Ledger(undefined)
    ledger.startSandbox()
    await new Promise((resolve) => setTimeout(resolve, 50))
    ledger.stopSandbox()
    expect(ledger.sandboxSeconds).toBeGreaterThan(0.03)
  })

  it('sums vision call costs into the running total', () => {
    const ledger = new Ledger(undefined)
    ledger.recordCall({ ...sampleCall, costUsd: 0.012 })
    ledger.recordCall({ ...sampleCall, costUsd: 0.009, kind: 'heal' })
    expect(ledger.visionCostUsd).toBeCloseTo(0.021, 6)
    expect(ledger.calls).toHaveLength(2)
  })
})
