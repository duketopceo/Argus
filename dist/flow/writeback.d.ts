import { FingerprintRecord } from '../cache/fingerprint.js';
import { CachedAssert } from '../cache/store.js';
import { CreateFilesPrResult } from '../github/write-pr.js';
interface Ctx {
    out: (line: string) => void;
    err: (line: string) => void;
}
/**
 * Heal write-back (roadmap U1): when a fingerprint miss heals via the model,
 * the session's healed fingerprint set is proposed back to the repo as a
 * committed recording (`<testsDir>/flows/<flow>.json`) — as a reviewable PR
 * in CI, or a working-tree write locally. Never silent, never the raw model
 * output: only relocation fields may differ from the record the run loaded.
 *
 * A heal re-resolves the element and can legitimately move it — but the
 * ActionPayload it returns is attacker-influenceable in lanes driving a
 * PR-built target. Write-back therefore admits relocation fields only;
 * a heal that changed the action kind, typed text, keys, or timing is
 * reported `suppressed` and the pre-heal record is what lands in the file.
 */
/** Per-step healed record pair — `before` is what the session loaded. */
export interface HealedStep {
    index: number;
    before: FingerprintRecord;
    after: FingerprintRecord;
}
/** One flow's healed state collected from a finished session. */
export interface FlowWriteback {
    flowName: string;
    /** The session's final fingerprint set (all steps, healed or not). */
    steps: FingerprintRecord[];
    /** Assertion cache entries to persist alongside steps. */
    asserts: CachedAssert[];
    heals: HealedStep[];
}
/** Flow names map to `<dir>/<name>.json` — refuse anything path-shaped. */
export declare function isSafeFlowName(name: string): boolean;
export interface WritebackPlan {
    /** The sanitized steps to write — healed relocations applied, suppressed heals reverted to `before`. */
    steps: FingerprintRecord[];
    applied: HealedStep[];
    suppressed: {
        heal: HealedStep;
        reason: string;
    }[];
}
/**
 * Relocation-only gate per healed step. `action` and `instruction` are the
 * payload: `action.x/y` may move (that IS the relocation), but a changed
 * kind/text/keys/dx/dy/ms — or a rewritten instruction — means the model
 * tried to rewrite the step, not relocate it. `stale` never round-trips.
 */
export declare function planWriteback(flow: FlowWriteback): WritebackPlan;
/** Repo-relative path for a flow's committed recording — refused fail-closed. */
export declare function flowRelPath(flowsDir: string, flowName: string): string | undefined;
/** PR body — legible step cards, not a raw record diff. */
export declare function renderWritebackBody(flows: {
    flow: FlowWriteback;
    plan: WritebackPlan;
}[], headSha: string | undefined): string;
export interface WritebackGithubOpts {
    /** `owner/repo`. */
    repo: string;
    /** PR number the run is reviewing, when known (provenance only). */
    pr?: string | undefined;
    baseRef: string;
    headSha: string | undefined;
    token: string;
}
export interface WritebackOutcome {
    /** Per-flow sanitized plans that were written (or would have been). */
    plans: Map<string, WritebackPlan>;
    result?: CreateFilesPrResult;
    /** Why nothing was written — honest-skip surface. */
    skipped?: string;
}
/**
 * Collect sanitized write-back files from healed flows. Returns undefined
 * when nothing survives sanitization or a flow name is unsafe — the caller
 * reports the skip, the lane never fails.
 */
export declare function buildWritebackFiles(flows: FlowWriteback[], flowsDir: string): {
    files: {
        path: string;
        content: string;
    }[];
    plans: Map<string, WritebackPlan>;
    unsafe: string[];
};
/**
 * CI path: commit sanitized recordings to `argus/flow-heals-<sha7>` and open
 * one PR against the base ref.
 */
export declare function writebackHealsToPr(flows: FlowWriteback[], flowsDir: string, gh: WritebackGithubOpts, ctx: Ctx): Promise<WritebackOutcome>;
/**
 * Local path: write sanitized recordings to the working tree — `git diff` is
 * the review surface, same contract as the PR.
 */
export declare function writebackHealsLocal(flows: FlowWriteback[], flowsDirAbs: string, ctx: Ctx): Promise<WritebackOutcome>;
export {};
