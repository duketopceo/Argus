#!/usr/bin/env node
import { Config } from './config.js';
import { type ExecFn } from './detect.js';
import { BrowserDriver } from './driver/browser.js';
import { VisionClient } from './engine/loop.js';
import { type PrMeta } from './evidence/ci.js';
import { type Evidence } from './evidence/link.js';
import { type SecretsScanResult } from './review/secrets.js';
import { type TriageRecord } from './review/triage.js';
import { type FindingAdjudicationResult } from './review/adjudicate.js';
import { type ProbeRecord } from './probe/queue.js';
import { CallCost } from './vision/cost.js';
export interface CliDeps {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    out?: (line: string) => void;
    err?: (line: string) => void;
    /** Inject a vision client (tests stub this; default builds OpenRouterClient). */
    createClient?: (config: Config) => VisionClient;
    /** Inject a driver factory (tests may stub browser launch). */
    launchDriver?: (config: Config) => Promise<BrowserDriver>;
    /** Inject a subprocess runner (tests stub `a0`/`gh` detection + delegation). */
    exec?: ExecFn;
}
export declare function main(argv: string[], deps?: CliDeps): Promise<number>;
interface PrFile {
    filename: string;
    previous_filename?: string;
    patch?: string;
}
interface CodeReviewReport {
    ok: boolean;
    skipped: boolean;
    summary: string;
    verdict: 'pass' | 'needs_changes' | 'approve';
    findings: {
        file: string;
        line?: number;
        severity: string;
        category?: string;
        message: string;
        /** U8 — Jev true-positive probability (absent = unadjudicated). */
        p?: number;
        evidence?: Evidence;
    }[];
    /** Inline-comment cap consumed by the sticky poster (Tencent max_comments pull). */
    maxComments?: number;
    /** B.2 probe audit records — present only when the sandbox lane ran. */
    probes?: ProbeRecord[];
    /** Why an enabled lane bowed out (fork gate, no docker, no harness…). */
    probeLaneSkipped?: string;
    /** Secrets-lane audit — masked candidates, adjudication verdicts, skip reason. */
    secretsScan?: SecretsScanResult | {
        skipped: string;
    };
    /** U7 triage record — Jev pre-review signals (annotate/route, never gates). */
    triage?: TriageRecord;
    /** U8 adjudication audit — per-finding p + suppressed records. */
    findingAdjudication?: Omit<FindingAdjudicationResult<never>, 'findings'>;
    calls: CallCost[];
    visionCostUsd: number;
    tokens: number;
    model: string;
    budgetExceeded: boolean;
}
/**
 * Split `git diff` text into per-file PrFile entries — the local-diff
 * equivalent of the PR-files API response (which also reports `patch`
 * per file). `+++ b/` names new/copied files; `--- a/` covers deletions.
 */
export declare function filesFromUnifiedDiff(diff: string): PrFile[];
/**
 * `--fixture <dir>` seam: the dir is a real git repo with an
 * `argus-fixture-base` ref (the merge base) and HEAD at the PR head —
 * scripts/demo.mjs materializes it. Returns the same diff/files/meta
 * the GitHub paths would produce, so every downstream lane (chunking,
 * secrets scan, evidence linkage) runs its real code path.
 */
export declare function loadFixture(dir: string, exec?: ExecFn): Promise<{
    files: PrFile[];
    meta: PrMeta;
    diff: string;
} | {
    skipped: string;
}>;
export declare function buildPatchChunks(files: PrFile[], contexts?: Record<string, string>): string[];
export declare function parseCodeReview(content: string): {
    summary: string;
    verdict: 'pass' | 'needs_changes' | 'approve';
    findings: CodeReviewReport['findings'];
};
export {};
