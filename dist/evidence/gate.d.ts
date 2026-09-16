import type { Sandbox } from '../config.js';
import type { PrMeta } from './ci.js';
/** Maintainer-applied PR label that opts a fork PR into sandbox probes. */
export declare const PROBE_LABEL = "argus-probe";
/**
 * Fork gate for the sandbox probe lane (KTD5). Evaluation order: the lane
 * must be `enabled`; `allowForks: true` runs everywhere; same-repo PRs run
 * unconditionally; fork PRs require a per-head `argus-probe` label or a
 * trusted author_association. Fails closed — missing PR metadata, deleted
 * forks (`isFork` forced true in fetchPrMeta), and stale labels all deny.
 */
export declare function mayProbePr(meta: PrMeta | undefined, sandbox: Sandbox): boolean;
