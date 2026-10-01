import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readdir, readFile } from 'node:fs/promises'

/**
 * Environment detection for `init` readiness reporting and Agent Zero
 * resolution. Everything here is best-effort — a missing tool degrades a
 * feature flag, it never breaks the command.
 */

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
  /**
   * The timeout kill fired — execFile killed the process for exceeding
   * timeoutMs (`err.killed`). Without this a timed-out command is
   * indistinguishable from a nonzero exit.
   */
  timedOut?: boolean
  /** Signal the process was terminated by, when killed (e.g. 'SIGTERM'). */
  signal?: string | undefined
  /**
   * The process never started (ENOENT — binary missing) — set by the real
   * executor so callers don't sniff stderr text for the distinction.
   */
  spawnError?: boolean | undefined
}

export type ExecFn = (
  cmd: string,
  args: string[],
  timeoutMs: number,
  /** Extra env merged over process.env — keeps secrets out of `ps`/`/proc` argv. */
  env?: Record<string, string>,
  /**
   * `baseEnv` replaces the inherited process environment wholesale — the
   * caller's allowlist, not ambient env. Without it the child inherits
   * process.env as before.
   */
  opts?: { baseEnv?: Record<string, string> },
) => Promise<ExecResult>

/** Grace between a timeout's SIGTERM and the escalation SIGKILL. */
const EXEC_KILL_GRACE_MS = 2_000

export const defaultExec: ExecFn = (cmd, args, timeoutMs, env, opts) =>
  new Promise((resolve) => {
    const baseEnv = opts?.baseEnv ?? process.env
    // 4 MiB headroom — the sandbox caps output itself after capture, and a
    // chatty probe hitting execFile's 1 MiB default would error instead of
    // reaching the harness classifier.
    const child = execFile(
      cmd,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...baseEnv, ...env },
      },
      (err, stdout, stderr) => {
        settled = true
        if (err) {
          // stderr is '' (not undefined) on spawn ENOENT — fall back to the
          // error message so callers can distinguish "missing" from "failed".
          resolve({
            code: 1,
            stdout: String(stdout),
            stderr: String(stderr) || err.message,
            // killed is also true on maxBuffer overflow — that's an output
            // problem, not a timeout; classify by the error code.
            timedOut:
              err.killed === true &&
              (err as { code?: unknown }).code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
            signal: typeof err.signal === 'string' ? err.signal : undefined,
            spawnError: (err as { code?: unknown }).code === 'ENOENT',
          })
        } else {
          resolve({ code: 0, stdout: String(stdout), stderr: String(stderr) })
        }
      },
    )
    let settled = false
    // execFile's timeout only delivers SIGTERM — a child that traps it (or a
    // descendant holding the stdio pipes open) would keep this promise
    // pending forever. Escalate to SIGKILL after a short grace, and resolve
    // anyway if even that can't make the callback fire.
    const escalate = setTimeout(() => {
      if (settled) return
      try {
        child.kill('SIGKILL')
      } catch {
        // already gone
      }
      setTimeout(() => {
        if (!settled) {
          settled = true
          resolve({ code: 1, stdout: '', stderr: 'process killed', timedOut: true })
        }
      }, EXEC_KILL_GRACE_MS).unref()
    }, timeoutMs + EXEC_KILL_GRACE_MS)
    escalate.unref()
    child.on('close', () => clearTimeout(escalate))
  })

export type ProbeFn = (url: string, timeoutMs: number) => Promise<boolean>

/**
 * The only environment keys an Agent Zero child process may inherit.
 * Provider keys, GitHub tokens, `ARGUS_*`, and npm auth variables never
 * propagate (R12) — the child is a remote agent harness, not an extension
 * of this process's trust. Lives here (not in executor/a0.ts) because every
 * `a0` spawn — delegation, the lane's `--version` preflight, and init's
 * environment probe — must use it or the contract leaks.
 */
export const A0_CHILD_ENV_KEYS = [
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
  // Headless auth for login-gated instances: the a0 CLI itself consumes
  // these (headless has no other auth path — session cookies only persist
  // via the interactive TUI's remember-host flow). Operator-set only; they
  // scope to the a0 host, not to any provider.
  'A0_USERNAME',
  'A0_PASSWORD',
] as const

/** Build the sanitized child env: allowlisted keys that exist in `env`. */
export function buildA0ChildEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of A0_CHILD_ENV_KEYS) {
    const value = env[key]
    if (value !== undefined && value !== '') out[key] = value
  }
  return out
}


/**
 * Any HTTP response — including a login redirect — means *something* is up,
 * but port 5080 could be an unrelated service. Require an Agent Zero marker
 * in the served HTML before trusting the probe result. Redirects are
 * followed: a login-gated instance 302s `/` to `/login`, and the marker
 * check must apply to the page the host actually serves, not the redirect
 * stub — a hop to a non-Zero page still fails the marker check.
 */
