import { CallCost } from './cost.js';
export interface LedgerState {
    visionCostUsd: number;
    sandboxSeconds: number;
    budgetExceeded: boolean;
    replayOnly: boolean;
    calls: CallCost[];
}
export declare class Ledger {
    private _budgetUsd;
    private _visionCostUsd;
    private _sandboxStartedAt;
    private _sandboxSeconds;
    private _calls;
    private _budgetExceeded;
    private _replayOnly;
    constructor(_budgetUsd: number | undefined);
    get state(): LedgerState;
    get budgetExceeded(): boolean;
    get replayOnly(): boolean;
    get visionCostUsd(): number;
    get sandboxSeconds(): number;
    get calls(): CallCost[];
    startSandbox(): void;
    stopSandbox(): void;
    recordCall(cost: CallCost): void;
    canSpend(estimatedUsd: number): boolean;
    flagBudgetExceeded(): void;
}
