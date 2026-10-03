---
title: Deterministic post-parse filters beat prompt strictness — and verdicts must derive from the filtered set
module: review-pipeline
date: '2026-10-02'
problem_type: architecture_pattern
component: tooling
severity: high
applies_when:
  - "Improving finding quality in an LLM structured-output review pipeline"
  - "Choosing between prompt-side strictness and deterministic post-parse checks"
  - "Placing a new finding filter relative to verdict or decision derivation"
  - "Making keep/revert calls on stochastic judge-scored eval experiments (ce-optimize)"
symptoms:
  - "Baseline kept-finding quality scored 2.86 mean with 0.36 false-positive rate"
  - "Stricter nit-discipline prompt degraded output (mean 2.47, fp_rate 0.61), teaching degenerate nit shapes and a fabricated bug"
  - "Positional filters ran before verdict derivation — dropping the only bug left empty findings and emitted APPROVE (fail-open)"
  - "Identical code scored 3.34 vs 2.74 across eval runs; one corpus item emitted 3 findings vs 57"
root_cause: logic_error
resolution_type: code_fix
related_components:
  - testing_framework
  - development_workflow
tags:
  - llm-evaluation
  - deterministic-filters
  - prompt-engineering
  - verdict-derivation
  - ce-optimize
  - emission-variance
  - fail-open
---

# Deterministic post-parse filters beat prompt strictness — and verdicts must derive from the filtered set

## Context

Argus (`argus code-review`, `src/cli.ts`) is a self-hosted BYOK GitHub PR reviewer. It chunks the PR diff, sends each chunk to an LLM, parses structured findings (`file`/`line`/`severity`/`category`/`message`/`suggestion`), optionally synthesizes across chunks, then derives three gate signals: `verdict` (`pass`/`needs_changes`/`approve`), the `ok` commit-status flag, and `reviewEvent` (`comment`/`request_changes`), which `action/sticky-comment.cjs` maps to a GitHub COMMENT or REQUEST_CHANGES review.

