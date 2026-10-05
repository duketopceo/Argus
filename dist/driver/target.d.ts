import type { Target } from '../config.js';
/**
 * Poll `url` until it answers with HTTP 2xx/3xx or the timeout elapses.
 * Non-http(s) schemes (e.g. file://) cannot be fetched, so they are treated
 * as immediately ready — Playwright navigates them directly. An
 * absent/non-finite timeout falls back to the default rather than NaN-ing
 * the deadline into a hang; each fetch is itself time-bounded so a
 * connect-then-silent endpoint can't park a poll.
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
export interface KeepAliveHoldDeps {
    /** Sleep step between deadline/signal checks — injectable for tests. */
    sleep?: (ms: number) => Promise<void>;
}
/**
 * Hold a still-running target for `ttlMs` after a failed run so a human can
 * inspect the live app, then return so the caller's teardown proceeds.
 * SIGINT/SIGTERM end the hold early: swallowing them would leak the
 * detached process group the caller's `finally` is about to kill. The hold
 * keeps the *server* only: argus's own browser is headless and already
 * closed at this point, so the connect story is a headed relaunch
 * (`inspectInstructions`).
 */
export declare function holdTargetForDebug(url: string, ttlMs: number, note: (line: string) => void, deps?: KeepAliveHoldDeps): Promise<void>;
