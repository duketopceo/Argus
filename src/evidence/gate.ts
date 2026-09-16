import type { Sandbox } from '../config.js'
import type { PrMeta } from './ci.js'

/** Maintainer-applied PR label that opts a fork PR into sandbox probes. */
export const PROBE_LABEL = 'argus-probe'

/**
 * GitHub `author_association` values trusted to run probes on fork PRs —
 * repo members/owners/collaborators. CONTRIBUTOR, FIRST_TIME_CONTRIBUTOR,
 * FIRST_TIMER, MANNEQUIN, and NONE are not.
 */
const TRUSTED_ASSOCIATIONS: ReadonlySet<string> = new Set(['MEMBER', 'OWNER', 'COLLABORATOR'])

/**
 * The label approves only the head it was applied to: the `labeled` event
 * must postdate `head.repo.pushed_at`. A `synchronize` push after approval
 * requires a fresh label — otherwise approval silently carries to code the
 * maintainer never saw. Either timestamp missing → label doesn't approve
 * (fail closed).
 */
function labelCoversHead(meta: PrMeta): boolean {
  return (
    meta.labelApprovedAt !== undefined &&
    meta.pushedAt !== undefined &&
    meta.labelApprovedAt > meta.pushedAt
  )
}

/**
 * Fork gate for the sandbox probe lane (KTD5). Evaluation order: the lane
 * must be `enabled`; `allowForks: true` runs everywhere; same-repo PRs run
 * unconditionally; fork PRs require a per-head `argus-probe` label or a
 * trusted author_association. Fails closed — missing PR metadata, deleted
 * forks (`isFork` forced true in fetchPrMeta), and stale labels all deny.
 */
export function mayProbePr(meta: PrMeta | undefined, sandbox: Sandbox): boolean {
  if (!sandbox.enabled || meta === undefined) return false
  if (sandbox.allowForks || !meta.isFork) return true
  if (TRUSTED_ASSOCIATIONS.has(meta.authorAssociation ?? '')) return true
  return meta.labels.includes(PROBE_LABEL) && labelCoversHead(meta)
}