A `ce-optimize` run on branch `optimize/review-finding-quality` (PR duketopceo/Argus#110) targeted review-finding quality. Baseline noise was high: 97 findings on an 8-item eval corpus, judged mean score 2.86/5, fp_rate 0.36 — and 24 of the 97 cited lines the diff never shows, making them unverifiable and unpostable. The optimization loop compared four approaches, scored per-finding by an LLM judge (`evals/review-quality/judge.mjs`) against a corpus of 6 synthetic ground-truth fixtures plus 2 real-PR snapshots (`evals/review-quality/corpus/`, snapshots marked `precisionOnly`):

| run | approach | mean judge score | fp_rate | planted recall | findings | outcome |
|---|---|---|---|---|---|---|
| baseline | — | 2.86 | 0.36 | 0.71 | 97 | — |
| E1 | `filterToDiffLines` (positional filter) | 3.67 | 0.26 | 0.86 | 74 | KEPT |
| E2 | stricter nit-discipline generation prompt | 2.47 | 0.61 | 0.86 | 38 | REVERTED |
| E3 | always-on verify-synthesis LLM pass | 2.76 | 0.58 | 0.86 | 53 | REVERTED |
| E4 | `filterRevertNits` (self-revert filter) | 3.34 / 2.74 (two runs) | 0.23 | 0.86 | 35 | KEPT |

The two prompt-side/model-side approaches regressed; the two deterministic post-parse filters improved every metric. A follow-up `ce-code-review` of the kept diff then found a fail-open bug in how the filters interacted with verdict derivation. Provenance: `.context/compound-engineering/ce-optimize/review-finding-quality/experiment-log.yaml` (gitignored scratch, may not exist for future readers); per-run artifacts under `evals/review-quality/results/{baseline,exp1..exp4b}.json`.

## Guidance

**Filter deterministically after parsing; do not tighten the generation prompt.** Both kept changes are pure functions over parsed findings and the diff text — `src/cli.ts:1581`:

```ts
export function filterToDiffLines(
  findings: readonly ReviewFinding[],
  rangesByFile: Map<string, [number, number][]>,
  blockSeverities: readonly string[] = [],
): { kept: ReviewFinding[]; dropped: ReviewFinding[] } {
  // ...
  const ranges = rangesByFile.get(f.file)
  if (ranges !== undefined && ranges.some(([a, b]) => line >= a && line <= b)) {
    kept.push(f)
  } else {
    dropped.push(f)
  }
```

`diffLineRanges` (`src/cli.ts:1465`) builds new-side (RIGHT) line ranges from `@@ -a,b +c,d @@` hunk headers, anchored to line start so hunk-shaped text inside content lines can't fabricate ranges. `diffLineTexts` (`src/cli.ts:1488`) maps new-side line number → line text, which `filterRevertNits` (`src/cli.ts:1543`) uses to drop nit/q findings whose message asks to remove/revert/replace text literally present on the cited line — findings that would undo wording the PR deliberately added:

```ts
const REVERT_VERB = /\b(?:remove|delete|drop|strip|revert)\s+[`'"]([^`'"]{2,80})[`'"]/i
const REPLACE_VERB =
  /\b(?:replace|rename|reword|swap)\s+[`'"][^`'"]{2,80}[`'"]\s+(?:with|to|by)\s+[`'"]([^`'"]{2,80})[`'"]/i
// drop when: (f.severity === 'nit' || f.severity === 'q') && lineText.includes(remove[1])
```

The filters run after every chunk parse and again after synthesis (`src/cli.ts:2026-2031`, `2075-2081`).

**Exempt verdict-driving findings from positional filters, and derive the verdict from the post-filter set.** `src/cli.ts:1526`:

```ts
function isVerdictDriving(f: ReviewFinding, blockSeverities: readonly string[]): boolean {
  return (
    f.severity === 'bug' ||
    f.severity === 'risk' ||
    f.category === 'security' ||
    blockSeverities.includes(f.severity)
  )
}
```

The first version of `filterToDiffLines` had no exemption: a `bug` finding with a misnumbered cite was dropped, `finalFindings` went empty, verdict became `pass`, `ok:true`, and the review posted as an approval — the filter meant to cut noise silently approved real defects. The fix exempts `isVerdictDriving` findings from both filters and derives `verdict`, `summary`, `ok`, and `reviewEvent` from the post-filter set using one shared `blockSeverities` list (`resolveBlockSeverities`, `src/config.ts:399` — `severityGate: 'risk'` → `['bug','risk']`, `'bug'` → `['bug']`, else the configured `severity` list), so the three signals can never disagree. The model's own verdict is recorded only when it diverges (`modelVerdict` field), never trusted; the synthesis `modelSummary` is discarded when its pass dropped findings, since stale prose could cite removed findings. Every drop is audited in `droppedFindings[]` (`{file, line?, severity, category?, message, reason: 'outside-diff' | 'revert-nit'}`, capped at 50; `src/cli.ts:1114`, `1994-2009`).

**Position filtering belongs at presentation, not adjudication.** The poster already suppresses unpostable inline comments at POST time via `isOnDiff` (`action/sticky-comment.cjs:816`, applied at `:884` and `:999`), which re-validates each comment's path+line against the live PR diff. So a pre-verdict positional drop was purely information-erasing: the comment was never going to post anyway, but the finding was erased from the verdict, adjudication, and the probe lane.

**Treat emission variance as the dominant evaluation confound.** The identical E4 code scored 3.34 and 2.74 across two runs; `pr-107-snapshot` emitted 3 findings in `exp4.json` and 57 in `exp4b.json`. Single-run judge means carry roughly ±0.4, so keep/revert decisions on single-run deltas under ~0.5 are noise. Options: re-measure before deciding, raise `minimum_improvement`, or prefer provably-safe deterministic predicates whose effect is knowable without measurement (E4 was kept on safety grounds despite the ambiguous second run).

Related harness lessons encoded in the eval code:

- The judge needed explicit diff-direction rubric rules — it initially misread `-`/`+` semantics and scored real regression catches 1/5. `JUDGE_RUBRIC.md:8-16` now states that `-` lines are the old code, `+` lines are the PR's new code, and a removed-guard finding is real when the `-` lines show the guard existed.
- Severity-stratified global sampling missed the synthetic precision probes. `judge.mjs:188-203` now judges *every* finding on ground-truth items and samples only `precisionOnly` items (`SAMPLE = { high: 40, low: 20 }`, seeded mulberry32).
- `judgeBatchChecked` (`judge.mjs:123`) retries once and fails the run if the judge omits sampled ids — a missing id silently shrinking denominators corrupts the aggregates.

## Why This Matters

A deterministic predicate's drop condition can be stated in one line, proven safe, and unit-tested — `tests/unit/diff-filters.test.ts` covers the filters with 19 tests (range parsing, boundary lines, hunk-header injection in content lines, every exemption class). A stricter prompt has no enumerable drop condition: E2 didn't just suppress nits, it changed the emission distribution — the model generated degenerate "replace constants with './detect.js'" nit shapes (`exp2.json`, pr-109-snapshot) and fabricated a blocker-severity finding on `fp-traps`, a deliberately-clean fixture, flipping its verdict to `needs_changes` when the expected verdict was pass/approve. Tightening generation trades a measurable failure mode (noise you can count and filter) for an unmeasurable one (correlated generation errors you cannot enumerate).

An LLM verify-pass has the same problem plus cost: E3's always-on verification synthesis kept and amplified noise — ~20 "add a comment explaining why X" nits vs 0 in baseline — while adding a full extra model call per review.

The verdict-ordering bug matters more than the scores: any drop step placed between parse and adjudication is part of the gate. If it can remove a blocking-severity finding, it converts a precision improvement into a fail-open bypass of the exact finding class the review exists to catch. Filters that only affect what gets *posted* can be aggressive; filters that affect what gets *decided* must be conservative and exemption-aware.

## When to Apply

- Tuning LLM reviewer/classifier output where a structured parse exists (findings, annotations, flags) — reach for a post-parse deterministic filter before touching the prompt.
- Any drop/suppress step between parsing and a verdict, gate, or status signal — check whether a dropped item can flip the gate open; exempt gate-driving items and derive the signal from the post-filter set.
- Gate signals computed from the same finding set (verdict/ok/reviewEvent here) — derive all of them from one severity source so they can't disagree (a configured blocking `nit` must not produce `approve` + `ok:false`).
- Eval-driven optimization loops where the generator's per-run emission variance is large — set keep/revert thresholds above the measured run-to-run noise, re-measure borderline results, or prefer changes whose effect is provable without measurement.
- LLM-judged evals — write the diff/artifact reading rules into the rubric explicitly, and judge exhaustively on ground-truth items rather than sampling globally.

## Examples

**Post-filter verdict derivation** (`src/cli.ts:2103-2119`) — the verdict describes the emitted findings against the operator's gate, on every path:

```ts
let verdict: 'pass' | 'needs_changes' | 'approve'
let summary: string
if (finalFindings.length === 0) {
  const dropped = droppedUnanchored + droppedReverted
  summary =
    dropped > 0
      ? `No issues found — ${dropped} model finding(s) dropped as off-diff or self-reverting`
      : 'No issues found'
  verdict = 'pass'
} else if (finalFindings.some((f) => blockSeverities.includes(f.severity))) {
  summary = `${finalFindings.length} finding(s) include a blocking severity`
  verdict = 'needs_changes'
} else {
  summary = `${finalFindings.length} low-severity finding(s)`
  verdict = 'approve'
}
if (modelVerdict === verdict && modelSummary !== undefined) summary = modelSummary
```

`ok` is `!hasBlocker` on the same `finalFindings`/`blockSeverities` (`src/cli.ts:2336,2342`), and `reviewEvent` comes from `computeReviewEvent(linkedFindings, blockSeverities, …)` (`src/cli.ts:1622`) — one severity source, three agreeing signals.

**Emission variance, same code two runs** — `exp4.json` vs `exp4b.json`, both on the E4 diff:

```
exp4 : pr-107-snapshot  3 findings  verdict=needs_changes
exp4b: pr-107-snapshot 57 findings  verdict=approve
exp4 : fp-traps         4 findings  verdict=approve
exp4b: fp-traps         3 findings  verdict=needs_changes
```

**Prompt-strictness backfire** — E2 (`exp2.json`, pr-109-snapshot) emitted degenerate self-replace nits the strict checklist was supposed to prevent, and one fabricated blocker on the clean `fp-traps` fixture:

```
nit  tests/unit/a0-escalation.test.ts:305  L305: 🔵 nit: replace constants with './detect.js'.
nit  src/executor/a0.ts:38                 L38: 🔵 nit: replace 'A0_LIVE_LABEL' with './executor/a0.js'.
risk src/users.ts:14 (fp-traps)            L14: 🔴 bug: `userEmail` function throws an error if user or
                                            email is not found. …   → verdict=needs_changes (wrong)
```

**Presentation-layer positional check** (`action/sticky-comment.cjs:816`) — the check that already made pre-verdict drops redundant:

```js
function isOnDiff(c, diffLines) {
  const valid = diffLines.get(c.path)
  return (
    valid !== undefined &&
    valid.has(c.line) &&
    (c.start_line === undefined || valid.has(c.start_line))
  )
}
```

Landed on PR #110 as commits `83ba13d` (E1 line-anchor filter), `95a9bf4` (E4 revert-guard), `bbd5352` (verdict-driving exemption + post-filter derivation + `droppedFindings` audit), `550acfc` (review-feedback fixes); E2/E3 preserved as reverted artifact commits `c8ceffe`/`44ae880`.

## Related

- [PR #110 — feat(review): diff-anchored finding filters + review-quality eval harness](https://github.com/duketopceo/Argus/pull/110) — the implementation this doc distills.
- [Issue #62 — Adopt OpenCodeReview patterns](https://github.com/duketopceo/Argus/issues/62) — external validation of the same thesis (deterministic pre-pass lane); this doc is the internal evidence.
- `docs/plans/2026-09-27-001-feat-coderabbit-review-surface-plan.md` — KTD2 "gate is pure, serialized, honest about proof"; the post-filter derivation rule here is the ordering guarantee that plan assumes.
- `docs/plans/2026-09-16-001-feat-full-reviewer-roadmap-plan.md` — earlier precedent: secrets detection "too important to leave to the model," enforced deterministically and merged with model findings.
- `docs/approval-token.md` — downstream consumer of the verdict; a fail-open `pass` propagates to a wrong APPROVE event here.
- `evals/review-quality/JUDGE_RUBRIC.md` — the judge contract that produced the evidence (diff-direction rules live at lines 8-16).
- `.context/compound-engineering/ce-optimize/review-finding-quality/` — experiment log, spec, strategy digest (gitignored, local provenance only).
