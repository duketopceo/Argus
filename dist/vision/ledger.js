export class Ledger {
    _budgetUsd;
    _visionCostUsd = 0;
    _sandboxStartedAt;
    _sandboxSeconds = 0;
    _calls = [];
    _budgetExceeded = false;
    _replayOnly = false;
    constructor(_budgetUsd) {
        this._budgetUsd = _budgetUsd;
    }
    get state() {
        return {
            visionCostUsd: this._visionCostUsd,
            sandboxSeconds: this._sandboxSeconds,
            budgetExceeded: this._budgetExceeded,
            replayOnly: this._replayOnly,
            calls: [...this._calls],
        };
    }
    get budgetExceeded() {
        return this._budgetExceeded;
    }
    get replayOnly() {
        return this._replayOnly;
    }
    get visionCostUsd() {
        return this._visionCostUsd;
    }
    get sandboxSeconds() {
        return this._sandboxSeconds;
    }
    get calls() {
        return [...this._calls];
    }
    startSandbox() {
        this._sandboxStartedAt = Date.now();
    }
    stopSandbox() {
        if (this._sandboxStartedAt === undefined)
            return;
        this._sandboxSeconds += (Date.now() - this._sandboxStartedAt) / 1000;
        this._sandboxStartedAt = undefined;
    }
    recordCall(cost) {
        this._calls.push(cost);
        this._visionCostUsd += cost.costUsd;
    }
    canSpend(estimatedUsd) {
        if (this._budgetUsd === undefined)
            return true;
        if (this._budgetExceeded)
            return false;
        const projected = this._visionCostUsd + estimatedUsd;
        if (projected <= this._budgetUsd)
            return true;
        this._budgetExceeded = true;
        this._replayOnly = true;
        return false;
    }
    flagBudgetExceeded() {
        this._budgetExceeded = true;
        this._replayOnly = true;
    }
}
