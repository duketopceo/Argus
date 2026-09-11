/**
 * Fingerprint record per KTD5: the durable, replayable identity of a single
 * model-resolved step.  Resolve compares a freshly captured element region
 * against the stored hash and verifies the a11y snippet is still present.
 *
 * The region hash is a simple 64-bit average-hash over the raw bytes of the
 * cropped JPEG screenshot region.  It is fast, dependency-free, and stable
 * enough for pinned-viewport fixtures.
 */
export interface Bbox {
    x: number;
    y: number;
    width: number;
    height: number;
}
export interface Point {
    x: number;
    y: number;
}
export interface ActionPayload {
    action: 'click' | 'type' | 'pressKeys' | 'scroll' | 'wait' | 'done' | 'fail';
    x?: number;
    y?: number;
    text?: string;
    keys?: string[];
    dx?: number;
    dy?: number;
    ms?: number;
}
export interface FingerprintRecord {
    instruction: string;
    action: ActionPayload;
    bbox: Bbox;
    clickPoint: Point;
    model: string;
    a11ySnippet: string;
    regionHash: string;
    /**
     * Set by diff-aware invalidation before replay: the reason this entry is
     * considered stale. Presence means "re-ground on next use" — the entry is
     * kept for reference/heal context.
     */
    stale?: string;
}
export interface ResolveResult {
    matched: boolean;
    currentHash: string;
    regionMatched: boolean;
    a11yMatched: boolean;
}
export declare function computeRegionHash(buffer: Buffer, bits?: number): string;
export declare class Fingerprint {
    readonly record: FingerprintRecord;
    constructor(record: FingerprintRecord);
    resolve(regionScreenshot: Buffer, a11yYaml: string): ResolveResult;
    mismatch(regionScreenshot: Buffer, a11yYaml: string): boolean;
}
/** FNV-1a 32-bit hash - stable content hash for the a11y snapshot text. */
export declare function fnv1a(text: string): string;
