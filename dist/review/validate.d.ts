/**
 * Deterministic finding validation (no model). A finding must point at a
 * file that is in the reviewed diff and at a line inside the diff's
 * changed hunks (plus a small context tolerance). Anything else is a
 * hallucinated or stale anchor; it is dropped here and counted in the
 * report so the drop is never silent.
 */
export type DropReason = 'file_not_in_diff' | 'file_excluded' | 'file_deleted' | 'line_beyond_file' | 'line_outside_diff';
export interface DroppedFinding {
    file: string;
    line?: number;
    reason: DropReason;
}
export interface ValidationAudit {
    dropped: number;
    byReason: Partial<Record<DropReason, number>>;
    /** Up to 10 dropped anchors, for the Diagnostics fold. */
    examples: DroppedFinding[];
}
/** Lines of slack around a hunk: models are often off by a line or two. */
export declare const HUNK_TOLERANCE = 2;
export interface ParsedHunks {
    /** Inclusive new-side [start, end] line ranges, one per hunk with new lines. */
    ranges: [number, number][];
    /** Set when the patch creates the file: its exact line count. */
    newFileLength?: number;
    /** True when no new-side lines survive (file deleted at head). */
    deleted: boolean;
}
export declare function parseHunks(patch: string): ParsedHunks;
export declare function validateFindings<T extends {
    file: string;
    line?: number;
}>(findings: T[], files: {
    filename: string;
    patch?: string;
}[], excluded?: ReadonlySet<string>): {
    kept: T[];
    dropped: DroppedFinding[];
};
export declare function auditOf(dropped: DroppedFinding[]): ValidationAudit;
