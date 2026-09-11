import { type RepoIndex } from './scan.js';
export declare const CONTEXT_PREFIX = "> context:";
export interface ContextRequest {
    /** Repo-relative path as reported by the PR files API. */
    filename: string;
    /** For renames, the pre-rename path — the index likely still holds it. */
    previousFilename?: string | undefined;
}
/**
 * Build per-file `> context:` blocks from an already-loaded index. Values are
 * sanitized before they reach an LLM prompt — index data is repo-controlled
 * text and must be treated as untrusted. Files absent from the index are
 * silently omitted; renames fall back to the pre-rename path.
 */
export declare function buildReviewContext(index: RepoIndex | undefined, files: ContextRequest[]): Record<string, string>;
/** Convenience wrapper: read argus.index.json then build the context map. */
export declare function loadReviewContext(indexPath: string, files: ContextRequest[]): Promise<Record<string, string>>;
