import { isTrustedAssociation, PROBE_LABEL } from './ci.js';
export { PROBE_LABEL };
/**
 * The label approves only the head it was applied to: the `labeled` event
 * must postdate `head.repo.pushed_at`. A `synchronize` push after approval
 * requires a fresh label — otherwise approval silently carries to code the
 * maintainer never saw. Either timestamp missing → label doesn't approve
 * (fail closed).
 */
function labelCoversHead(meta) {
    return (meta.labelApprovedAt !== undefined &&
        meta.pushedAt !== undefined &&
        meta.labelApprovedAt > meta.pushedAt);
}
/**
 * Fork gate for the sandbox probe lane (KTD5). Evaluation order: the lane
 * must be `enabled`; `allowForks: true` runs everywhere; same-repo PRs run
 * unconditionally; fork PRs require a per-head `argus-probe` label or a
 * trusted author_association. Fails closed — missing PR metadata, deleted
 * forks (`isFork` forced true in fetchPrMeta), and stale labels all deny.
 */
export function mayProbePr(meta, sandbox) {
    if (!sandbox.enabled || meta === undefined)
        return false;
    if (sandbox.allowForks || !meta.isFork)
        return true;
    if (isTrustedAssociation(meta.authorAssociation))
        return true;
    return meta.labels.includes(PROBE_LABEL) && labelCoversHead(meta);
}
