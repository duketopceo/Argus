import { BrowserDriver } from '../driver/browser.js';
import { Actions } from './actions.js';
import { Config } from '../config.js';
import { ErrorRecord } from '../journal/schema.js';
import { Logger } from '../log.js';
import { Ledger } from '../vision/ledger.js';
import { ExploreAction } from './prompts.js';
import type { VisionClient } from './loop.js';
export type ExploreStopReason = 'done' | 'max-steps' | 'budget' | 'stalled' | 'error';
export interface ExploreStep {
    action: string;
    /** Page URL after the act. */
    url: string;
    /** Refusal/execution note (e.g. 'refused: cross-origin'). */
    note?: string;
}
export interface ExploreResult {
    steps: ExploreStep[];
    /** Distinct page URLs visited during the pass. */
    visited: number;
    stopReason: ExploreStopReason;
    visionCalls: number;
    /** Spend attributable to this explore pass (delta over the shared ledger). */
    visionCostUsd: number;
    notes: ErrorRecord[];
}
export interface ExploreOptions {
    driver: BrowserDriver;
    actions: Actions;
    client: VisionClient;
    ledger: Ledger;
    config: Config;
    /** Resolved run URL — the structural origin bound for `navigate`. */
    targetUrl: string;
    logger?: Logger;
}
/**
 * Free-explore act policy (U4b): observe → propose → bound → execute →
 * repeat, with no recorded flow. Every proposal is validated against the
 * action vocabulary, the same-origin navigation bound, and the input caps
 * before it reaches the driver — model output is a proposal, never an
 * instruction (R8). The loop halts on done, maxSteps, budget, stall, or an
 * execution error; it never throws.
 */
export declare function runExplore(opts: ExploreOptions): Promise<ExploreResult>;
/**
 * Tolerant parse of the explore proposal, mirroring Engine's `_parseAction`
 * shape: strict JSON first, the {"click": "(x,y)"} variant, then a bare
 * coordinate extraction for specialist models. Returns undefined when
 * nothing usable can be recovered — the caller counts it as a step.
 */
export declare function parseExploreAction(content: string): ExploreAction | undefined;
