import type { JsonSchema, Message } from '../vision/openrouter.js';
import type { Harness } from './harness.js';
/**
 * Probe authoring (KTD7): one bounded model call per `not_exercised`
 * finding produces a single test file asserting the *correct* behavior —
 * so the defect's presence fails the test on head while the base checkout
 * passes. The file is written on the HOST (inside the ro workspace mount),
 * so `filename` and `content` are validated hard: the model's input includes
 * PR-controlled file contents, and a prompt-injected traversal or secret
 * read would escape the sandbox's whole purpose.
 */
export declare const PROBE_SCHEMA: JsonSchema;
export interface ProbeTarget {
    file?: string | undefined;
    line?: number | undefined;
    severity: string;
    message: string;
}
export interface AuthoredProbe {
    filename: string;
    content: string;
    reasoning: string;
    /** Import specifiers extracted at parse time — checked against the write path in the queue. */
    imports: string[];
}
export type ProbeParseResult = {
    ok: true;
    probe: AuthoredProbe;
} | {
    ok: false;
    reason: string;
};
/**
 * Basename-only, forced test extension — no separators, no `..`. The write
 * happens on the host, so this is the traversal boundary.
 */
export declare const PROBE_FILENAME_RE: RegExp;
/** Probe files are bounded — a runaway generation is rejected, not truncated. */
export declare const PROBE_CONTENT_CAP: number;
export declare function parseProbe(raw: string): ProbeParseResult;
/**
 * Verify every relative import in a probe resolves inside the repo, given
 * the probe's repo-relative write path. `../../etc/passwd` from a shallow
 * dir escapes the checkout — reject.
 */
export declare function probeImportsSafe(probe: AuthoredProbe, relProbePath: string): boolean;
export declare function buildProbeMessages(target: ProbeTarget, fileContents: string | undefined, exemplarTest: {
    path: string;
    content: string;
} | undefined, harness: Harness): Message[];
