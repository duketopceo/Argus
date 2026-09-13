import { defaultExec, type ExecFn } from '../detect.js'

/**
 * Agent Zero delegation — the thin seam that hands a natural-language task to
 * an `a0` instance (`a0 headless -p`). The instance runs autonomously inside
 * its own sandboxed desktop/browser; Argus gets back the agent's final answer.
 *
 * This is deliberately NOT a replay path: every delegation is a full-cost,
 * non-deterministic agent run. Fingerprint replay stays local and ~free; A0 is
 * for healing, second opinions on failures, and exploratory tasks that were
 * never recorded.
 */

export const A0_DEFAULT_TIMEOUT_MS = 600_000

export interface A0TaskOptions {
  /** Instance base URL. Omit to let the `a0` CLI resolve it itself. */
  host?: string | undefined
  /** Binary name/path — tests inject a stub. */
  cli?: string
  timeoutMs?: number
  exec?: ExecFn
}

export interface A0TaskResult {
  ok: boolean
  /** The agent's final answer text, or the error output when !ok. */
  output: string
}

export function buildA0Args(prompt: string, host: string | undefined): string[] {
  const args = ['headless', '--new-chat', '--output', 'text']
  if (host !== undefined && host !== '') args.push('--host', host)
  args.push('-p', prompt)
  return args
}

export async function runA0Task(prompt: string, opts: A0TaskOptions = {}): Promise<A0TaskResult> {
  const exec = opts.exec ?? defaultExec
  const res = await exec(
    opts.cli ?? 'a0',
    buildA0Args(prompt, opts.host),
    opts.timeoutMs ?? A0_DEFAULT_TIMEOUT_MS,
  )
  const output = (res.stdout.trim() || res.stderr.trim()).trim()
  return { ok: res.code === 0, output }
}

/** Prompt wrapper: bind the task to an app URL when one is known. */
export function a0TaskPrompt(task: string, url: string | undefined): string {
  return url === undefined
    ? task
    : `Open ${url} in your browser, then do this task: ${task}`
}
