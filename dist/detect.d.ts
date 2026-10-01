/**
 * Environment detection for `init` readiness reporting and Agent Zero
 * resolution. Everything here is best-effort — a missing tool degrades a
 * feature flag, it never breaks the command.
 */
export interface ExecResult {
    code: number;
    stdout: string;
    stderr: string;
    /**
     * The timeout kill fired — execFile killed the process for exceeding
     * timeoutMs (`err.killed`). Without this a timed-out command is
     * indistinguishable from a nonzero exit.
     */
    timedOut?: boolean;
    /** Signal the process was terminated by, when killed (e.g. 'SIGTERM'). */
    signal?: string | undefined;
    /**
     * The process never started (ENOENT — binary missing) — set by the real
     * executor so callers don't sniff stderr text for the distinction.
     */
    spawnError?: boolean | undefined;
}
export type ExecFn = (cmd: string, args: string[], timeoutMs: number, 
/** Extra env merged over process.env — keeps secrets out of `ps`/`/proc` argv. */
env?: Record<string, string>, 
/**
 * `baseEnv` replaces the inherited process environment wholesale — the
 * caller's allowlist, not ambient env. Without it the child inherits
 * process.env as before.
 */
opts?: {
    baseEnv?: Record<string, string>;
}) => Promise<ExecResult>;
export declare const defaultExec: ExecFn;
export type ProbeFn = (url: string, timeoutMs: number) => Promise<boolean>;
/**
 * The only environment keys an Agent Zero child process may inherit.
 * Provider keys, GitHub tokens, `ARGUS_*`, and npm auth variables never
 * propagate (R12) — the child is a remote agent harness, not an extension
 * of this process's trust. Lives here (not in executor/a0.ts) because every
 * `a0` spawn — delegation, the lane's `--version` preflight, and init's
 * environment probe — must use it or the contract leaks.
 */
export declare const A0_CHILD_ENV_KEYS: readonly ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TERM", "TMPDIR", "XDG_RUNTIME_DIR", "DOCKER_HOST", "AGENT_ZERO_HOST", "A0_USERNAME", "A0_PASSWORD"];
/** Build the sanitized child env: allowlisted keys that exist in `env`. */
export declare function buildA0ChildEnv(env: NodeJS.ProcessEnv | Record<string, string | undefined>): Record<string, string>;
/**
 * Any HTTP response — including a login redirect — means *something* is up,
 * but port 5080 could be an unrelated service. Require an Agent Zero marker
 * in the served HTML before trusting the probe result. Redirects are
 * followed: a login-gated instance 302s `/` to `/login`, and the marker
 * check must apply to the page the host actually serves, not the redirect
 * stub — a hop to a non-Zero page still fails the marker check.
 */
export declare const defaultProbe: ProbeFn;
export interface A0Info {
    /** `a0` CLI version string when the binary is on PATH. */
    version: string | undefined;
    /** Resolved instance base URL, if one could be found. */
    host: string | undefined;
    hostSource: 'env' | 'dotfile' | 'probe' | undefined;
}
export interface EnvironmentReport {
    /** OPENROUTER_API_KEY is set and non-empty. */
    openrouterKey: boolean;
    /** gh CLI authenticated; undefined when gh is not installed at all. */
    ghAuth: boolean | undefined;
    /** Playwright engines with a downloaded executable (e.g. 'chromium'). */
    playwrightBrowsers: string[];
    a0: A0Info;
}
export interface DetectOptions {
    exec?: ExecFn;
    home?: string;
    probe?: ProbeFn;
}
/**
 * Resolve the Agent Zero instance URL the same way the `a0` CLI does:
 * explicit env var, the launcher-managed ~/.agent-zero/.env, then a probe of
 * the default local port (http://localhost:5080).
 */
export declare function resolveA0Host(env: NodeJS.ProcessEnv, opts?: DetectOptions): Promise<{
    host: string | undefined;
    source: A0Info['hostSource'];
}>;
export declare function detectEnvironment(env: NodeJS.ProcessEnv, opts?: DetectOptions): Promise<EnvironmentReport>;
