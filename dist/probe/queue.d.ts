import { type ProviderRules, type Sandbox } from '../config.js';
import { type ExecFn } from '../detect.js';
import type { PrMeta } from '../evidence/ci.js';
import { type Evidence } from '../evidence/link.js';
import type { RepoIndex } from '../index/scan.js';
import type { VisionClient } from '../engine/loop.js';
import type { CallCost } from '../vision/cost.js';
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
 *
 * Trust note: for `pull_request` events the config file ships in the PR's
 * own tree, so for FORK PRs the lane ignores config-supplied
 * image/limits/allowForks and runs on `DEFAULT_SANDBOX` — forks approve via
 * the argus-probe label or a trusted author association, never via config.
 */
/** Finding shape shared by the review report, probe targets, and this lane. */
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
    tokens: number;
    detail: string;
    /** Capped, control-char-stripped stdout+stderr for audit. */
    output?: string | undefined;
}
export interface ProbeLaneResult {
    records: ProbeRecord[];
    /** Present when the lane was enabled but skipped before running probes. */
    skipReason?: string | undefined;
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
    /** U9 — triage top_risk_area; advisory reorder of probe candidates. */
    triageArea?: {
        area: string;
        confidence: number;
    } | undefined;
    /** Report sink — authored probe CallCosts are pushed here for the report. */
    calls?: CallCost[] | undefined;
    exec?: ExecFn | undefined;
    log?: ((line: string) => void) | undefined;
}
/** U9 — below this confidence the triage area signal is ignored. */
export declare const MIN_AREA_CONFIDENCE = 0.5;
/** Pure selection: not_exercised findings at blocking severities, capped. */
export declare function selectProbeTargets(findings: LinkedFinding[], severityGates: string[], maxProbes: number, triageArea?: {
    area: string;
    confidence: number;
}): LinkedFinding[];
/**
 * Repo-relative path gate for anything model- or index-derived that is read
 * or written on the HOST: no absolute paths, no `..` escapes, no backslashes.
 * The write side is already basename-bound (PROBE_FILENAME_RE); this is the
 * read-side and exemplar-dir boundary — a prompt-injected `../../.env`
 * finding.file or a crafted index entry must never reach fs calls.
 */
export declare function isSafeRepoPath(p: string): boolean;
/**
 * Nearest existing test file to the finding's file — same directory first,
 * then same top-level segment, then any test file. The exemplar sets the
 * probe's write location so the consumer's own include/roots cover it.
 * Index paths are filtered through isSafeRepoPath — a committed/crafted
 * index could otherwise aim the host write outside the checkout.
 */
export declare function findExemplarTest(index: RepoIndex | undefined, findingFile: string): string | undefined;
/**
 * Run the probe lane. Mutates `findings` evidence in place for reproduced
 * results and returns the per-probe audit records for code-review.json.
 * Returns undefined only when the lane is disabled entirely; otherwise a
 * result carrying records and (when it bowed out early) a skipReason the
 * report surface can render.
 */
export declare function runProbeLane(findings: LinkedFinding[], o: ProbeLaneOptions): Promise<ProbeLaneResult | undefined>;