export const defaultProbe: ProbeFn = async (url, timeoutMs) => {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
    })
    if (res.status >= 500) return false
    // Bound the bytes actually received — a misbehaving host streaming an
    // unbounded body inside the probe window would otherwise be fully
    // buffered by res.text() before the slice.
    const reader = res.body?.getReader()
    if (reader === undefined) return false
    const chunks: Uint8Array[] = []
    let received = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      chunks.push(value)
      if (received >= 65_536) {
        await reader.cancel()
        break
      }
    }
    const body = new TextDecoder().decode(
      chunks.length === 1 ? chunks[0] : Buffer.concat(chunks),
    )
    return /agent.?zero/i.test(body)
  } catch {
    return false
  }
}

export interface A0Info {
  /** `a0` CLI version string when the binary is on PATH. */
  version: string | undefined
  /** Resolved instance base URL, if one could be found. */
  host: string | undefined
  hostSource: 'env' | 'dotfile' | 'probe' | undefined
}

export interface EnvironmentReport {
  /** OPENROUTER_API_KEY is set and non-empty. */
  openrouterKey: boolean
  /** gh CLI authenticated; undefined when gh is not installed at all. */
  ghAuth: boolean | undefined
  /** Playwright engines with a downloaded executable (e.g. 'chromium'). */
  playwrightBrowsers: string[]
  a0: A0Info
}

export interface DetectOptions {
  exec?: ExecFn
  home?: string
  probe?: ProbeFn
}

/** Read `AGENT_ZERO_HOST` (and friends) out of ~/.agent-zero/.env. */
async function a0EnvFileHost(home: string): Promise<string | undefined> {
  try {
    const raw = await readFile(join(home, '.agent-zero', '.env'), 'utf8')
    for (const line of raw.split('\n')) {
      const m = /^AGENT_ZERO_HOST=(\S+)\s*$/.exec(line.trim())
      if (m?.[1] !== undefined && m[1] !== '') return m[1]
    }
  } catch {
    // no dotfile — fall through
  }
  return undefined
}

/**
 * Resolve the Agent Zero instance URL the same way the `a0` CLI does:
 * explicit env var, the launcher-managed ~/.agent-zero/.env, then a probe of
 * the default local port (http://localhost:5080).
 */
export async function resolveA0Host(
  env: NodeJS.ProcessEnv,
  opts: DetectOptions = {},
): Promise<{ host: string | undefined; source: A0Info['hostSource'] }> {
  const home = opts.home ?? homedir()
  const probe = opts.probe ?? defaultProbe

  const fromEnv = env.AGENT_ZERO_HOST
  if (fromEnv !== undefined && fromEnv !== '') return { host: fromEnv, source: 'env' }

  const fromFile = await a0EnvFileHost(home)
  if (fromFile !== undefined) return { host: fromFile, source: 'dotfile' }

  const local = 'http://localhost:5080'
  if (await probe(local, 2_000)) return { host: local, source: 'probe' }

  return { host: undefined, source: undefined }
}

/** Playwright engines with a downloaded browser under ~/.cache/ms-playwright. */
async function playwrightBrowsers(home: string): Promise<string[]> {
  try {
    const entries = await readdir(join(home, '.cache', 'ms-playwright'))
    const found = new Set<string>()
    for (const entry of entries) {
      for (const engine of ['chromium', 'firefox', 'webkit']) {
        if (entry.startsWith(engine)) found.add(engine)
      }
    }
    return [...found]
  } catch {
    return []
  }
}

export async function detectEnvironment(
  env: NodeJS.ProcessEnv,
  opts: DetectOptions = {},
): Promise<EnvironmentReport> {
  const exec = opts.exec ?? defaultExec
  const home = opts.home ?? homedir()

  const [a0Version, gh, browsers, a0Host] = await Promise.all([
    // Even the presence probe gets the allowlisted env — an `a0` binary is
    // third-party code and never sees provider/git secrets.
    exec('a0', ['--version'], 5_000, undefined, { baseEnv: buildA0ChildEnv(env) }),
    exec('gh', ['auth', 'status'], 5_000),
    playwrightBrowsers(home),
    resolveA0Host(env, opts),
  ])

  const version = a0Version.code === 0 ? a0Version.stdout.trim() : undefined
  const ghMissing = gh.code !== 0 && /ENOENT|not found|no such file/i.test(gh.stderr)

  return {
    openrouterKey: env.OPENROUTER_API_KEY !== undefined && env.OPENROUTER_API_KEY !== '',
    ghAuth: gh.code === 0 ? true : ghMissing ? undefined : false,
    playwrightBrowsers: browsers,
    a0: { version, host: a0Host.host, hostSource: a0Host.source },
  }
}
