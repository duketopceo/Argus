import {
  buildA0ChildEnv,
  defaultExec,
  defaultProbe,
  resolveA0Host,
  type ExecFn,
  type ProbeFn,
} from '../detect.js'
import type { LaneStatus } from '../report/manifest.js'

// The allowlist lives in detect.ts beside the exec seam — re-exported here
// so `executor/a0` stays the single import site for delegation internals.
export { buildA0ChildEnv }

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

export const A0_DEFAULT_TIMEOUT_MS = 600_000
/** Delegations a `verify --a0` lane may run — config.a0.maxTasks overrides. */
export const A0_LANE_MAX_TASKS = 1
/** Lane detail file the a0 runner writes and `runVerify` reads back. */
export const A0_LANE_REPORT = 'a0-lane.json'
/** Reported posture: the round-trip is verified (#53); the answer is not. */
export const A0_LIVE_LABEL = 'self-reported'

export interface A0TaskOptions {
  /** Instance base URL. Omit to let the `a0` CLI resolve it itself. */
  host?: string | undefined
  /** Binary name/path — tests inject a stub. */
  cli?: string
  timeoutMs?: number
  exec?: ExecFn
  /**
   * Sanitized environment for the child process — replaces the inherited
   * environment wholesale. Build with `buildA0ChildEnv`.
   */
  env?: Record<string, string>
}

export interface A0TaskResult {
  ok: boolean
  /** The agent's final answer text, or the error output when !ok. */
  output: string
  /** Spawn-level failure (missing CLI) vs a completed-but-failed run. */
  spawnError?: boolean | undefined
  timedOut?: boolean | undefined
}

export function buildA0Args(prompt: string, host: string | undefined): string[] {
  const args = ['headless', '--new-chat', '--output', 'text']
  if (host !== undefined && host !== '') args.push('--host', host)
  args.push('-p', prompt)
  return args
}

export async function runA0Task(prompt: string, opts: A0TaskOptions = {}): Promise<A0TaskResult> {
  const exec = opts.exec ?? defaultExec
  // The allowlisted child env is the default, not the opt-in — every
  // delegation path (lane, heal, delegate) gets the R12 sanitization
  // unless a caller deliberately passes a different env.
  const baseEnv = opts.env ?? buildA0ChildEnv(process.env)
  let res: Awaited<ReturnType<ExecFn>>
  try {
    res = await exec(
      opts.cli ?? 'a0',
      buildA0Args(prompt, opts.host),
      opts.timeoutMs ?? A0_DEFAULT_TIMEOUT_MS,
      undefined,
      { baseEnv },
    )
  } catch (e) {
    // Spawn rejection (ENOENT when a0 is absent, hard timeout) must degrade
    // to a failed delegation, not abort the calling command.
    return { ok: false, output: (e as Error).message, spawnError: true }
  }
  return {
    ok: res.code === 0,
    output: res.stdout.trim() || res.stderr.trim(),
    timedOut: res.timedOut,
    // ExecResult.spawnError is authoritative when the executor sets it —
    // a completed run that merely prints "not found" to stderr must not
    // misclassify. The sniff remains for injected execs without the field.
    spawnError: res.spawnError ?? /ENOENT|not found|no such file/i.test(res.stderr),
  }
}

/** Prompt wrapper: bind the task to an app URL when one is known. */
export function a0TaskPrompt(task: string, url: string | undefined): string {
  return url === undefined || url === ''
    ? task
    : `Open ${url} in your browser, then do this task: ${task}`
}

/**
 * The typed delegation payload — allowlisted fields only (KTD4). Nothing
 * outside this record may reach the host: no ambient env, no raw journal
 * text, no transcript dumps.
 */
export interface A0TaskPayload {
  /** What the agent should do on the target. */
  task: string
  /** Application URL the agent opens first. */
  targetUrl: string | undefined
  /** The head SHA the evidence is bound to — the agent verifies against it. */
  intendedHeadSha: string | undefined
  /** One-line summary of what failed locally, when escalating a failure. */
  failureSummary: string | undefined
  /** Repo-relative evidence paths the agent may consult (app-lane.json etc.). */
  evidenceRefs: string[] | undefined
}

/** Render the typed payload into the delegated prompt — sanitized surface. */
export function buildA0LanePrompt(payload: A0TaskPayload): string {
  const lines = [
    'You are an escalation agent for the Argus PR reviewer.',
    `Task: ${payload.task}`,
  ]
  if (payload.targetUrl !== undefined && payload.targetUrl !== '') {
    lines.push(`Target: open ${payload.targetUrl} and work against that application.`)
  }
  if (payload.intendedHeadSha !== undefined && payload.intendedHeadSha !== '') {
    lines.push(`The evidence must describe the PR head ${payload.intendedHeadSha}.`)
  }
  if (payload.failureSummary !== undefined && payload.failureSummary !== '') {
    lines.push(`Local failure being escalated: ${payload.failureSummary}`)
  }
  if (payload.evidenceRefs !== undefined && payload.evidenceRefs.length > 0) {
    lines.push(`Local evidence you may consult: ${payload.evidenceRefs.join(', ')}`)
  }
  lines.push(
    'Report concisely what you observed and whether the task goal is met.',
    'Do not attempt to access provider keys, tokens, or repository secrets.',
  )
  return lines.join('\n')
}

