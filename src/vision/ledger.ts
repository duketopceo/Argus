import { CallCost } from './cost.js'

export interface LedgerState {
  visionCostUsd: number
  sandboxSeconds: number
  budgetExceeded: boolean
  replayOnly: boolean
  calls: CallCost[]
}

export class Ledger {
  private _visionCostUsd = 0
  private _sandboxStartedAt: number | undefined
  private _sandboxSeconds = 0
  private _calls: CallCost[] = []
  private _budgetExceeded = false
  private _replayOnly = false

  constructor(private _budgetUsd: number | undefined) {}

  get state(): LedgerState {
    return {
      visionCostUsd: this._visionCostUsd,
      sandboxSeconds: this._sandboxSeconds,
      budgetExceeded: this._budgetExceeded,
      replayOnly: this._replayOnly,
      calls: [...this._calls],
    }
  }

  get budgetExceeded(): boolean {
    return this._budgetExceeded
  }

  get replayOnly(): boolean {
    return this._replayOnly
  }

  get visionCostUsd(): number {
    return this._visionCostUsd
  }

  get sandboxSeconds(): number {
    return this._sandboxSeconds
  }

  get calls(): CallCost[] {
    return [...this._calls]
  }

  startSandbox(): void {
    this._sandboxStartedAt = Date.now()
  }

  stopSandbox(): void {
    if (this._sandboxStartedAt === undefined) return
    this._sandboxSeconds += (Date.now() - this._sandboxStartedAt) / 1000
    this._sandboxStartedAt = undefined
  }

  recordCall(cost: CallCost): void {
    this._calls.push(cost)
    this._visionCostUsd += cost.costUsd
  }

  canSpend(estimatedUsd: number): boolean {
    if (this._budgetUsd === undefined) return true
    if (this._budgetExceeded) return false
    const projected = this._visionCostUsd + estimatedUsd
    if (projected <= this._budgetUsd) return true
    this._budgetExceeded = true
    this._replayOnly = true
    return false
  }

  flagBudgetExceeded(): void {
    this._budgetExceeded = true
    this._replayOnly = true
  }
}
