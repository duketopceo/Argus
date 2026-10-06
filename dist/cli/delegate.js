import { resolveA0Host } from '../detect.js';
import { A0_DEFAULT_TIMEOUT_MS, isLoopback, runA0Task, a0TaskPrompt } from '../executor/a0.js';
import { CliError } from '../ui/errors.js';
import { usageError, resolveCheckoutTrust, loadCliConfig, reportError } from './shared.js';
import { parseArgs } from 'node:util';
export const DELEGATE_USAGE = `Usage: argus-reviewer delegate "<task>" [options]

Sends a task to an Agent Zero instance (a0 headless). The agent works
autonomously in its own browser/desktop and streams back its result. Every
delegation is a full-cost agent run; use for exploratory tasks and failure
triage, not as a replay path.

Options:
  --url <url>      App URL the task applies to (falls back to config.target.url)
  --host <url>     Agent Zero base URL (falls back to config a0.url, then a0
                   CLI discovery: AGENT_ZERO_HOST, ~/.agent-zero/.env, localhost)
  --timeout <ms>   Give up after N ms (default ${A0_DEFAULT_TIMEOUT_MS})

  -h, --help       Show this help`;
/** `argus-reviewer delegate` — hand a task to an Agent Zero instance. */
export async function cmdDelegate(args, ctx, deps) {
    const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: {
            help: { type: 'boolean', short: 'h', default: false },
            url: { type: 'string' },
            host: { type: 'string' },
            timeout: { type: 'string' },
        },
    });
    if (values.help) {
        ctx.out(DELEGATE_USAGE);
        return 0;
    }
    const task = positionals.join(' ').trim();
    if (task === '') {
        usageError(ctx, 'delegate', 'no task given; pass it as a positional argument', 'argus-reviewer delegate "<task>" --url <target>');
        return 2;
    }
    let timeoutMs = A0_DEFAULT_TIMEOUT_MS;
    if (values.timeout !== undefined) {
        const parsed = Number(values.timeout);
        if (!Number.isFinite(parsed) || parsed <= 0) {
            usageError(ctx, 'delegate', '--timeout must be a positive number of milliseconds');
            return 2;
        }
        timeoutMs = Math.floor(parsed);
    }
    const { trust } = await resolveCheckoutTrust(ctx);
    const config = await loadCliConfig(ctx, trust);
    const url = values.url ?? config.target?.url;
    // Same reachability refusal as the lane's preflight: a remote host cannot
    // open a loopback/file target on this machine. Resolve the effective host
    // first — AGENT_ZERO_HOST or the dotfile can name a remote instance even
    // when no flag/config sets one, and the child env forwards AGENT_ZERO_HOST,
    // so an unresolved host here would bypass the refusal entirely.
    let host = values.host ?? config.a0?.url;
    if (host === undefined) {
        host = (await resolveA0Host(ctx.env, {
            ...(deps.exec !== undefined ? { exec: deps.exec } : {}),
            ...(deps.probe !== undefined ? { probe: deps.probe } : {}),
        })).host;
    }
    if (host !== undefined && url !== undefined && isLoopback(url) && !isLoopback(host)) {
        reportError(ctx, new CliError('A0_UNREACHABLE', `a0 host ${host} is remote but the target ${url} is loopback; the host cannot reach it`, {
            fix: 'set a0.url to a host that can reach the target, or pass --host',
        }), 'delegate', 'A0_UNREACHABLE');
        return 1;
    }
    ctx.out(`delegating to agent zero${host !== undefined ? ` (${host})` : ''}…`);
    const res = await runA0Task(a0TaskPrompt(task, url), {
        host,
        timeoutMs,
        ...(deps.exec !== undefined ? { exec: deps.exec } : {}),
    });
    if (res.spawnError === true) {
        reportError(ctx, new CliError('A0_UNREACHABLE', `could not start the a0 CLI: ${res.output}`), 'delegate', 'A0_UNREACHABLE');
        return 1;
    }
    if (res.output !== '')
        ctx.out(res.output);
    return res.ok ? 0 : 1;
}
