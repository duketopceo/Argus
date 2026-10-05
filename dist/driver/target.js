import { spawn } from 'node:child_process';
import { inspectInstructions } from './browser.js';
const POLL_INTERVAL_MS = 250;
const STOP_GRACE_MS = 3_000;
const DEFAULT_READY_TIMEOUT_MS = 30_000;
const PER_REQUEST_TIMEOUT_MS = 5_000;
/** Sleep granularity during a keep-alive hold: small enough for a snappy Ctrl-C. */
const HOLD_POLL_MS = 1_000;
/**
 * Poll `url` until it answers with HTTP 2xx/3xx or the timeout elapses.
 * Non-http(s) schemes (e.g. file://) cannot be fetched, so they are treated
 * as immediately ready — Playwright navigates them directly. An
 * absent/non-finite timeout falls back to the default rather than NaN-ing
 * the deadline into a hang; each fetch is itself time-bounded so a
 * connect-then-silent endpoint can't park a poll.
 */
export async function waitForReady(url, timeoutMs) {
    if (!/^https?:/i.test(url))
        return;
    const bounded = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_READY_TIMEOUT_MS;
    const deadline = Date.now() + bounded;
    for (;;) {
        try {
            const res = await fetch(url, {
                redirect: 'manual',
                signal: AbortSignal.timeout(PER_REQUEST_TIMEOUT_MS),
            });
            if (res.status >= 200 && res.status < 400)
                return;
        }
        catch {
            // connection refused / not up yet — keep polling
        }
        if (Date.now() >= deadline) {
            throw new Error(`Target did not become ready: ${url} did not respond ` +
                `with HTTP 2xx/3xx within ${bounded}ms`);
        }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
}
/**
 * Boot adapter for the run target (R11): spawn a shell command, poll the URL
 * until it answers with HTTP 2xx/3xx or the ready timeout elapses, then let
 * the run proceed. stop() kills the whole spawned process tree.
 */
export class TargetProcess {
    child;
    spec;
    stopped = false;
    constructor(child, spec) {
        this.child = child;
        this.spec = spec;
    }
    get url() {
        return this.spec.url;
    }
    get pid() {
        return this.child.pid;
    }
    static async start(spec) {
        const child = spawn(spec.command, {
            shell: true,
            detached: true,
            stdio: 'ignore',
        });
        const proc = new TargetProcess(child, spec);
        const childExited = new Promise((_, reject) => {
            child.once('error', (err) => reject(err));
            child.once('exit', (code, signal) => reject(new Error(`Target command exited before ${spec.url} became ready ` +
                `(code=${code ?? 'null'}, signal=${signal ?? 'null'})`)));
        });
        const ready = waitForReady(spec.url, spec.readyTimeoutMs);
        try {
            await Promise.race([ready, childExited]);
            // A squatter already serving the URL resolves `ready` while the real
            // child is still binding (or has just died EADDRINUSE). Give it one
            // poll interval to surface, then refuse: running lanes against the
            // stale server would bind evidence to code that isn't this checkout.
            await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
            if (child.exitCode !== null) {
                throw new Error(`Target command exited (${child.exitCode}) right after ${spec.url} ` +
                    'answered ready — another process is likely already serving that ' +
                    'URL; refusing to run evidence against a server this run did not start');
            }
        }
        catch (e) {
            await proc.stop();
            throw e;
        }
        return proc;
    }
    /** Kill the spawned process tree (process group). Idempotent. */
    async stop() {
        if (this.stopped)
            return;
        this.stopped = true;
        const exited = new Promise((resolve) => {
            this.child.once('exit', () => resolve());
            setTimeout(resolve, STOP_GRACE_MS).unref();
        });
        try {
            // Negative pid kills the detached process group — the shell and its children.
            if (this.child.pid !== undefined)
                process.kill(-this.child.pid, 'SIGTERM');
        }
        catch {
            // already gone
        }
        await exited;
        try {
            // Escalate on the GROUP unconditionally, not on the child's exitCode:
            // a wrapper shell can exit promptly while a spawned server keeps the
            // group (and the port) alive — gating on exitCode leaves it orphaned.
            if (this.child.pid !== undefined)
                process.kill(-this.child.pid, 'SIGKILL');
        }
        catch {
            // already gone
        }
    }
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
export async function holdTargetForDebug(url, ttlMs, note, deps = {}) {
    note(`keep-alive: ${url} stays up for ${Math.round(ttlMs / 1000)}s (Ctrl-C to stop early)`);
    for (const line of inspectInstructions(url))
        note(`  ${line}`);
    const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const deadline = Date.now() + ttlMs;
    let interrupted = false;
    const onSignal = () => {
        interrupted = true;
    };
    // process.on, not once: a second Ctrl-C while the current sleep is in
    // flight must still just end the hold — default SIGINT termination here
    // would orphan the detached target tree the caller is about to stop.
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    try {
        for (;;) {
            const remaining = deadline - Date.now();
            if (interrupted || remaining <= 0)
                break;
            await sleep(Math.min(remaining, HOLD_POLL_MS));
        }
    }
    finally {
        process.off('SIGINT', onSignal);
        process.off('SIGTERM', onSignal);
    }
    note('keep-alive: window ended; target teardown resumes');
}