/** What the `verify --a0` lane writes to `a0-lane.json`. */
export interface A0LaneReport {
  lane: 'a0'
  status: LaneStatus
  reason: string | undefined
  summary: string | undefined
  /** Resolved instance base URL (or how resolution failed). */
  host: string | undefined
  hostSource: string | undefined
  /** Whether the host can plausibly reach the configured target. */
  targetReachable: 'assumed' | 'refused' | 'unchecked' | undefined
  task: string | undefined
  /** The agent's answer text — evidence, not a verdict. */
  output: string | undefined
  /** Delegations actually attempted. */
  tasks: number
  durationMs: number
  /** a0 supplies no usage telemetry today — always false (R13). */
  metered: false
}

export interface A0LaneDeps {
  exec?: ExecFn
  /** Host reachability probe — requires an Agent Zero marker in the HTML. */
  probe?: ProbeFn
  /** Host resolver — tests inject a canned answer. */
  resolveHost?: () => Promise<{ host: string | undefined; source: string | undefined }>
  /** `a0 --version` presence check. */
  cliVersion?: () => Promise<string | undefined>
  /** CLI binary name — tests inject a stub path. */
  cli?: string
  /** User-facing line sink (scope summary, next actions). */
  note?: (line: string) => void
}

export interface A0LaneInput {
  /** Config a0 block — url, maxTasks, timeoutMs. */
  a0:
    | { url: string | undefined; maxTasks?: number | undefined; timeoutMs?: number | undefined }
    | undefined
  /** Ambient env for host resolution + allowlisted child env. */
  env: NodeJS.ProcessEnv | Record<string, string | undefined>
  /** Application target the agent will be asked to drive. */
  targetUrl: string | undefined
  /** Head SHA the run's evidence is bound to. */
  intendedHeadSha: string | undefined
  /** Task the agent performs — app lane task or an explicit a0 task. */
  task: string | undefined
  /** Local failure context when the lane escalates one. */
  failureSummary?: string | undefined
  /** Checkout trust — the executable lane refuses an untrusted tree. */
  trusted: boolean
  deps?: A0LaneDeps
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
export function isLoopback(url: string): boolean {
  try {
    if (new URL(url).protocol === 'file:') return true
    const host = new URL(url).hostname.replace(/\.$/, '').toLowerCase()
    if (host === 'localhost' || host.endsWith('.localhost')) return true
    // Node keeps IPv6 brackets in .hostname and normalizes mapped forms:
    // [::1] stays, [::ffff:127.0.0.1] arrives as [::ffff:7f00:1], and
    // short/integer IPv4 (127.1, 2130706433) normalizes to dotted-quad.
    if (host === '[::1]' || host === '[::]') return true
    const mapped = host.match(/^\[::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/i)
    if (mapped !== null) {
      const hi = parseInt(mapped[1] ?? 'x', 16)
      const lo = parseInt(mapped[2] ?? 'x', 16)
      const first = (hi >> 8) & 0xff
      if (first === 127 || (hi === 0 && lo === 0)) return true
    }
    const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
    if (v4 !== null) {
      const octets = v4.slice(1).map((g) => Number(g ?? ''))
      if (octets.every((n) => Number.isInteger(n) && n <= 255) && (octets[0] === 127 || octets[0] === 0)) {
        return true
      }
    }
    return false
  } catch {
    return false
  }
}

/**
 * `verify --a0` lane: explicit selection only, every preflight outcome
 * recorded, zero spend before the host is proven reachable, and a hard
 * `inconclusive` ceiling — a completed delegation is evidence, and the
 * agent's report of what it saw is self-reported, not a verdict.
 */
export async function runA0Lane(input: A0LaneInput): Promise<A0LaneReport> {
  const started = Date.now()
  const deps = input.deps ?? {}
  const note = deps.note ?? (() => undefined)

  const done = (
    status: LaneStatus,
    reason: string | undefined,
    extra?: Partial<A0LaneReport>,
  ): A0LaneReport => ({
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
  })

  // Executable lanes are gated on the same trust resolution as config
  // loading (SECURITY.md): an untrusted checkout never resolves a host or
  // spawns the a0 CLI — blocked before any preflight.
  if (!input.trusted) {
    return done(
      'blocked',
      'verify --a0 is an executable lane — requires a trusted checkout',
    )
  }

  if (input.task === undefined || input.task.trim() === '') {
    return done('blocked', 'no delegated task configured — set a0 task via config app.task or the app lane')
  }

  // Preflight 1: host resolution — config wins, then the CLI's own chain
  // (env, ~/.agent-zero/.env, localhost probe). Missing both ends = nothing
  // to reach. A configured a0.url skips the probe chain entirely.
  const resolveHost =
    deps.resolveHost ??
    (async () => {
      const r = await resolveA0Host(input.env as NodeJS.ProcessEnv, {
        ...(deps.probe !== undefined ? { probe: deps.probe } : {}),
      })
      return { host: r.host, source: r.source }
    })
  const cliVersion =
    deps.cliVersion ??
    (async () => {
      // The presence probe spawns the a0 binary too — it gets the same
      // allowlisted env as the delegation or the whole contract is moot.
      const res = await (deps.exec ?? defaultExec)(
        deps.cli ?? 'a0',
        ['--version'],
        5_000,
        undefined,
        { baseEnv: buildA0ChildEnv(input.env) },
      )
      return res.code === 0 ? res.stdout.trim() : undefined
    })
  const configured = input.a0?.url !== undefined && input.a0.url !== ''
  const [resolved, version] = await Promise.all([
    configured ? Promise.resolve({ host: undefined, source: undefined }) : resolveHost(),
    cliVersion(),
  ])
  const host = input.a0?.url ?? resolved.host
  const hostSource = input.a0?.url !== undefined ? 'config' : resolved.source
  if (version === undefined && host === undefined) {
    return done(
      'unavailable',
      'no Agent Zero found — install the a0 CLI or set a0.url / AGENT_ZERO_HOST',
    )
  }
  if (host === undefined) {
    // CLI present, host unresolved — the CLI may still self-resolve, but the
    // lane must prove a host before spending: record the gap honestly.
    return done(
      'unavailable',
      'a0 CLI is installed but no host resolved — set AGENT_ZERO_HOST or a0.url',
    )
  }

  // Preflight 2: the host must answer as Agent Zero — a URL that serves
  // something else is worse than no host.
  const probe = deps.probe ?? defaultProbe
  if (!(await probe(host, 5_000))) {
    return done('unavailable', `a0 host did not answer as Agent Zero: ${host}`, {
      host,
      hostSource,
    })
  }

  // Preflight 3: can the host reach the target? A remote a0 cannot drive a
  // loopback app on this machine — that's a scope refusal, not a failure.
  if (
    input.targetUrl !== undefined &&
    isLoopback(input.targetUrl) &&
    !isLoopback(host)
  ) {
    return done(
      'blocked',
      `a0 host ${host} is remote but the target ${input.targetUrl} is loopback — the host cannot reach it`,
      { host, hostSource, targetReachable: 'refused' },
    )
  }

  const maxTasks = input.a0?.maxTasks ?? A0_LANE_MAX_TASKS
  const timeoutMs = input.a0?.timeoutMs ?? A0_DEFAULT_TIMEOUT_MS
  note(
    `a0 lane: delegating 1 task to ${host} (max ${maxTasks}, ` +
      `${Math.round(timeoutMs / 1000)}s wall-clock, usage unmetered, ${A0_LIVE_LABEL})`,
  )

  const payload = buildA0LanePrompt({
    task: input.task,
    targetUrl: input.targetUrl,
    intendedHeadSha: input.intendedHeadSha,
    failureSummary: input.failureSummary ?? undefined,
    evidenceRefs: undefined,
  })
  const res = await runA0Task(payload, {
    host,
    timeoutMs,
    env: buildA0ChildEnv(input.env),
    ...(deps.exec !== undefined ? { exec: deps.exec } : {}),
    ...(deps.cli !== undefined ? { cli: deps.cli } : {}),
  })

  if (res.spawnError === true) {
    return done('unavailable', `a0 delegation could not start: ${res.output}`, {
      host,
      hostSource,
    })
  }
  if (res.timedOut === true) {
    return done('inconclusive', `a0 delegation timed out after ${timeoutMs}ms`, {
      host,
      hostSource,
      output: res.output !== '' ? res.output : undefined,
      tasks: 1,
    })
  }
  // Every completed delegation — success or reported failure — is evidence
  // whose truth rests on the agent's own report: inconclusive, never passed.
  return done(
    'inconclusive',
    res.ok ? undefined : `a0 delegation reported failure: ${res.output}`,
    {
      host,
      hostSource,
      targetReachable: input.targetUrl !== undefined ? 'assumed' : 'unchecked',
      output: res.output !== '' ? res.output : undefined,
      tasks: 1,
    },
  )
}
