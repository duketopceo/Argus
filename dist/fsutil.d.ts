/**
 * Atomic text write via tmp+rename — the one place the pattern lives.
 * Callers: cache store, journal store, repo index, evidence report.
 */
export declare function writeAtomicText(path: string, text: string): Promise<void>;
export declare function writeAtomicJson(path: string, value: unknown, replacer?: (key: string, v: unknown) => unknown): Promise<void>;
