import { spawn, type ChildProcess } from 'node:child_process'

import type { Target } from '../config.js'

const POLL_INTERVAL_MS = 250
const STOP_GRACE_MS = 3_000

/**
 * Boot adapter for the run target (R11): spawn a shell command, poll the URL
 * until it answers with HTTP 2xx/3xx or the ready timeout elapses, then let
 * the run proceed. stop() kills the whole spawned process tree.
 */
export class TargetProcess {
  private stopped = false

  private constructor(
    private readonly child: ChildProcess,
    private readonly spec: Target,
  ) {}

  get url(): string {
    return this.spec.url
  }

  get pid(): number | undefined {
    return this.child.pid
  }

  static async start(spec: Target): Promise<TargetProcess> {
    const child = spawn(spec.command, {
      shell: true,
      detached: true,
      stdio: 'ignore',
    })

    const proc = new TargetProcess(child, spec)

    const childExited = new Promise<never>((_, reject) => {
      child.once('error', (err) => reject(err))
      child.once('exit', (code, signal) =>
        reject(
          new Error(
            `Target command exited before ${spec.url} became ready ` +
              `(code=${code ?? 'null'}, signal=${signal ?? 'null'})`,
          ),
        ),
      )
    })

    const ready = (async (): Promise<void> => {
      const deadline = Date.now() + spec.readyTimeoutMs
      for (;;) {
        try {
          const res = await fetch(spec.url, { redirect: 'manual' })
          if (res.status >= 200 && res.status < 400) return
        } catch {
          // connection refused / not up yet — keep polling
        }
        if (Date.now() >= deadline) {
          throw new Error(
            `Target did not become ready: ${spec.url} did not respond ` +
              `with HTTP 2xx/3xx within ${spec.readyTimeoutMs}ms`,
          )
        }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
      }
    })()

    try {
      await Promise.race([ready, childExited])
    } catch (e) {
      await proc.stop()
      throw e
    }

    return proc
  }

  /** Kill the spawned process tree (process group). Idempotent. */
  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true

    const exited = new Promise<void>((resolve) => {
      this.child.once('exit', () => resolve())
      setTimeout(resolve, STOP_GRACE_MS).unref()
    })

    try {
      // Negative pid kills the detached process group — the shell and its children.
      if (this.child.pid !== undefined) process.kill(-this.child.pid, 'SIGTERM')
    } catch {
      // already gone
    }

    await exited

    try {
      if (this.child.exitCode === null && this.child.pid !== undefined) {
        process.kill(-this.child.pid, 'SIGKILL')
      }
    } catch {
      // already gone
    }
  }
}
