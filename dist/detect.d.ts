/**
 * Environment detection for `init` readiness reporting and Agent Zero
 * resolution. Everything here is best-effort — a missing tool degrades a
 * feature flag, it never breaks the command.
 */
export interface ExecResult {
    code: number;
    stdout: string;
    stderr: string;
}
export type ExecFn = (cmd: string, args: string[], timeoutMs: number) => Promise<ExecResult>;
export declare const defaultExec: ExecFn;
export type ProbeFn = (url: string, timeoutMs: number) => Promise<boolean>;
/** Any HTTP response — including a login redirect — means the instance is up. */
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
