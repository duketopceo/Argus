import type { RepoIndex } from '../index/scan.js';
import type { ToolCallRecord, ToolSpec } from '../vision/openrouter.js';
/** Cap on bytes returned to the model per read — keeps rounds cheap. */
export declare const TOOL_READ_CAP: number;
/** Mask a tool call record for the report transcript — args and result both. */
export declare function maskToolRecord(r: ToolCallRecord): ToolCallRecord;
export interface RepoToolContext {
    /** Review checkout root — realpath-confinement root. */
    cwd: string;
    /** Loaded repo index; absent → no tools (reads can't be gated). */
    index: RepoIndex | undefined;
    /** Set on the issue_comment lane — reads see the base ref, not the PR head. */
    staleBase?: boolean;
}
/**
 * Build the tool whitelist + executor for one review. Returns undefined when
 * there is no index — without membership data no read can be gated, so the
 * tools stay off rather than reading unvetted paths.
 */
export declare function repoTools(ctx: RepoToolContext): {
    specs: ToolSpec[];
    run: (name: string, args: Record<string, unknown>) => Promise<string>;
} | undefined;
