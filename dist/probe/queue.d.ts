import type { ProviderRules, Sandbox } from '../config.js';
import { type ExecFn } from '../detect.js';
import type { PrMeta } from '../evidence/ci.js';
import { type Evidence } from '../evidence/link.js';
import type { RepoIndex } from '../index/scan.js';
import type { VisionClient } from '../engine/loop.js';
import type { Ledger } from '../vision/ledger.js';
import { type ProbeOutcome } from './harness.js';
/**
 * The B.2 probe lane (U4). Called after `linkFindings` inside `code-review`.
 * Selects `not_exercised` blocking-severity findings, authors one probe each,
 * runs it in the sandbox against head AND a merge-base worktree, and upgrades
 * evidence to `reproduced` only on fail-head ∧ clean-base (KTD6). Everything
 * else leaves the finding untouched — additive evidence only, never a new
 * failure surface (KTD8): every error path degrades to a probe record or a
 * debug note, and the queue never changes verdict, ok, or exit code.
 */
export interface LinkedFinding {
    file?: string | undefined;
    line?: number | undefined;
    severity?: string | undefined;
    message?: string | undefined;
    evidence: Evidence;
}
export type ProbeReportOutcome = 'reproduced' | 'clean' | 'load-error' | 'not-collected' | 'error';
export interface ProbeRecord {
    /** Probe filename (basename — it is written beside the exemplar test). */
    file: string;
    findingFile: string | undefined;
    findingLine: number | undefined;
    outcome: ProbeReportOutcome;
    /** Raw harness outcomes per checkout, when the run happened ('error' = infra/timeout). */
    headOutcome?: ProbeOutcome | 'error' | undefined;
    baseOutcome?: ProbeOutcome | 'error' | undefined;
    durationMs: number;
    costUsd: number;
    detail: string;
    /** Capped, control-char-stripped stdout+stderr for audit. */
    output?: string | undefined;
}
export interface ProbeLaneOptions {
    /** PR checkout root (the head tree). */
    cwd: string;
    reportDir: string;
    /** Caller resolves `sandbox.enabled || ARGUS_SANDBOX=1` into this object. */
    sandbox: Sandbox;
    meta: PrMeta | undefined;
    token: string | undefined;
    client: VisionClient;
    model: string;
    provider: ProviderRules | undefined;
    /** Shared codeReviewBudgetUsd ledger — authoring calls record on it. */
    ledger: Ledger;
    /** codeReviewBudgetUsd — authoring stops once spend reaches it. */
    budgetUsd: number | undefined;
    /** Configured blocking severities — the queue only admits those. */
    severityGates: string[];
    index: RepoIndex | undefined;
    exec?: ExecFn | undefined;
    log?: ((line: string) => void) | undefined;
}
/** Pure selection: not_exercised findings at blocking severities, capped. */
export declare function selectProbeTargets(findings: LinkedFinding[], severityGates: string[], maxProbes: number): LinkedFinding[];
/**
 * Nearest existing test file to the finding's file — same directory first,
 * then same top-level segment, then any test file. The exemplar sets the
 * probe's write location so the consumer's own include/roots cover it.
 */
export declare function findExemplarTest(index: RepoIndex | undefined, findingFile: string): string | undefined;
/**
 * Run the probe lane. Mutates `findings` evidence in place for reproduced
 * results and returns the per-probe audit records for code-review.json.
 */
export declare function runProbeLane(findings: LinkedFinding[], o: ProbeLaneOptions): Promise<ProbeRecord[] | undefined>;
