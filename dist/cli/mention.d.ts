import { type Ctx, type CliDeps } from './shared.js';
/**
 * `argus-reviewer mention` — the E3.U5 dispatch lane. Everything upstream
 * of the command handler is a gate: untrusted commenters are ignored
 * silently (no reply channel for drive-by spam), fork-head PRs need the
 * per-head probe label for execution commands, and record/persist never
 * run on forks at all.
 */
export declare function cmdMention(args: string[], ctx: Ctx, deps: CliDeps): Promise<number>;
