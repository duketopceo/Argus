import { type ProbeRecord } from './queue.js';
interface Ctx {
    err: (line: string) => void;
}
/**
 * `@argus persist` — reproduced probes become regression tests (roadmap
 * E1.U3). Probe files are written transiently and deleted during review,
 * so `reproduced` records carry their source + suggested path in
 * code-review.json. The sticky comment embeds them as a base64 HTML-comment
 * payload (`PERSIST_MARKER`) — a later `issue_comment` run on a base-only
 * checkout decodes it and commits the probes to a new branch via the
 * contents API, then opens one regression-test PR per source PR.
 *
 * Trust: payload content is model-authored. It passed the probe lane's
 * validation once (forced `argus-probe-` filename, safe repo path, bounded
 * imports), but the sticky comment is editable — decode() re-validates
 * every path and bound before any write, and writes go to a dedicated
 * branch, never the base ref.
 */
export interface PersistableProbe {
    /** Repo-relative write path — `argus-probe-*` basename, validated. */
    path: string;
    /** Probe source (bounded). */
    content: string;
    /** Probe filename for messaging. */
    file: string;
    /** Finding file the probe covers, when known. */
    findingFile?: string | undefined;
}
export declare const PERSIST_MARKER = "<!-- argus-probe-persist ";
/** Reproduced probes carrying serialized content + a safe suggested path. */
export declare function selectPersistable(records: ProbeRecord[] | undefined): PersistableProbe[];
/**
 * Serialize the payload for the sticky comment — the full marker string,
 * or undefined when nothing persistable exists or the payload would bust
 * the cap (the copy-paste tier still renders probes that don't fit).
 */
export declare function encodeProbePayload(records: ProbeRecord[] | undefined, headSha: string | undefined): string | undefined;
export interface DecodedPayload {
    head?: string | undefined;
    probes: PersistableProbe[];
}
/**
 * Parse a sticky comment body back into probes. Strict: exactly one
 * marker, alphabet-checked base64, shaped JSON, and every entry through
 * the same selectPersistable validation — a hand-edited comment fails
 * closed to undefined rather than persisting attacker-controlled paths.
 */
export declare function decodeProbePayload(body: string): DecodedPayload | undefined;
export interface PersistResult {
    /** Opened (or reused) regression-test PR URL. */
    prUrl?: string;
    /** Probe paths committed to the branch. */
    written: string[];
    /** Probe paths skipped because they already exist on the branch. */
    skipped: string[];
    /** Failure message when the lane couldn't complete. */
    error?: string;
}
/**
 * Commit persistable probes to `argus/probe-regression-pr-<pr>` and open a
 * regression-test PR against `baseRef`. Idempotent: an existing branch is
 * reused, an existing file is skipped (never overwritten — contents API
 * exclusive create), and an already-open PR on the branch is returned
 * rather than duplicated.
 */
export declare function persistProbes(repo: string, pr: string, baseRef: string, probes: PersistableProbe[], token: string, ctx: Ctx): Promise<PersistResult>;
export {};
