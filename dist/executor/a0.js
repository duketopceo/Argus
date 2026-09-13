import { defaultExec } from '../detect.js';
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
export const A0_DEFAULT_TIMEOUT_MS = 600_000;
export function buildA0Args(prompt, host) {
    const args = ['headless', '--new-chat', '--output', 'text'];
    if (host !== undefined && host !== '')
        args.push('--host', host);
    args.push('-p', prompt);
    return args;
}
export async function runA0Task(prompt, opts = {}) {
    const exec = opts.exec ?? defaultExec;
    let res;
    try {
        res = await exec(opts.cli ?? 'a0', buildA0Args(prompt, opts.host), opts.timeoutMs ?? A0_DEFAULT_TIMEOUT_MS);
    }
    catch (e) {
        // Spawn rejection (ENOENT when a0 is absent, hard timeout) must degrade
        // to a failed delegation, not abort the calling command.
        return { ok: false, output: e.message };
    }
    return { ok: res.code === 0, output: res.stdout.trim() || res.stderr.trim() };
}
/** Prompt wrapper: bind the task to an app URL when one is known. */
export function a0TaskPrompt(task, url) {
    return url === undefined || url === ''
        ? task
        : `Open ${url} in your browser, then do this task: ${task}`;
}
