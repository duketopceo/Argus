import type { PrMeta } from './evidence/ci.js';
/**
 * Checkout trust — decided BEFORE `loadConfig` runs, because loading a
 * PR-controlled `argus-reviewer.config.ts` executes arbitrary code beside
 * `OPENROUTER_API_KEY`/`GITHUB_TOKEN` (#58).
 *
 * Trust keys on fork status of the checked-out tree, never on
 * `author_association` — a MEMBER can author a hostile fork PR.
 */
export type Trust = 'trusted' | 'untrusted';
export interface TrustResult {
    trust: Trust;
    reason: string;
    /**
     * PR number derived from the event payload on `issue_comment` events
     * (`issue.number` when the issue is a PR). Undefined otherwise — the
     * caller's own repo/pr derivation still applies.
     */
    pr: string | undefined;
}
export interface ResolveTrustOpts {
    env: Record<string, string | undefined>;
    /**
     * Fetches PR metadata — required only on `issue_comment` (the payload has
     * no `head.repo.fork`) and as a fallback when a `pull_request*` payload
     * is unreadable. Injectable for tests.
     */
    fetchMeta?: (repo: string, pr: string, token: string) => Promise<PrMeta | undefined>;
    /** Injectable event-payload reader for tests. Defaults to node fs. */
    readEventFile?: (path: string) => Promise<string>;
    /** Human-readable note on the resolved decision (e.g. ctx.err). */
    note?: (line: string) => void;
}
/**
 * Resolves whether the checked-out tree may execute config code.
 *
 * - `pull_request*` events: fork status from the event payload — no token
 *   needed (`head.repo.fork`). Payload absent/unreadable → `fetchMeta`
 *   fallback → still unknown → untrusted.
 * - `issue_comment`: `fetchMeta` on `issue.number`; unavailable → untrusted.
 * - Any other present `GITHUB_EVENT_NAME` (`workflow_run`, `push`,
 *   `workflow_dispatch`, …): untrusted — unlisted CI events fail closed
 *   because privileged-CI-over-fork-checkout patterns (workflow_run over a
 *   fork SHA) land exactly there. Maintainers opt out explicitly with
 *   `ARGUS_TRUSTED=1`.
 * - No event env at all (local run): trusted unless `ARGUS_UNTRUSTED=1`.
 * - `ARGUS_UNTRUSTED=1` always wins; `ARGUS_TRUSTED=1` overrides event
 *   resolution but never `ARGUS_UNTRUSTED`.
 */
export declare function resolveTrust(opts: ResolveTrustOpts): Promise<TrustResult>;
