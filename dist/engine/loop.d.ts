import { BrowserDriver, Observation } from '../driver/browser.js';
import { Actions } from './actions.js';
import { Config, ProviderRules } from '../config.js';
import { CallCost, CallKind } from '../vision/cost.js';
import { Ledger } from '../vision/ledger.js';
import { JsonSchema, Message } from '../vision/openrouter.js';
import { FingerprintRecord, Point } from '../cache/fingerprint.js';
import { CachedAssert, FlowCache } from '../cache/store.js';
import { ErrorRecord } from '../journal/schema.js';
import { Logger } from '../log.js';
import { AssertionResult } from './prompts.js';
export interface VisionClient {
    complete(opts: {
        model: string;
        messages: Message[];
        schema?: JsonSchema;
        escalationModels?: string[];
        provider?: ProviderRules;
        kind?: CallKind;
    }): Promise<{
        id: string;
        content: string;
        cost: CallCost;
        model: string;
    }>;
}
export interface TestDriverApi {
    click(x: number, y: number): Promise<Observation>;
    type(text: string): Promise<Observation>;
    pressKeys(keys: string[]): Promise<Observation>;
    scroll(dx: number, dy: number): Promise<Observation>;
    wait(ms: number): Promise<Observation>;
}
export interface EngineOptions {
    driver: BrowserDriver;
    actions: Actions;
    client: VisionClient;
    ledger: Ledger;
    config: Config;
    /** Assertion verdicts persisted from a prior run of this flow. */
    initialAsserts?: CachedAssert[];
    /** Leveled logger; silent when absent. */
    logger?: Logger;
}
export interface RecordOptions {
    flowName?: string;
    stepCap?: number;
}
export interface ReplayOptions {
    flowName?: string;
}
export interface StepResult {
    instruction: string;
    action: string;
    ok: boolean;
    reason?: string;
    healed?: boolean;
    model?: string;
}
export interface RunResult {
    ok: boolean;
    reason?: string;
    steps: StepResult[];
    visionCalls: number;
}
export interface AssertResult extends AssertionResult {
    cached: boolean;
}
export interface LocateResult {
    ok: boolean;
    reason: string | undefined;
    healed: boolean;
    point: Point | undefined;
    fingerprint: FingerprintRecord | undefined;
    model: string | undefined;
}
export declare class Engine {
    private _opts;
    private _visionCalls;
    private _steps;
    private _fingerprints;
    private _assertCache;
    private _errors;
    /** Structured, non-fatal anomalies — journaled as evidence, never thrown. */
    get errorRecords(): ErrorRecord[];
    private _note;
    constructor(_opts: EngineOptions);
    /** Assertion verdicts collected/known this run — persist into the flow cache. */
    get assertEntries(): CachedAssert[];
    get visionCalls(): number;
    record(instruction: string, tdApi?: TestDriverApi, options?: RecordOptions): Promise<RunResult>;
    replay(flow: FlowCache, options?: ReplayOptions): Promise<RunResult>;
    /**
     * Resolve a single element for the `td.find()` DSL (R13). When `cached` is
     * provided and still resolves locally, this costs zero vision calls (R2);
     * otherwise it grounds (or heals) via the model and returns a fresh
     * fingerprint (R4). The returned point is the viewport-pixel click target.
     */
    locate(instruction: string, cached?: FingerprintRecord): Promise<LocateResult>;
    /**
     * One locate attempt against a specific model: initial call plus the
     * verify-then-correct loop. `modelOverride` is the escalation fallback —
     * it keeps the action schema unless a specialist grounding model is in
     * play (native "(x,y)" format).
     */
    private _locateWithModel;
    assert(question: string): Promise<AssertResult>;
    private _callModel;
    private _parseAction;
    private _parseAssertion;
    private _resolveAction;
    private _resolveNode;
    private _executeAction;
    private _buildFingerprint;
    private _regionScreenshot;
    private _result;
}
export declare function instructionMatchesNode(instruction: string, nodeSnippet: string): boolean;
