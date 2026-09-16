import type { Sandbox } from '../config.js';
import { type ExecFn } from '../detect.js';
/**
 * Docker sandbox for the B.2 probe lane — the security boundary around
 * executing PR-contributed probe code on the consumer's runner.
 *
 * Invariants (KTD2 / R4): no ambient env, no network, read-only root,
 * non-root, all capabilities dropped, no-new-privileges, resource + PID
 * limits, `.git` masked inside the container, exactly one writable bind
 * mount (the probes scratch dir), and a wall-clock timeout enforced by
 * daemon-side `docker rm -f` — killing the `docker` CLI alone does not
 * guarantee the container dies when its PID 1 traps the forwarded signal.
 */
/** Output cap per stream — probe output is attacker-controlled. */
export declare const SANDBOX_OUTPUT_CAP: number;
/** Filesystem path inside the container where the workspace lands. */
export declare const CONTAINER_WORKDIR = "/work";
/** Name of the single writable mount — lives under reportDir/probes-out. */
export declare const SCRATCH_DIR_NAME = "probes-out";
export interface SandboxRunOptions {
    /** Absolute host path of the PR checkout — bind-mounted at /work:ro. */
    workdir: string;
    /**
     * Absolute host path of the writable scratch dir. Must resolve (after
     * realpath) to a strict descendant of workdir — a checked-in symlink must
     * never turn this into a writable bind of an arbitrary host path.
     */
    scratchDir: string;
    /** In-container command argv. */
    cmd: string[];
    /** Resolved image (`config.sandbox.image` or `node:<host major>-slim`). */
    image: string;
    /** Container name suffix — becomes `argus-probe-<pid>-<name>`. */
    name: string;
    timeoutMs: number;
    memory: string;
    cpus: string;
    pidsLimit: number;
    /**
     * Extra host dirs bind-mounted read-only at the given container path —
     * the base run borrows head's node_modules since a git worktree has none.
     */
    roMounts?: {
        host: string;
        container: string;
    }[] | undefined;
    /** Extra container paths (under /work) masked with tmpfs. */
    masks?: string[] | undefined;
    exec?: ExecFn;
}
export interface SandboxRunResult {
    /** -1 when the run never started (path check, spawn failure). */
    exitCode: number;
    stdout: string;
    stderr: string;
    durationMs: number;
    timedOut: boolean;
}
/** Strict C0/control-byte strip — applied before output leaves the module. */
export declare function stripControlChars(s: string): string;
/**
 * Resolve the probe image: an explicit `sandbox.image` always wins;
 * otherwise pin to the host's own Node major so native `node_modules`
 * (ABI-bound to the installing Node) load inside the container.
 */
export declare function resolveSandboxImage(image: string | undefined): string;
/**
 * Filesystem safety check before any `docker run`: the scratch dir must
 * realpath-resolve to a strict descendant of the real workdir. Rejects a
 * reportDir symlinked out of the tree or configured outside the checkout —
 * both would turn the rw bind-mount into a write primitive on the host.
 */
export declare function checkSandboxPaths(workdir: string, scratchDir: string): Promise<{
    ok: true;
    realWork: string;
    realScratch: string;
    relMount: string;
} | {
    ok: false;
    reason: string;
}>;
/**
 * Docker is usable AND resolves the runner's workspace path — bind-mount
 * sources are evaluated by the daemon, so a remote/containerized daemon can
 * silently mount an empty dir. The smoke run uses the SAME hardening
 * profile as probe runs (plus `--pull always` and an entrypoint override) —
 * an availability check that ran the image unhardened would bypass every
 * invariant this module exists to enforce.
 */
export declare function dockerAvailable(exec: ExecFn, image: string, workdir: string): Promise<boolean>;
/** How `.git` presents on disk — dir (normal checkout), file (worktree), or absent. */
type GitMode = 'dir' | 'file' | 'absent';
/**
 * The full `docker run` argv (KTD2). Every flag is pinned here — this is the
 * single place the sandbox boundary lives. `name` is the full container name.
 */
export declare function buildSandboxArgv(opts: Pick<SandboxRunOptions, 'image' | 'cmd' | 'memory' | 'cpus' | 'pidsLimit' | 'roMounts' | 'masks'>, name: string, checked: {
    realWork: string;
    realScratch: string;
    relMount: string;
}, gitMode: GitMode, secretFiles: string[]): string[];
export declare function runProbeInSandbox(opts: SandboxRunOptions): Promise<SandboxRunResult>;
/** Limits convenience — what `runProbeInSandbox` needs from config.sandbox. */
export declare function sandboxLimits(sandbox: Sandbox): Pick<SandboxRunOptions, 'timeoutMs' | 'memory' | 'cpus' | 'pidsLimit'>;
export {};
