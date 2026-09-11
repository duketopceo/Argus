import { BrowserDriver } from './driver/browser.js';
import { VisionClient } from './engine/loop.js';
import { AssertionResult } from './engine/prompts.js';
import { FingerprintRecord } from './cache/fingerprint.js';
import { Ledger, LedgerState } from './vision/ledger.js';
import { Config, defineConfig } from './config.js';
import { ErrorRecord } from './journal/schema.js';
import { Logger } from './log.js';
export { defineConfig };
/**
 * Test-facing API (R13). Test files are plain TypeScript using a `td` object:
 *
 *   test('landing', async (td) => {
 *     await td.find('the "See pricing" button').click()
 *     await td.type('user@example.com')
 *     await td.pressKeys(['tab'])
 *     const ok = await td.assert('The pricing section is visible')
 *   })
 *
 * `td` calls resolve elements through the engine's fingerprint cache — a
 * cache hit costs zero vision calls, a miss grounds (or heals) via the model.
 */
export interface TypeOptions {
    /**
     * When true, `text` is a secret name: the typed value comes from
     * `config.secrets[name]` (or the `name` environment variable) and is never
     * sent to the model. The model only resolves which field receives it.
     */
    secret?: boolean;
}
export interface TdHandle {
    click(): Promise<void>;
    doubleClick(): Promise<void>;
}
export interface Td {
    find(description: string): TdHandle;
    type(text: string, options?: TypeOptions): Promise<void>;
    pressKeys(keys: string[]): Promise<void>;
    assert(question: string): Promise<AssertionResult>;
    wait(ms: number): Promise<void>;
    scroll(dx: number, dy: number): Promise<void>;
}
export interface TdStepRecord {
    instruction: string;
    action: string;
    ok: boolean;
    healed: boolean;
    model: string | undefined;
    reason: string | undefined;
}
export interface TdAssertRecord extends AssertionResult {
    question: string;
    cached: boolean;
}
export interface HealEvent {
    instruction: string;
    model: string | undefined;
}
export interface TdSessionOptions {
    driver: BrowserDriver;
    client: VisionClient;
    config: Config;
    /** Flow name used to load/save the fingerprint cache for this test. */
    flowName?: string;
    env?: NodeJS.ProcessEnv;
    /**
     * Set by the run path when diff-aware invalidation fired — marks every
     * loaded fingerprint `stale` so they re-ground on first use.
     */
    staleReason?: string;
    logger?: Logger;
}
export declare function normalizeKey(key: string): string;
/**
 * One session per executed test. Owns the ledger + engine, replays the
 * per-test fingerprint cache, and records steps/heals/asserts for the report.
 */
export declare class TdSession {
    private readonly opts;
    readonly td: Td;
    readonly ledger: Ledger;
    readonly steps: TdStepRecord[];
    readonly asserts: TdAssertRecord[];
    readonly healEvents: HealEvent[];
    private readonly engine;
    private readonly actions;
    private readonly flow;
    private readonly fingerprints;
    private _failed;
    private _failureReason;
    private constructor();
    static create(opts: TdSessionOptions): Promise<TdSession>;
    get visionCalls(): number;
    /** Non-fatal anomalies observed by the engine — journaled as evidence. */
    get errorRecords(): ErrorRecord[];
    get failed(): boolean;
    get failureReason(): string | undefined;
    get ledgerState(): LedgerState;
    /** Persist the (possibly healed) fingerprints back to the cache (R4, R5). */
    save(): Promise<void>;
    private _record;
    private _locate;
    private _makeTd;
}
export interface RegisteredTest {
    name: string;
    fn: (td: Td) => void | Promise<void>;
}
/** Register a test; called by test files at import time. */
export declare function test(name: string, fn: (td: Td) => void | Promise<void>): void;
/** Drain the registry — the runner calls this after importing a test file. */
export declare function takeTests(): RegisteredTest[];
/** Bind the session the ambient `td` proxy delegates to. Internal to the runner. */
export declare function bindSession(session: TdSession | undefined): void;
/**
 * Ambient `td` for test files that use top-level calls instead of `test()`.
 * The CLI also exposes this as `globalThis.td` while importing test files.
 */
export declare const td: Td;
/** Render a recorded flow as a plain-TS test file (R13). */
export declare function renderTestFile(flowName: string, steps: FingerprintRecord[]): string;
