import type { Target } from '../config.js';
/**
 * Poll `url` until it answers with HTTP 2xx/3xx or the timeout elapses.
 * Non-http(s) schemes (e.g. file://) cannot be fetched, so they are treated
 * as immediately ready — Playwright navigates them directly.
 */
export declare function waitForReady(url: string, timeoutMs: number): Promise<void>;
/**
 * Boot adapter for the run target (R11): spawn a shell command, poll the URL
 * until it answers with HTTP 2xx/3xx or the ready timeout elapses, then let
 * the run proceed. stop() kills the whole spawned process tree.
 */
export declare class TargetProcess {
    private readonly child;
    private readonly spec;
    private stopped;
    private constructor();
    get url(): string;
    get pid(): number | undefined;
    static start(spec: Target): Promise<TargetProcess>;
    /** Kill the spawned process tree (process group). Idempotent. */
    stop(): Promise<void>;
}
