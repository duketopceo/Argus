import type { Sandbox } from '../config.js';
import { type PrMeta } from './ci.js';
/**
 * The label approves only the head it was applied to: the `labeled` event
 * must postdate `head.repo.pushed_at`. A `synchronize` push after approval
 * requires a fresh label — otherwise approval silently carries to code the
 * maintainer never saw. Either timestamp missing → label doesn't approve
 * (fail closed).
 */
export declare function labelCoversHead(meta: PrMeta): boolean;
/**
 * Fork gate for the sandbox probe lane (KTD5). Evaluation order: the lane
 * must be `enabled`; `allowForks: true` runs everywhere; same-repo PRs run
 * unconditionally; fork PRs require a per-head `argus-probe` label or a
 * trusted author_association. Fails closed — missing PR metadata, deleted
 * forks (`isFork` forced true in fetchPrMeta), and stale labels all deny.
 */
export declare function mayProbePr(meta: PrMeta | undefined, sandbox: Sandbox): boolean;
