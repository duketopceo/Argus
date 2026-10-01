import { buildA0ChildEnv, type ExecFn, type ProbeFn } from '../detect.js';
import type { LaneStatus } from '../report/manifest.js';
export { buildA0ChildEnv };
/**
 * Agent Zero delegation — the thin seam that hands a natural-language task to
 * an `a0` instance (`a0 headless -p`). The instance runs autonomously inside
 * its own sandboxed desktop/browser; Argus gets back the agent's final answer.
 *
 * This is deliberately NOT a replay path: every delegation is a full-cost,
 * non-deterministic agent run. Fingerprint replay stays local and ~free; A0 is
 * for healing, second opinions on failures, and exploratory tasks that were
 * never recorded.
 *
 * The `verify --a0` lane caps completed delegations at `inconclusive`: the
 * host round-trip is proven (#53), but the agent's answer is self-reported
 * evidence, never a `passed` verdict.
 */
export declare const A0_DEFAULT_TIMEOUT_MS = 600000;
/** Delegations a `verify --a0` lane may run — config.a0.maxTasks overrides. */
export declare const A0_LANE_MAX_TASKS = 1;
/** Lane detail file the a0 runner writes and `runVerify` reads back. */
export declare const A0_LANE_REPORT = "a0-lane.json";
/** Reported posture: the round-trip is verified (#53); the answer is not. */
export declare const A0_LIVE_LABEL = "self-reported";
export interface A0TaskOptions {
    /** Instance base URL. Omit to let the `a0` CLI resolve it itself. */
    host?: string | undefined;
    /** Binary name/path — tests inject a stub. */
    cli?: string;
    timeoutMs?: number;
    exec?: ExecFn;
    /**
     * Sanitized environment for the child process — replaces the inherited
     * environment wholesale. Build with `buildA0ChildEnv`.
     */
    env?: Record<string, string>;
}
export interface A0TaskResult {
    ok: boolean;
    /** The agent's final answer text, or the error output when !ok. */
    output: string;
    /** Spawn-level failure (missing CLI) vs a completed-but-failed run. */
    spawnError?: boolean | undefined;
    timedOut?: boolean | undefined;
}
export declare function buildA0Args(prompt: string, host: string | undefined): string[];
export declare function runA0Task(prompt: string, opts?: A0TaskOptions): Promise<A0TaskResult>;
/** Prompt wrapper: bind the task to an app URL when one is known. */
export declare function a0TaskPrompt(task: string, url: string | undefined): string;
/**
 * The typed delegation payload — allowlisted fields only (KTD4). Nothing
 * outside this record may reach the host: no ambient env, no raw journal
 * text, no transcript dumps.
 */
export interface A0TaskPayload {
    /** What the agent should do on the target. */
    task: string;
    /** Application URL the agent opens first. */
    targetUrl: string | undefined;
    /** The head SHA the evidence is bound to — the agent verifies against it. */
    intendedHeadSha: string | undefined;
    /** One-line summary of what failed locally, when escalating a failure. */
    failureSummary: string | undefined;
    /** Repo-relative evidence paths the agent may consult (app-lane.json etc.). */
    evidenceRefs: string[] | undefined;
}
/** Render the typed payload into the delegated prompt — sanitized surface. */
export declare function buildA0LanePrompt(payload: A0TaskPayload): string;
/** What the `verify --a0` lane writes to `a0-lane.json`. */
export interface A0LaneReport {
    lane: 'a0';
    status: LaneStatus;
    reason: string | undefined;
    summary: string | undefined;
    /** Resolved instance base URL (or how resolution failed). */
    host: string | undefined;
    hostSource: string | undefined;
    /** Whether the host can plausibly reach the configured target. */
    targetReachable: 'assumed' | 'refused' | 'unchecked' | undefined;
    task: string | undefined;
    /** The agent's answer text — evidence, not a verdict. */
    output: string | undefined;
    /** Delegations actually attempted. */
    tasks: number;
    durationMs: number;
    /** a0 supplies no usage telemetry today — always false (R13). */
    metered: false;
}
export interface A0LaneDeps {
    exec?: ExecFn;
    /** Host reachability probe — requires an Agent Zero marker in the HTML. */
    probe?: ProbeFn;
    /** Host resolver — tests inject a canned answer. */
    resolveHost?: () => Promise<{
        host: string | undefined;
        source: string | undefined;
    }>;
    /** `a0 --version` presence check. */
    cliVersion?: () => Promise<string | undefined>;
    /** CLI binary name — tests inject a stub path. */
    cli?: string;
    /** User-facing line sink (scope summary, next actions). */
    note?: (line: string) => void;
}
export interface A0LaneInput {
    /** Config a0 block — url, maxTasks, timeoutMs. */
    a0: {
        url: string | undefined;
        maxTasks?: number | undefined;
        timeoutMs?: number | undefined;
    } | undefined;
    /** Ambient env for host resolution + allowlisted child env. */
    env: NodeJS.ProcessEnv | Record<string, string | undefined>;
    /** Application target the agent will be asked to drive. */
    targetUrl: string | undefined;
    /** Head SHA the run's evidence is bound to. */
    intendedHeadSha: string | undefined;
    /** Task the agent performs — app lane task or an explicit a0 task. */
    task: string | undefined;
    /** Local failure context when the lane escalates one. */
    failureSummary?: string | undefined;
    /** Checkout trust — the executable lane refuses an untrusted tree. */
    trusted: boolean;
    deps?: A0LaneDeps;
}
/**
 * Whether `url` names a loopback target — the remote-a0/loopback-target
 * refusal depends on this being complete: the whole 127.0.0.0/8 range,
 * wildcard/zero hosts, `*.localhost`, and IPv4-mapped forms, not just the
 * canonical `127.0.0.1`/`localhost` literals. `file:` URLs count too — a
 * remote host's filesystem is not this machine's. DNS names that merely
 * resolve to loopback are not caught (no lookup by design — fail-open on
 * hostnames is deliberate here).
 */
export declare function isLoopback(url: string): boolean;
/**
 * `verify --a0` lane: explicit selection only, every preflight outcome
 * recorded, zero spend before the host is proven reachable, and a hard
 * `inconclusive` ceiling — a completed delegation is evidence, and the
 * agent's report of what it saw is self-reported, not a verdict.
 */
export declare function runA0Lane(input: A0LaneInput): Promise<A0LaneReport>;
