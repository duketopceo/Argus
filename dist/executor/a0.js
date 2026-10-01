import { defaultExec, defaultProbe } from '../detect.js';
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
 * The `verify --a0` lane reports `unverified-live` — no live host round-trip
 * has been proven yet (issue #53), so a completed delegation is `inconclusive`
 * evidence, never a `passed` verdict.
 */
export const A0_DEFAULT_TIMEOUT_MS = 600_000;
/** Delegations a `verify --a0` lane may run — config.a0.maxTasks overrides. */
export const A0_LANE_MAX_TASKS = 1;
/** Lane detail file the a0 runner writes and `runVerify` reads back. */
export const A0_LANE_REPORT = 'a0-lane.json';
/** Reported posture until a live host round-trip is proven (issue #53). */
export const A0_LIVE_LABEL = 'unverified-live (#53)';
export function buildA0Args(prompt, host) {
    const args = ['headless', '--new-chat', '--output', 'text'];
    if (host !== undefined && host !== '')
        args.push('--host', host);
    args.push('-p', prompt);
    return args;
}
export async function runA0Task(prompt, opts = {}) {
    const exec = opts.exec ?? defaultExec;
    let res;
    try {
        res = await exec(opts.cli ?? 'a0', buildA0Args(prompt, opts.host), opts.timeoutMs ?? A0_DEFAULT_TIMEOUT_MS, undefined, opts.env !== undefined ? { baseEnv: opts.env } : undefined);
    }
    catch (e) {
        // Spawn rejection (ENOENT when a0 is absent, hard timeout) must degrade
        // to a failed delegation, not abort the calling command.
        return { ok: false, output: e.message, spawnError: true };
    }
    return {
        ok: res.code === 0,
        output: res.stdout.trim() || res.stderr.trim(),
        timedOut: res.timedOut,
        spawnError: /ENOENT|not found|no such file/i.test(res.stderr),
    };
}
/** Prompt wrapper: bind the task to an app URL when one is known. */
export function a0TaskPrompt(task, url) {
    return url === undefined || url === ''
        ? task
        : `Open ${url} in your browser, then do this task: ${task}`;
}
/**
 * The only environment keys a delegated process may inherit. Provider keys,
 * GitHub tokens, `ARGUS_*`, and `npm_*` never propagate (R12) — the child is
 * a remote agent harness, not an extension of this process's trust.
 */
const A0_CHILD_ENV_KEYS = [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'SHELL',
    'LANG',
    'LC_ALL',
    'TERM',
    'TMPDIR',
    'XDG_RUNTIME_DIR',
    'DOCKER_HOST',
    // The resolved host pointer — a URL, not a credential.
    'AGENT_ZERO_HOST',
];
/** Build the sanitized child env: allowlisted keys that exist in `env`. */
export function buildA0ChildEnv(env) {
    const out = {};
    for (const key of A0_CHILD_ENV_KEYS) {
        const value = env[key];
        if (value !== undefined && value !== '')
            out[key] = value;
    }
    return out;
}
/** Render the typed payload into the delegated prompt — sanitized surface. */
export function buildA0LanePrompt(payload) {
    const lines = [
        'You are an escalation agent for the Argus PR reviewer.',
        `Task: ${payload.task}`,
    ];
    if (payload.targetUrl !== undefined && payload.targetUrl !== '') {
        lines.push(`Target: open ${payload.targetUrl} and work against that application.`);
    }
    if (payload.intendedHeadSha !== undefined && payload.intendedHeadSha !== '') {
        lines.push(`The evidence must describe the PR head ${payload.intendedHeadSha}.`);
    }
    if (payload.failureSummary !== undefined && payload.failureSummary !== '') {
        lines.push(`Local failure being escalated: ${payload.failureSummary}`);
    }
    if (payload.evidenceRefs !== undefined && payload.evidenceRefs.length > 0) {
        lines.push(`Local evidence you may consult: ${payload.evidenceRefs.join(', ')}`);
    }
    lines.push('Report concisely what you observed and whether the task goal is met.', 'Do not attempt to access provider keys, tokens, or repository secrets.');
    return lines.join('\n');
}
function isLoopback(url) {
    try {
        const host = new URL(url).hostname;
        return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
    }
    catch {
        return false;
    }
}
/**
 * `verify --a0` lane: explicit selection only, every preflight outcome
 * recorded, zero spend before the host is proven reachable, and a hard
 * `unverified-live` posture — a completed delegation is `inconclusive`
 * evidence until issue #53 lands real host verification.
 */
export async function runA0Lane(input) {
    const started = Date.now();
    const deps = input.deps ?? {};
    const note = deps.note ?? (() => undefined);
    const done = (status, reason, extra) => ({
        lane: 'a0',
        status,
        reason,
        summary: status === 'inconclusive' ? `delegation returned — ${A0_LIVE_LABEL}` : reason,
        host: undefined,
        hostSource: undefined,
        targetReachable: undefined,
        task: input.task,
        output: undefined,
        tasks: 0,
        durationMs: Date.now() - started,
        metered: false,
        ...extra,
    });
    if (input.task === undefined || input.task.trim() === '') {
        return done('blocked', 'no delegated task configured — set a0 task via config app.task or the app lane');
    }
    // Preflight 1: host resolution — config wins, then the CLI's own chain
    // (env, ~/.agent-zero/.env, localhost probe). Missing both ends = nothing
    // to reach.
    const resolveHost = deps.resolveHost ??
        (async () => {
            const { resolveA0Host } = await import('../detect.js');
            const r = await resolveA0Host(input.env);
            return { host: r.host, source: r.source };
        });
    const cliVersion = deps.cliVersion ??
        (async () => {
            const res = await (deps.exec ?? defaultExec)('a0', ['--version'], 5_000);
            return res.code === 0 ? res.stdout.trim() : undefined;
        });
    const [resolved, version] = await Promise.all([resolveHost(), cliVersion()]);
    const host = input.a0?.url ?? resolved.host;
    const hostSource = input.a0?.url !== undefined ? 'config' : resolved.source;
    if (version === undefined && host === undefined) {
        return done('unavailable', 'no Agent Zero found — install the a0 CLI or set a0.url / AGENT_ZERO_HOST');
    }
    if (host === undefined) {
        // CLI present, host unresolved — the CLI may still self-resolve, but the
        // lane must prove a host before spending: record the gap honestly.
        return done('unavailable', 'a0 CLI is installed but no host resolved — set AGENT_ZERO_HOST or a0.url');
    }
    // Preflight 2: the host must answer as Agent Zero — a URL that serves
    // something else is worse than no host.
    const probe = deps.probe ?? defaultProbe;
    if (!(await probe(host, 5_000))) {
        return done('unavailable', `a0 host did not answer as Agent Zero: ${host}`, {
            host,
            hostSource,
        });
    }
    // Preflight 3: can the host reach the target? A remote a0 cannot drive a
    // loopback app on this machine — that's a scope refusal, not a failure.
    if (input.targetUrl !== undefined &&
        isLoopback(input.targetUrl) &&
        !isLoopback(host)) {
        return done('blocked', `a0 host ${host} is remote but the target ${input.targetUrl} is loopback — the host cannot reach it`, { host, hostSource, targetReachable: 'refused' });
    }
    const maxTasks = input.a0?.maxTasks ?? A0_LANE_MAX_TASKS;
    const timeoutMs = input.a0?.timeoutMs ?? A0_DEFAULT_TIMEOUT_MS;
    note(`a0 lane: delegating 1 task to ${host} (max ${maxTasks}, ` +
        `${Math.round(timeoutMs / 1000)}s wall-clock, usage unmetered, ${A0_LIVE_LABEL})`);
    const payload = buildA0LanePrompt({
        task: input.task,
        targetUrl: input.targetUrl,
        intendedHeadSha: input.intendedHeadSha,
        failureSummary: input.failureSummary ?? undefined,
        evidenceRefs: undefined,
    });
    const res = await runA0Task(payload, {
        host,
        timeoutMs,
        env: buildA0ChildEnv(input.env),
        ...(deps.exec !== undefined ? { exec: deps.exec } : {}),
        ...(deps.cli !== undefined ? { cli: deps.cli } : {}),
    });
    if (res.spawnError === true) {
        return done('unavailable', `a0 delegation could not start: ${res.output}`, {
            host,
            hostSource,
        });
    }
    if (res.timedOut === true) {
        return done('inconclusive', `a0 delegation timed out after ${timeoutMs}ms`, {
            host,
            hostSource,
            output: res.output !== '' ? res.output : undefined,
            tasks: 1,
        });
    }
    // Every completed delegation — success or reported failure — is evidence
    // whose truth is unverified until the live-host round-trip lands (#53).
    return done('inconclusive', res.ok ? undefined : `a0 delegation reported failure: ${res.output}`, {
        host,
        hostSource,
        targetReachable: input.targetUrl !== undefined ? 'assumed' : 'unchecked',
        output: res.output !== '' ? res.output : undefined,
        tasks: 1,
    });
}
