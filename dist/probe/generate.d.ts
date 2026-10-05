import type { ProviderRules, Sandbox } from '../config.js';
import { type ExecFn } from '../detect.js';
import type { PrMeta } from '../evidence/ci.js';
import type { RepoIndex } from '../index/scan.js';
import type { VisionClient } from '../engine/loop.js';
import type { JsonSchema, Message } from '../vision/openrouter.js';
import type { CallCost } from '../vision/cost.js';
import type { Ledger } from '../vision/ledger.js';
import { type AuthoredProbe } from './author.js';
import { type Harness } from './harness.js';
/**
 * U2 — diff-scoped test generation. Where the probe lane authors one
 * reproducer per `not_exercised` finding, this lane reads the whole PR
 * diff and authors general-purpose spec leafs covering the changed
 * behavior, sandbox-validates them green on head when a real head
 * checkout is present, and deposits the result on a reviewable PR under
 * the tests corpus root.
 *
 * Two trust postures the probe lane already established carry over:
 * - model-authored code is hostile input — filename, content cap, import
 *   scan, secret-env and path checks are identical (parseProbe reuse),
 *   with a stricter leaf-name contract on top;
 * - the PR is the boundary — sandbox green proves "passes in a
 *   container", never safety; the specs execute host-side in consumer CI
 *   after a human merges them.
 */
/**
 * Leaf-name contract for generated specs — stricter than the probe
 * basename RE: lowercase slug, a single `.test.` separator, no dots
 * inside the stem (so `foo.config.test.ts`, `vitest.setup.test.ts` and
 * `a.b.test.tsx` can never slip a config/setup-looking basename past).
 */
export declare const GEN_FILENAME_RE: RegExp;
/** The diff text handed to the authoring call, hard-capped. */
export declare const GENERATE_DIFF_CAP: number;
export declare const GENERATE_SCHEMA: JsonSchema;
export interface GenerateSpecRecord {
    /** Repo-relative write path (`<testsDir>/<filename>`). */
    path: string;
    /** committed → on the write PR; draft → excluded or never deposited; rejected → failed validation gates. */
    status: 'committed' | 'draft' | 'rejected';
    /** green = sandbox run passed on head; failed = sandbox run non-clean; unvalidated = no run possible. */
    validation: 'green' | 'failed' | 'unvalidated';
    detail: string;
    /** Spec source — kept for every record so drafts are reviewable without the PR. */
    content: string;
    reasoning: string;
}
export interface GenerateLaneResult {
    records: GenerateSpecRecord[];
    /** Opened (or reused) write-PR URL when deposition ran. */
    prUrl?: string | undefined;
    /** Present when the lane bowed out before or after authoring. */
    skipReason?: string | undefined;
    /** Model note from the authoring call (e.g. docs-only explanation). */
    note?: string | undefined;
    costUsd: number;
    tokens: number;
}
export interface GenerateLaneOptions {
    /** Repo checkout root (head tree when sandbox validation runs). */
    cwd: string;
    reportDir: string;
    /** Repo-relative tests corpus root the spec leafs land under. */
    testsDir: string;
    /** The PR diff text — caller caps as needed; the lane re-caps. */
    diff: string;
    /** Changed file paths — the docs-only early-out reads these. */
    changedPaths: string[];
    /**
     * Sandbox config or undefined. Undefined = no validation possible (base
     * checkout on the mention lane, sandbox disabled): every spec lands as
     * an unvalidated draft and the PR body says so.
     */
    sandbox: Sandbox | undefined;
    meta: PrMeta | undefined;
    token: string | undefined;
    /** `owner/repo` for the write PR — absent → drafts only. */
    repo: string | undefined;
    pr: string | undefined;
    client: VisionClient;
    model: string;
    provider: ProviderRules | undefined;
    /** Shared codeReviewBudgetUsd ledger — the authoring call records on it. */
    ledger: Ledger;
    /** Generation budget share — authoring skips once spend reaches it. */
    budgetUsd: number | undefined;
    maxSpecs: number;
    index: RepoIndex | undefined;
    calls?: CallCost[] | undefined;
    exec?: ExecFn | undefined;
    log?: ((line: string) => void) | undefined;
}
export declare function isDocsOnlyDiff(changedPaths: string[]): boolean;
export type GenerateParseResult = {
    ok: true;
    specs: AuthoredProbe[];
    rejected: {
        filename: string;
        reason: string;
    }[];
    note: string;
} | {
    ok: false;
    reason: string;
};
/**
 * Parse the array-shaped authoring response. Each item reuses parseProbe's
 * full validation (content cap, secret-env scan, import-specifier scan via
 * the TypeScript parser) and then the stricter generated-leaf contract on
 * the filename. Per-item failures are collected, not fatal — one poisoned
 * spec must not sink the honest ones.
 */
export declare function parseGeneratedSpecs(raw: string, maxSpecs: number): GenerateParseResult;
export declare function buildGenerateMessages(diff: string, exemplarTest: {
    path: string;
    content: string;
} | undefined, harness: Harness, testsDir: string, maxSpecs: number): Message[];
/**
 * Run the generation lane. Never throws into the caller — every failure
 * degrades to a skipReason or per-record detail, and the lane never
 * changes the review verdict, ok, or the exit code.
 */
export declare function runGenerateLane(o: GenerateLaneOptions): Promise<GenerateLaneResult>;
