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
  /** Container name suffix — becomes `argus-probe-<pid>-<name>`. */
  name: string
  timeoutMs: number
  memory: string
  cpus: string
  pidsLimit: number
  /**
   * Extra host dirs bind-mounted read-only at the given container path —
   * the base run borrows head's node_modules since a git worktree has none.
   */
  roMounts?: { host: string; container: string }[] | undefined
  /** Extra container paths (under /work) masked with tmpfs. */
  masks?: string[] | undefined
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
 * silently mount an empty dir. The smoke run uses the SAME hardening
 * profile as probe runs (plus `--pull always` and an entrypoint override) —
 * an availability check that ran the image unhardened would bypass every
 * invariant this module exists to enforce.
 */
export async function dockerAvailable(
  exec: ExecFn,
  image: string,
  workdir: string,
): Promise<boolean> {
  const name = containerName('avail')
  let probe
  try {
    const version = await exec('docker', ['version', '--format', '{{.Server.Version}}'], 10_000)
    if (version.code !== 0) return false
    probe = await exec(
      'docker',
      [
        'run',
        '--rm',
        '--name',
        name,
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
        '--entrypoint',
        'test',
        '-v',
        `${workdir}:${CONTAINER_WORKDIR}:ro`,
        image,
        '-f',
        `${CONTAINER_WORKDIR}/package.json`,
      ],
      // Cold-pull headroom: on a daemon that has never seen the image,
      // `--pull always` downloads it inside this call — 60s under-runs a
      // first pull and falsely reports docker as unusable.
      300_000,
    )
  } catch {
    // Spawn failure (no docker binary, daemon gone) → unavailable, and the
    // named container may still be half-created — remove it best-effort.
    await forceRemove(exec, name)
    return false
  }
  if (probe.timedOut === true) await forceRemove(exec, name)
  return probe.code === 0
}

/**
 * Container name — shared by `docker run --name` and the `rm -f` teardown.
 * Includes the pid so two concurrent review jobs on one daemon can't
 * collide names (or force-remove each other's containers).
 */
function containerName(name: string): string {
  return `argus-probe-${process.pid}-${name}`
}

/** How `.git` presents on disk — dir (normal checkout), file (worktree), or absent. */
type GitMode = 'dir' | 'file' | 'absent'

/**
 * The full `docker run` argv (KTD2). Every flag is pinned here — this is the
 * single place the sandbox boundary lives. `name` is the full container name.
 */
export function buildSandboxArgv(
  opts: Pick<SandboxRunOptions, 'image' | 'cmd' | 'memory' | 'cpus' | 'pidsLimit' | 'roMounts' | 'masks'>,
  name: string,
  checked: { realWork: string; realScratch: string; relMount: string },
  gitMode: GitMode,
  secretFiles: string[],
): string[] {
  const argv = [
    'run',
    '--rm',
    '--name',
    name,
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
    `${checked.realWork}:${CONTAINER_WORKDIR}:ro`,
  ]
  // Shadow .git — actions/checkout persists a base64 GITHUB_TOKEN in
  // .git/config; PR code must not read it. tmpfs masks a *directory*; a
  // worktree's `.git` pointer file (or any root-level secret file staged by
  // earlier steps) is masked with a read-only /dev/null bind.
  if (gitMode === 'dir') argv.push('--tmpfs', `${CONTAINER_WORKDIR}/.git`)
  for (const f of gitMode === 'file' ? ['.git', ...secretFiles] : secretFiles) {
    argv.push('-v', `/dev/null:${CONTAINER_WORKDIR}/${f}:ro`)
  }
  for (const mask of opts.masks ?? []) argv.push('--tmpfs', `${CONTAINER_WORKDIR}/${mask}`)
  for (const m of opts.roMounts ?? []) argv.push('-v', `${m.host}:${m.container}:ro`)
  argv.push(
    '-v',
    `${checked.realScratch}:${CONTAINER_WORKDIR}/${checked.relMount}:rw`,
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

/** Daemon-side kill — the non-ignorable half of the R4 wall-clock bound. */
async function forceRemove(exec: ExecFn, name: string): Promise<void> {
  await exec('docker', ['rm', '-f', name], 15_000).catch(() => undefined)
}

/**
 * Run one command in the hardened container. On timeout the docker client
 * is killed first, then `docker rm -f` guarantees teardown — SIGKILL via
 * the daemon is non-ignorable, which is what makes the R4 wall-clock bound
 * real. Path-check and spawn failures return a `exitCode: -1` result
 * carrying the reason; this function never throws past its callers.
 */
/** Workspace-root files that commonly carry credentials — masked when present. */
const SECRET_FILE_NAMES = ['.env', '.npmrc', '.netrc', '.git-credentials']

export async function runProbeInSandbox(opts: SandboxRunOptions): Promise<SandboxRunResult> {
  const exec = opts.exec ?? defaultExec
  const checked = await checkSandboxPaths(opts.workdir, opts.scratchDir)
  if (!checked.ok) {
    return { exitCode: -1, stdout: '', stderr: checked.reason, durationMs: 0, timedOut: false }
  }
  const gitStat = await stat(join(checked.realWork, '.git')).catch(() => undefined)
  const gitMode: GitMode = gitStat === undefined ? 'absent' : gitStat.isDirectory() ? 'dir' : 'file'
  const secretFiles = (
    await Promise.all(
      SECRET_FILE_NAMES.map(async (f) =>
        (await stat(join(checked.realWork, f)).catch(() => undefined))?.isFile() === true
          ? f
          : undefined,
      ),
    )
  ).filter((f): f is string => f !== undefined)
  const name = containerName(opts.name)
  const argv = buildSandboxArgv(opts, name, checked, gitMode, secretFiles)
  const started = Date.now()
  let res
  try {
    res = await exec('docker', argv, opts.timeoutMs)
  } catch (e) {
    await forceRemove(exec, name)
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
    await forceRemove(exec, name)
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
