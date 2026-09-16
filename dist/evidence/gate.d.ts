import type { Sandbox } from '../config.js';
import { PROBE_LABEL, type PrMeta } from './ci.js';
export { PROBE_LABEL };
/**
 * Fork gate for the sandbox probe lane (KTD5). Evaluation order: the lane
 * must be `enabled`; `allowForks: true` runs everywhere; same-repo PRs run
 * unconditionally; fork PRs require a per-head `argus-probe` label or a
 * trusted author_association. Fails closed — missing PR metadata, deleted
 * forks (`isFork` forced true in fetchPrMeta), and stale labels all deny.
 */
export declare function mayProbePr(meta: PrMeta | undefined, sandbox: Sandbox): boolean;
