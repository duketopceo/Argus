---
title: "chore: Optimization + LOC audit — measure first, cut where it pays"
type: chore
date: 2026-10-06
origin: user-request 2026-10-06 ("prep ce plan a optimization and loc audit if we can optimize")
---

# chore: Optimization + LOC audit — measure first, cut where it pays

## Summary

Audit-driven optimization pass over Argus's ~21.4k-line `src/` (plus 23.2k
tests, 2.8k action JS, 4k scripts, 20.6k committed `dist/`). The pass
measures before it cuts: one audit unit produces the evidence, and each
optimization unit is gated on what the audit actually finds — "if we can
optimize" means no speculative refactors ship.

Baseline numbers (measured 2026-10-06, `main @ 1e499dd`):

| Area | LOC | Notes |
| --- | --- | --- |
| `src/` | 21,367 | 71 files |
| `src/cli.ts` | 4,931 | 23% of src; 11 `cmd*` functions; `cmdCodeReview` ~1,150 lines inline |
| `src/report/html.ts` | 1,069 | second-largest file |
| `src/config.ts` | 973 | |
| `src/engine/loop.ts` | 937 | |
| `tests/` | 23,217 | 1.09:1 test:src — the safety net that makes this pass safe |
| `action/` | 2,773 | includes `sticky-comment.cjs` parity copy |
| `dist/` | 20,584 | committed by design (git-install consumers); diff noise, not deletable |
| runtime deps | 2 | playwright + typescript only — dep surface already lean |

## Problem Frame

Growth pressure is structural, not sloppy: every lane command, the review
pipeline, and the report assembly all funnel through `src/cli.ts`, which is
now a 4.9k-line god-file where a unit of work means touching a region of a
shared file (the U7 scan-mode and U8 ruleset diffs both had to find their
place inside it). `cmdCodeReview` carries the whole
materialize→chunk→lanes→union→report pipeline inline, and `cmdScan`
re-wires a subset of the same pipeline — duplication that the audit should
quantify, not just assert.

What "optimize" means here, in priority order:

1. **Structural**: split god-files, deduplicate orchestration, remove dead
   code — the reviewability and merge-conflict win.
2. **Generated/parity weight**: `dist/` and `action/*.cjs` parity copies —
   check whether generation is fully automated or hand-synced drift risk.
3. **Runtime perf**: only where measurement shows a stall worth a fix —
   test-suite wall time, `index`/`scan`/`code-review` on large inputs.

Explicitly out: behavior changes, new features, dependency swaps, style
churn, `docs/` trimming, and the committed `dist/` itself.

## Requirements

- **R1.** Every optimization unit is gated on an audit finding with a
  measured number (file size, duplication count, dead export count, wall
  time). No finding → no unit.
- **R2.** Zero behavior change: the full suite (1409 tests) green before
  and after each unit; `npm run typecheck`, `npm run lint`,
  `npm run check:dist` clean at every commit boundary.
- **R3.** Each unit independently revertible — one commit per unit, no
  cross-unit entanglement (Karpathy surgical-changes rule).
- **R4.** `dist/` rebuild stays part of every `src/` unit's definition of
  done (committed artifact; `check:dist` enforces cleanliness).
- **R5.** No new runtime dependencies. A devDependency for the audit
  itself (e.g. knip/jscpd) is allowed only if it earns its place —
  removable after the audit or wired into CI as a ratchet.

## Key Technical Decisions

- **Audit-first ordering.** U1 (the audit) is a standalone unit producing
  `docs/solutions/` or a plan addendum with the measurement table; the U2–U6
  units below are seeded but not committed to until audited.
- **cli.ts splits by command, not by layer.** Target shape:
  `src/cli/{run,code-review,verify,scan,index,record,cache,mention,delegate,init}.ts`
  with `src/cli.ts` reduced to arg parsing, deps wiring, and dispatch.
  Matches how `src/review/` already decomposes by concern; keeps the
  `CliDeps` injection seam every command already receives.
- **`cmdCodeReview` extraction is the same unit as cli.ts splitting.**
  The pipeline stages (context → diff → chunks → lanes → union → report)
  move to `src/review/pipeline.ts`-shaped functions; `cmdScan` consumes
  the shared stages — this is where the measured dedup pays.
- **Perf work is conditional.** Only included if the audit measures a
  stall above a decided threshold (proposal: test suite > 5 min, or a
  single hot path > 2 s on a 500-file repo).

## Implementation Units

### U1. Measure the codebase (gate for everything below)

**Goal:** produce the evidence table that decides which O-units run.

**Files:** no source changes. Tooling is transient or a single devDep.

**Scope:**

- LOC map: per-file and per-directory counts; top-20 files; growth since
  a reference tag (v0.4.x or first tag) via `git log --numstat` if cheap.
- Dead/unused: `knip` (or `ts-prune` fallback) — unused exports, files,
  deps. Report-only; every removal still hand-verified (knip false-positives
  on dynamic imports and CLI entrypoints are expected).
- Duplication: jscpd or equivalent over `src/` — quantify the
  `cmdCodeReview`/`cmdScan` overlap and the `comment.ts`/`sticky-comment.cjs`
  parity relationship specifically.
- Parity automation check: how `action/sticky-comment.cjs` and `dist/` are
  produced today — generated by script, or hand-synced? (determines U4)
