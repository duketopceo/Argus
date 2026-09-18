import { readFile } from 'node:fs/promises'

import type { PrMeta } from './evidence/ci.js'

/**
 * Checkout trust — decided BEFORE `loadConfig` runs, because loading a
 * PR-controlled `argus-reviewer.config.ts` executes arbitrary code beside
 * `OPENROUTER_API_KEY`/`GITHUB_TOKEN` (#58).
 *
 * Trust keys on fork status of the checked-out tree, never on
 * `author_association` — a MEMBER can author a hostile fork PR.
 */
export type Trust = 'trusted' | 'untrusted'

export interface TrustResult {
  trust: Trust
  reason: string
  /**
   * PR number derived from the event payload on `issue_comment` events
   * (`issue.number` when the issue is a PR). Undefined otherwise — the
   * caller's own repo/pr derivation still applies.
   */
  pr: string | undefined
}

export interface ResolveTrustOpts {
  env: Record<string, string | undefined>
  /**
   * Fetches PR metadata — required only on `issue_comment` (the payload has
   * no `head.repo.fork`) and as a fallback when a `pull_request*` payload
   * is unreadable. Injectable for tests.
   */
  fetchMeta?: (repo: string, pr: string, token: string) => Promise<PrMeta | undefined>
  /** Injectable event-payload reader for tests. Defaults to node fs. */
  readEventFile?: (path: string) => Promise<string>
  /** Human-readable note on the resolved decision (e.g. ctx.err). */
  note?: (line: string) => void
}

interface EventPayload {
  pull_request?: { head?: { repo?: { fork?: boolean } | null } }
  issue?: { number?: number; pull_request?: unknown }
}

async function readEventPayload(
  env: Record<string, string | undefined>,
  readEventFile: (path: string) => Promise<string>,
): Promise<EventPayload | undefined> {
  const eventPath = env.GITHUB_EVENT_PATH
  if (eventPath === undefined || eventPath === '') return undefined
  try {
    const parsed = JSON.parse(await readEventFile(eventPath)) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined
    }
    return parsed as EventPayload
  } catch {
    return undefined
  }
}

function tracePr(env: Record<string, string | undefined>): string | undefined {
  const raw = env.ARGUS_REVIEWER_TRACE
  if (raw === undefined) return undefined
  try {
    const parsed = JSON.parse(raw) as { pr?: unknown }
    return typeof parsed.pr === 'string' && parsed.pr !== '' ? parsed.pr : undefined
  } catch {
    return undefined
  }
}

async function fetchMetaFor(
  opts: ResolveTrustOpts,
  prOverride?: string,
): Promise<PrMeta | undefined> {
  const { env, fetchMeta } = opts
  if (fetchMeta === undefined) return undefined
  const repo = env.GITHUB_REPOSITORY
  const token = env.GITHUB_TOKEN ?? env.GH_TOKEN
  const pr = prOverride ?? tracePr(env)
  if (repo === undefined || token === undefined || pr === undefined) return undefined
  return fetchMeta(repo, pr, token)
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
export async function resolveTrust(opts: ResolveTrustOpts): Promise<TrustResult> {
  const { env, note } = opts
  const readEventFile = opts.readEventFile ?? ((p: string) => readFile(p, 'utf8'))
  const done = (trust: Trust, reason: string, pr?: string): TrustResult => {
    note?.(`trust: ${trust} — ${reason}`)
    return { trust, reason, pr }
  }

  if (env.ARGUS_UNTRUSTED === '1') {
    return done('untrusted', 'ARGUS_UNTRUSTED=1')
  }
  if (env.ARGUS_TRUSTED === '1') {
    return done('trusted', 'ARGUS_TRUSTED=1 override')
  }

  const eventName = env.GITHUB_EVENT_NAME
  if (eventName === undefined || eventName === '') {
    return done('trusted', 'local run — no CI event context')
  }

  const payload = await readEventPayload(env, readEventFile)

  if (eventName === 'pull_request' || eventName === 'pull_request_target') {
    const fork = payload?.pull_request?.head?.repo?.fork
    if (fork === true) return done('untrusted', 'fork PR head checkout')
    if (fork === false) return done('trusted', 'same-repo PR checkout')
    // Payload absent/unreadable (or head.repo null — a deleted source fork
    // fails closed the same way evidence/ci.ts's isFork does): try the API.
    const meta = await fetchMetaFor(opts)
    if (meta !== undefined) {
      return meta.isFork
        ? done('untrusted', 'fork PR (metadata)')
        : done('trusted', 'same-repo PR (metadata)')
    }
    return done('untrusted', 'PR fork status unavailable — failing closed')
  }

  if (eventName === 'issue_comment') {
    const pr =
      payload?.issue?.pull_request !== undefined && typeof payload.issue?.number === 'number'
        ? String(payload.issue.number)
        : undefined
    const meta = await fetchMetaFor(opts, pr)
    if (meta !== undefined) {
      return meta.isFork
        ? done('untrusted', 'issue_comment on fork PR', pr)
        : done('trusted', 'issue_comment on same-repo PR', pr)
    }
    return done('untrusted', 'issue_comment PR metadata unavailable — failing closed', pr)
  }

  return done('untrusted', `unlisted CI event "${eventName}" — failing closed`)
}
