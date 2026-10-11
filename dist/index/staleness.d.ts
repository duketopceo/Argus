import { type RepoIndex } from './scan.js';
/**
 * Per-review staleness signal for `argus.index.json` — the Greptile-gap
 * answer to "the index is opt-in and goes stale silently". Rather than an
 * age heuristic, the check is exact: a changed file whose on-disk sha256
 * no longer matches its index entry's contentHash had provable drift
 * under review. Files absent from the index are `missing` (new files are
 * coverage, not staleness); unreadable files count as stale — the hash
 * can no longer be proven.
 */
export interface IndexStaleness {
    /** Index write time, echoed from the index for the warning line. */
    generatedAt: string;
    /** Reviewed files present in the index (hash-checkable). */
    checked: number;
    /** Of those, contentHash no longer matches the file on disk. */
    stale: number;
    /** Reviewed files with no index entry at all. */
    missing: number;
}
export declare function indexStaleness(index: RepoIndex, 
/** Repo-relative paths under review (post-exclude). */
files: string[], 
/** Checked-out tree the review ran against. */
cwd: string): Promise<IndexStaleness>;
