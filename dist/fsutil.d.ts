/**
 * Atomic JSON write via tmp+rename — the one place the pattern lives.
 * Callers: cache store, journal store, repo index.
 */
export declare function writeAtomicJson(path: string, value: unknown, replacer?: (key: string, v: unknown) => unknown): Promise<void>;