- Perf profile: `time` on `npm test`, `argus index .`, `argus scan .`,
  and `code-review --base` on the repo itself; node `--cpu-prof` only if a
  number looks wrong.

**Deliverable:** audit table + findings list appended to this plan (or a
linked `docs/` note) and a go/no-go per unit U2–U6.

**Verification:** the audit runs start-to-finish with zero source changes;
numbers reproducible from the commands it records.

### U2. `cli.ts` split — command modules under `src/cli/`

**Gate:** U1 confirms per-command line counts > ~150 and mechanical
split boundaries (it will — the counts are above).

**Files:**
- `src/cli.ts` → shrinks to usage text, parse, `CliDeps` assembly, dispatch
- `src/cli/*.ts` — one module per `cmd*`, exported `cmdX(args, ctx, deps)`
- `tests/unit/cli-dispatch.test.ts` (new) — dispatch table reaches each
  module; usage text contract
- `dist/` rebuild

**Approach:** pure move — cut each `cmd*` function plus its file-local
helpers into its own module; shared helpers (`loadIndex`, exclusion
parsing, `CliDeps`, `Ctx`) stay in `cli.ts` or a `src/cli/shared.ts`.
No logic edits inside moved functions — this unit is relocation only; any
"d while I'm here" cleanup is a separate commit or rejected.

**Test scenarios:**
- Happy: every existing CLI test passes untouched — the suite is the
  contract (1409 green)
- Edge: `--help`/usage and unknown-command paths produce identical output
- Error: a command module that fails to import surfaces the same error as
  today (top-level throw)

**Verification:** `wc -l src/cli.ts` drops to roughly dispatch+parse
(estimate < 800); `check:dist` clean; suite green.

### U3. Review-pipeline extraction — `cmdCodeReview`/`cmdScan` share stages

**Gate:** U1 quantifies the overlap (expected: materialize → eligible
→ chunks → lanes → union → dropped-counting → report fields duplicated
across both commands).

**Files:**
- `src/review/pipeline.ts` (new) — the shared stage functions
- `src/cli/code-review.ts`, `src/cli/scan.ts` — thin orchestration calling
  the stages
- `tests/unit/review-pipeline.test.ts` (new) — stage contracts in isolation

**Approach:** extract in dependency order — eligibility/exclusion first,
then chunk planning, then lane execution + union, then report assembly.
`cmdScan` keeps its report shape (`scan-report.json`) — the shared surface
is the middle stages, not the report writers.

**Test scenarios:**
- Happy: `code-review --base` and `scan --base` produce byte-identical
  findings sections to pre-extraction on a fixture diff
- Edge: `--model` absent keeps $0 spend in both commands
- Error: rules-lane throw still degrades to skipped-record in both

**Verification:** net LOC delta negative or neutral; the audit's measured
duplication between the two commands drops to ~0.

### U4. Parity-copy + dist hygiene (conditional on audit)

**Gate:** audit finds hand-synced parity code or non-reproducible `dist/`.

**Files (if gated on):**
- `scripts/` — a parity generation/check script if one doesn't already exist
- `package.json` scripts — wire into `check:dist` or a new `check:parity`

**Verification:** `check:parity` (or existing equivalent) fails when the
copies drift from source; CI-green on a forced-drift test branch is the
proof.

### U5. Dead code + unused export removal

**Gate:** knip/ts-prune findings verified by hand.

**Files:** per-finding, expected small and scattered.

**Verification:** suite green after each removal batch; removal commits
grouped by module, not per line.

### U6. Runtime perf (conditional — only if audit shows a stall)

**Gate:** measured wall-time or profile finding above the perf threshold in Key Technical Decisions.

**Scope:** whatever the profile indicts — candidates are index walking
(`scanRepo` re-stats), diff parsing on large fixtures, or chunk planning.
No speculative micro-optimization.

## Dependencies and Sequencing

```
U1 audit ─┬─> U2 cli split ──> U3 pipeline extraction (needs U2's layout)
          ├─> U4 parity hygiene (independent)
          ├─> U5 dead code (independent; run after U2 to avoid re-auditing
          │                 removed-then-moved code)
          └─> U6 perf (independent; last — measurement noise is lowest on
                        the post-split layout)
```

U2 before U3 because extracting pipeline stages *inside* a 4.9k-line file
just relocates the mess. U5 after U2 because dead-export detection on the
god-file pre-split produces findings the split then moves.

## Risks

- **Split-induced import cycles**: `cmd*` modules share helpers — mitigated
  by keeping shared code in `cli.ts`/`cli/shared.ts` and commands leaf-ward.
- **Golden/parity drift**: moving report-adjacent code could desync
  `sticky-comment.cjs` goldens — the golden tests catch this; do not
  hand-edit parity copies.
- **Audit tool false positives**: knip flags CLI entrypoints and dynamic
  requires — U5 removals are hand-verified per finding, never batch-trusted.
- **Scope creep into behavior**: any line that changes output is out of
  scope and gets its own plan/unit.

## Verification (whole-plan gate)

- `npm test` — 1409+ green, zero skips added
- `npm run typecheck`, `npm run lint`, `npm run check:dist` clean
- Net effect reported honestly: final `wc -l` table vs the baseline above,
  plus the audit table, in the PR body
