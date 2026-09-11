export declare const INDEX_SCHEMA_VERSION = 1;
export interface IndexEntry {
    /** Repo-relative path. */
    path: string;
    /** Best-effort purpose: first doc comment or leading export names. */
    purpose?: string;
    /** Repo-relative paths this file imports (TS/JS only). */
    imports: string[];
    /** Repo-relative paths that import this file — the transitive backstop for diff invalidation. */
    importedBy: string[];
    /** Nearest ancestor package.json version, when present. */
    packageVersion?: string;
    /** sha256 of file contents — cheap staleness signal. */
    contentHash: string;
}
export interface RepoIndex {
    schemaVersion: typeof INDEX_SCHEMA_VERSION;
    generatedAt: string;
    root: string;
    entries: IndexEntry[];
}
/** Scan a repo into a RepoIndex. Never throws on individual file failures. */
export declare function scanRepo(root: string): Promise<RepoIndex>;
export declare function writeIndex(index: RepoIndex, outPath: string): Promise<void>;
/** Load a previously written index; undefined when absent, oversized, or malformed. */
export declare function readIndex(path: string): Promise<RepoIndex | undefined>;
