import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'

import type { Sandbox } from '../config.js'
import { defaultExec, type ExecFn } from '../detect.js'

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
export const SANDBOX_OUTPUT_CAP = 32 * 1024

/** Filesystem path inside the container where the workspace lands. */
export const CONTAINER_WORKDIR = '/work'

/** Name of the single writable mount — lives under reportDir/probes-out. */
export const SCRATCH_DIR_NAME = 'probes-out'

export interface SandboxRunOptions {
  /** Absolute host path of the PR checkout — bind-mounted at /work:ro. */
  workdir: string
  /**
   * Absolute host path of the writable scratch dir. Must resolve (after
   * realpath) to a strict descendant of workdir — a checked-in symlink must
   * never turn this into a writable bind of an arbitrary host path.
   */
  scratchDir: string
  /** In-container command argv. */
  cmd: string[]
  /** Resolved image (`config.sandbox.image` or `node:<host major>-slim`). */
  image: string
  /** Container name suffix — becomes `argus-probe-<name>`. */
  name: string
  timeoutMs: number
  memory: string
  cpus: string
  pidsLimit: number
  exec?: ExecFn
}

export interface SandboxRunResult {
  /** -1 when the run never started (path check, spawn failure). */
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
}

/** Strict C0/control-byte strip — applied before output leaves the module. */
export function stripControlChars(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
}

/**
 * Resolve the probe image: an explicit `sandbox.image` always wins;
 * otherwise pin to the host's own Node major so native `node_modules`
 * (ABI-bound to the installing Node) load inside the container.
 */
export function resolveSandboxImage(image: string | undefined): string {
  return image ?? `node:${process.versions.node.split('.')[0]}-slim`
}

/**
 * Filesystem safety check before any `docker run`: the scratch dir must
 * realpath-resolve to a strict descendant of the real workdir. Rejects a
 * reportDir symlinked out of the tree or configured outside the checkout —
 * both would turn the rw bind-mount into a write primitive on the host.
 */
export async function checkSandboxPaths(
  workdir: string,
  scratchDir: string,
): Promise<
  { ok: true; realWork: string; realScratch: string; relMount: string } | { ok: false; reason: string }
> {
  try {
    const realWork = await realpath(resolve(workdir))
    const realScratch = await realpath(resolve(scratchDir))
    const rel = relative(realWork, realScratch)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      return { ok: false, reason: `scratch dir ${scratchDir} is not inside ${workdir}` }
    }
    return { ok: true, realWork, realScratch, relMount: rel }
  } catch (e) {
    return { ok: false, reason: `path check failed: ${(e as Error).message}` }
  }
}

/**
 * Docker is usable AND resolves the runner's workspace path — bind-mount
 * sources are evaluated by the daemon, so a remote/containerized daemon can
 * silently mount an empty dir. One cheap container run proves both.
 */
export async function dockerAvailable(
  exec: ExecFn,
  image: string,
  workdir: string,
): Promise<boolean> {
  const version = await exec('docker', ['version', '--format', '{{.Server.Version}}'], 10_000)
  if (version.code !== 0) return false
  const probe = await exec(
    'docker',
    ['run', '--rm', '-v', `${workdir}:${CONTAINER_WORKDIR}:ro`, image, 'test', '-f', `${CONTAINER_WORKDIR}/package.json`],
    60_000,
  )
  return probe.code === 0
}

/**
 * The full `docker run` argv (KTD2). Every flag is pinned here — this is the
 * single place the sandbox boundary lives.
 */
export function buildSandboxArgv(
  opts: Pick<SandboxRunOptions, 'image' | 'name' | 'cmd' | 'memory' | 'cpus' | 'pidsLimit'>,
  realWork: string,
  realScratch: string,
  relMount: string,
  gitIsDir: boolean,
): string[] {
  const argv = [
    'run',
    '--rm',
    '--name',
    `argus-probe-${opts.name}`,
    // Mutable tags on a persistent runner can be poisoned by earlier jobs —
    // always resolve from the registry (daemon-side network; the container
    // itself stays offline).
    '--pull',
    'always',
    '--network',
    'none',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--user',
    '65534:65534',
    '--pids-limit',
    String(opts.pidsLimit),
    '--memory',
    opts.memory,
    '--cpus',
    opts.cpus,
    '--tmpfs',
    '/tmp:rw,nosuid,nodev,noexec',
    '-v',
    `${realWork}:${CONTAINER_WORKDIR}:ro`,
  ]
  // Shadow the git dir — actions/checkout persists a base64 GITHUB_TOKEN in
  // .git/config by default; PR code must not read it. Git worktrees make
  // .git a *file* — tmpfs can't mount over one, so only mask directories.
  if (gitIsDir) argv.push('--tmpfs', `${CONTAINER_WORKDIR}/.git`)
  argv.push(
    '-v',
    `${realScratch}:${CONTAINER_WORKDIR}/${relMount}:rw`,
    '-w',
    CONTAINER_WORKDIR,
    // Declared env allowlist only — no host env is inherited. HOME=/tmp
    // because `nobody`'s passwd home is /nonexistent on a read-only root.
    '--env',
    'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    '--env',
    'HOME=/tmp',
    '--env',
    'npm_config_cache=/tmp/.npm',
    opts.image,
    ...opts.cmd,
  )
  return argv
}

/**
 * Run one command in the hardened container. On timeout the docker client
 * is killed first, then `docker rm -f` guarantees teardown — SIGKILL via
 * the daemon is non-ignorable, which is what makes the R4 wall-clock bound
 * real. Path-check and spawn failures return a `exitCode: -1` result
 * carrying the reason; this function never throws past its callers.
 */
export async function runProbeInSandbox(opts: SandboxRunOptions): Promise<SandboxRunResult> {
  const exec = opts.exec ?? defaultExec
  const checked = await checkSandboxPaths(opts.workdir, opts.scratchDir)
  if (!checked.ok) {
    return { exitCode: -1, stdout: '', stderr: checked.reason, durationMs: 0, timedOut: false }
  }
  const gitIsDir = await stat(join(checked.realWork, '.git')).then(
    (s) => s.isDirectory(),
    () => false,
  )
  const name = `argus-probe-${opts.name}`
  const argv = buildSandboxArgv(opts, checked.realWork, checked.realScratch, checked.relMount, gitIsDir)
  const started = Date.now()
  let res
  try {
    res = await exec('docker', argv, opts.timeoutMs)
  } catch (e) {
    await exec('docker', ['rm', '-f', name], 15_000).catch(() => undefined)
    return {
      exitCode: -1,
      stdout: '',
      stderr: (e as Error).message,
      durationMs: Date.now() - started,
      timedOut: false,
    }
  }
  const durationMs = Date.now() - started
  if (res.timedOut === true) {
    await exec('docker', ['rm', '-f', name], 15_000).catch(() => undefined)
  }
  return {
    exitCode: res.code,
    stdout: stripControlChars(res.stdout).slice(0, SANDBOX_OUTPUT_CAP),
    stderr: stripControlChars(res.stderr).slice(0, SANDBOX_OUTPUT_CAP),
    durationMs,
    timedOut: res.timedOut === true,
  }
}

/** Limits convenience — what `runProbeInSandbox` needs from config.sandbox. */
export function sandboxLimits(sandbox: Sandbox): Pick<
  SandboxRunOptions,
  'timeoutMs' | 'memory' | 'cpus' | 'pidsLimit'
> {
  return {
    timeoutMs: sandbox.timeoutMs,
    memory: sandbox.memory,
    cpus: sandbox.cpus,
    pidsLimit: sandbox.pidsLimit,
  }
}
