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
}

export type ExecFn = (cmd: string, args: string[], timeoutMs: number) => Promise<ExecResult>

export const defaultExec: ExecFn = (cmd, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        resolve({ code: 1, stdout: String(stdout), stderr: String(stderr ?? err.message) })
      } else {
        resolve({ code: 0, stdout: String(stdout), stderr: String(stderr) })
      }
    })
  })

export type ProbeFn = (url: string, timeoutMs: number) => Promise<boolean>

/** Any HTTP response — including a login redirect — means the instance is up. */
export const defaultProbe: ProbeFn = async (url, timeoutMs) => {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'manual',
    })
    return res.status < 500
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
    exec('a0', ['--version'], 5_000),
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
