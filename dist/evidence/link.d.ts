import type { RepoIndex } from '../index/scan.js';
import type { CheckRun } from './ci.js';
/**
 * `reproduced` is emitted only by the B.2 probe stage — a sandboxed test probe
 * demonstrated the defect (KTD4). `linkFindings` never produces it; the probe
 * stage is the only writer and can only move `not_exercised` → `reproduced`.
 */
export type EvidenceStatus = 'exercised' | 'corroborated' | 'not_exercised' | 'inconclusive' | 'reproduced';
export interface Evidence {
    status: EvidenceStatus;
    detail: string;
}
/** Strip comment-hostile characters — check-run names are repo-controlled and reach the PR comment. */
export declare function sanitizeForComment(s: string, max?: number): string;
export declare function isTestFile(path: string): boolean;
/**
 * Every file transitively imported by a test file — a finding on a file in
 * this set was plausibly exercised by the suite. Files outside it can carry
 * no CI evidence regardless of check-run outcomes.
 */
export declare function testReachableFiles(index: RepoIndex): Set<string>;
export interface TestRunSummary {
    /** Test-ish check-runs that completed to a real conclusion. */
    ran: CheckRun[];
    passed: CheckRun[];
    failed: CheckRun[];
}
/** Filter check-runs to test-ish lanes that actually ran, excluding Argus itself. */
export declare function summarizeTestRuns(checkRuns: CheckRun[]): TestRunSummary;
/**
 * Conservative linkage: a finding is `exercised` only when its file is
 * reachable from a test file AND every test check-run that ran passed. A
 * failing test run on a reachable path corroborates the finding. Anything
 * ambiguous is `not_exercised` — never a downgrade.
 */
export declare function linkFindings<T extends {
    file?: string;
}>(findings: T[], index: RepoIndex | undefined, checkRuns: CheckRun[] | undefined): (T & {
    evidence: Evidence;
})[];
