/**
 * Chunk planning for large PRs.
 *
 * A diff over the per-call token target is reviewed in several model calls
 * instead of one oversized (or truncated) prompt. Files are grouped by
 * directory so a chunk reads as one area of the change, and a single patch
 * larger than the target is split at hunk boundaries. Every chunk records
 * which files it carries so a partial review can say what it did not cover.
 */
export interface ChunkFile {
    filename: string;
    patch?: string;
}
export interface PlannedChunk {
    /** Prompt text for this chunk. */
    text: string;
    /** Files with content in this chunk (a split file appears in each part). */
    files: string[];
}
export declare function planChunks(files: ChunkFile[], contexts?: Record<string, string>, targetTokens?: number): PlannedChunk[];
