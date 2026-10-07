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
export interface SynthesizedDiff {
    diff: string;
    /** Files that got a new-file section. */
    filesWritten: number;
    /** Files skipped — oversized or unreadable mid-synthesis. */
    filesSkipped: number;
}
/**
 * U7 — synthesize a unified diff treating every walked file as new
 * (`--- /dev/null` / `+++ b/`), so the deterministic lanes (rules,
 * secrets) can consume a plain tree the way they consume a PR diff.
 * Emitting the diff ourselves means headers are always `b/` and never
 * C-quoted — the ambient-gitconfig evasion class cannot apply.
 */
export declare function synthesizeTreeDiff(root: string, entries: readonly {
    path: string;
}[]): Promise<SynthesizedDiff>;
/** Scan a repo into a RepoIndex. Never throws on individual file failures. */
export declare function scanRepo(root: string, opts?: {
    includeDotfile?: (name: string) => boolean;
}): Promise<RepoIndex>;
export declare function writeIndex(index: RepoIndex, outPath: string): Promise<void>;
/** Load a previously written index; undefined when absent, oversized, or malformed. */
export declare function readIndex(path: string): Promise<RepoIndex | undefined>;
