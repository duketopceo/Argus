import { Observation } from '../driver/browser.js';
import { JsonSchema, Message } from '../vision/openrouter.js';
import { ActionPayload } from '../cache/fingerprint.js';
export interface ProposedAction extends ActionPayload {
    reasoning: string;
}
/**
 * Explore-lane action (U4b): the record/replay vocabulary plus `navigate`.
 * Kept separate from `ActionPayload` — explored actions are never
 * fingerprinted or replayed, so the flow-cache schema stays unchanged.
 */
export interface ExploreAction {
    action: 'click' | 'type' | 'pressKeys' | 'scroll' | 'wait' | 'navigate' | 'done' | 'fail';
    x?: number;
    y?: number;
    text?: string;
    keys?: string[];
    dx?: number;
    dy?: number;
    ms?: number;
    url?: string;
    reasoning: string;
}
export interface AssertionResult {
    verdict: 'pass' | 'fail';
    reasoning: string;
}
export declare const actionSchema: JsonSchema;
export declare const exploreActionSchema: JsonSchema;
export declare const assertionSchema: JsonSchema;
/** One executed record step as it appears in the next prompt's transcript. */
export interface PriorAction {
    action: ActionPayload;
    /** Resolved element label (a11y snippet) when the action hit a node. */
    label?: string;
}
/** Compact one-line rendering of an executed action for the record transcript. */
export declare function describeAction(action: ActionPayload | ExploreAction, label?: string): string;
export declare function buildActionMessages(instruction: string, observation: Observation, priorActions?: PriorAction[]): Message[];
/** One executed explore act as it appears in the next prompt's transcript. */
export interface PriorAct {
    action: ExploreAction;
    /** Page URL after the act — lets the model see where it ended up. */
    url: string;
    /** Refusal/execution note shown next to the act in the transcript. */
    note?: string;
}
export declare function buildExploreMessages(observation: Observation, priorActs?: PriorAct[], task?: string): Message[];
export declare function buildAssertMessages(question: string, observation: Observation): Message[];
