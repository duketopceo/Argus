import { FingerprintRecord } from './fingerprint.js';
/** A cached assertion verdict, keyed on (question, page-state hash). */
export interface CachedAssert {
    question: string;
    /** FNV-1a hash of the a11y snapshot at assert time — stable across pixel noise. */
    a11yHash: string;
    verdict: 'pass' | 'fail';
    reasoning: string;
    model: string | undefined;
}
export interface FlowCache {
    steps: FingerprintRecord[];
    asserts?: CachedAssert[];
}
export declare function flowPath(cacheDir: string, flowName: string): string;
export declare function loadFlow(cacheDir: string, flowName: string): Promise<FlowCache | undefined>;
export declare function saveFlow(cacheDir: string, flowName: string, steps: FingerprintRecord[], asserts?: CachedAssert[]): Promise<void>;
