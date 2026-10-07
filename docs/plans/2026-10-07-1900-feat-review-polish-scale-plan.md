---
title: "feat: Review polish + at-scale precision — learned from CodeRabbit and Alibaba OCR, measured on AACR-Bench"
type: feat
date: 2026-10-07
origin: user-request 2026-10-07 ("ce plan — polish like coderabbit, learning at scale like alibaba, not copied but inspired; what do our own reviews look like; what repos to dogfood")
---

# feat: Review polish + at-scale precision

## Summary

Two competitor research passes converted into a measured improvement loop.
**CodeRabbit** contributes review-surface polish (default-ignore paths,
review profiles, learn-from-review config loop). **Alibaba
open-code-review** contributes at-scale precision machinery (AACR-Bench —
a 200-PR/1,505-annotated-issue benchmark, positioning + reflection modules,
deterministic file bundling, precision-over-recall posture). Argus adopts
neither verbatim: every candidate lands behind an eval gate measured on our
own comment corpus and the benchmark.

Measured baseline on Argus's own dogfood reviews (gh api, 2026-10-07):

| PR | inline comments | nit-level | on `dist/` output | verdict |
| --- | --- | --- | --- | --- |
| #173 (U7 scan) | 14 argus | 11 | 4 | review noise is real |
| #171 (U8 rules) | 4 | 3 | 0 | |
| #166, #165, #163 | 0 | — | — | zero-finding or silent |

Pattern: on a large PR Argus emits ~14 inline comments, ~80% nit-level
"convention" observations ("imports not grouped by type", "extract helper"),
and **4 comments landed on `dist/` build output** — generated code that
should never be reviewed. Three recent PRs posted nothing at all (worth
verifying whether that is a true zero-finding or a silent miss).

## Problem Frame

The review lane works but its output is noisy and uncalibrated:

1. **Noise**: ~80% of comments are nits; Argus reviews `dist/` because
   there is no default-ignore list (CodeRabbit ships ~40 default patterns:
   `!**/dist/**`, lockfiles, generated dirs — we have none).
2. **No calibration**: we cannot say what our precision is. OCR publishes
   F1 on AACR-Bench; Argus has no eval. Every polish change is currently
   unfalsifiable — "keep bringing them in and testing them" requires a
   harness first.
3. **No feedback loop**: CodeRabbit's `emit path instructions` mines its
   own reviews into config; Argus posts and forgets. Dismissed comments
   teach nothing.

## Competitive Findings (evidence, not gospel)

**CodeRabbit** (docs, 2026): default ignored-paths table; `path_instructions`
per-glob (we shipped this as `review.instructions[]` in U6 — parity);
`@coderabbitai emit path instructions` — mines recent reviews into
suggested config entries (the learning loop we lack); review profiles
(CHILL/ASSERTIVE = severity floors); walkthrough + changes-table sticky;
usage-based overage pricing proves comment volume is a cost axis.

**Alibaba open-code-review** (README + repo, 44.1k stars): deterministic
× agent hybrid — file selection and rule matching are engineering, not
prompt luck; **smart file bundling** (related files — e.g. i18n pairs —
reviewed as one unit); **external positioning module** (line-number
accuracy is verified outside the model) and **reflection module** (content
accuracy pass); scenario-tuned toolset distilled from production tool-call
traces; deliberate precision > recall tradeoff, ~1/9 tokens vs general
agents; `ocr scan` whole-file audit (parity with our U7); delegation mode
= runs inside Claude Code/Codex/Cursor (validates our U11 plugin shape).
**AACR-Bench on HuggingFace**: 50 OSS repos, 200 real PRs, 10 languages,
1,505 human-annotated issues — a calibration corpus we can score against.

**Landscape** (names for the intake sweep): Qodo PR-Agent (open-source,
command grammar `/review /improve /describe`), Greptile (repo-graph
context), cubic.dev, Cursor Bugbot, Copilot review, Graphite Diamond,
Sourcery, Ellipsis.

## Requirements

- **R1.** Measure first: U1 produces our own comment-corpus stats; U2
  stands up the eval harness before any quality change lands. No polish
  ships without a before/after number.
- **R2.** Precision over recall is the stated posture (matches OCR's
  published finding): a dropped nit is acceptable, a false-positive
  "bug" is not. `drop` reasons must stay honest — a suppressed finding is
  counted, not hidden.
- **R3.** Inspired, not copied: adopt mechanisms (ignore-list, bundling,
  positioning check, reflection pass, feedback loop), not their code or
  comment format. Argus's evidence/verdict/spend-ledger identity stays.
- **R4.** Behavior changes only inside the review pipeline output shape;
  lane contracts, run-manifest schema, and trust model untouched unless a
  unit explicitly owns a change.
- **R5.** Every dogfood repo addition is opt-in per repo with the existing
  self-hosted workflow shape; no new infrastructure.

## Implementation Units

### U1 — Own-review corpus audit (evidence, no code)

Harvest every argus-reviewer comment across all Argus PRs via gh api;
classify by category/severity/path-type; produce the distribution table:
% nit vs substantive, % on generated/lock/dist paths, comments-per-PR vs
diff size, zero-comment rate (and whether those were true zero-findings or
stalls — check workflow run logs). Deliverable:
`docs/audits/2026-10-07-review-corpus-audit.md`. Gates U3/U4 content and
sets the condense targets for U2.

Test scenarios: audit doc contains the measured table; the 20-comment
claim is confirmed or corrected with data.

### U2 — Eval harness (foundation, before polish)

`scripts/review-eval.mjs` — offline review runner over a corpus:
(a) our own historical PRs replayed via `code-review --base <ref>`
(existing surface — no new execution path), comments captured and diffed
run-over-run; (b) AACR-Bench subset — check the HF dataset license first;
if unusable, hand-build a ~20-PR labeled corpus from our dogfood repos
(mark which posted comments were acted-on vs ignored = precision signal).
Metrics: precision, comments/PR, nit share, comments on ignored paths.
Output: JSON + table, checked into `docs/audits/` per run.

Test scenarios: `tests/unit/` coverage for the metrics math; a fixture
run over 2 sample PRs produces a stable metrics table.

### U3 — Review hygiene: ignore paths + condense

Default review path-filters (dist/lock/generated/minified — CodeRabbit's
published list as reference, adapted to our `review.instructions[]`
config shape rather than a separate key); severity floor config
(`review.minSeverity`); **nit consolidation**: nit-level findings collapse
into one grouped section of the sticky comment instead of N inline
comments; hard cap per PR with a dropped-count that reports itself
(honesty invariant). Expected measured outcome: inline count on a #173-
class PR drops from 14 to ≤5 actionable + 1 consolidated nit group.

Test scenarios: unit tests for the consolidation/cap logic incl.
dropped-count reporting; golden update for the comment shape; eval corpus
before/after table.

### U4 — Precision machinery (OCR-inspired)

(a) **Positioning check** — every finding's file+line verified against the
actual diff hunks pre-post (extends `diffLineRanges`); unlocatable
findings get downgraded or dropped, counted. (b) **Reflection pass** —
one cheap model call that re-reads each surviving finding against its
hunk and drops ungrounded ones (this is where ~1/9-token cost discipline
matters: reflection is one batched call, not per-finding). (c) **File
bundling** — group related files into one chunk (source + its test +
paired generated files) so findings see their context; keep it
deterministic — adjacency rules, not model choice.

Test scenarios: unit tests for bundling rules and positioning validator;
eval corpus precision delta (U2 harness is the gate — adopt each piece
only if it moves the number).

### U5 — Coverage expansion: what else we should review

Beyond diff correctness, gated on U1's gap analysis. Candidates ranked by
expected value: missing-test signal for changed public API; dependency
diffs (new dep, license, version jump) — secrets lane already covers part;
commit-message/PR-description adequacy vs the diff; docs-drift for changed
public surface. Each candidate ships as a named ruleset or lane finding
type with an eval-corpus measurement; nothing ships that adds comment
volume without precision.

### U6 — Dogfood expansion (data at scale)

Add the argus-reviewer workflow to luke's own active public repos —
`orchestral`, `wisp`, `kurultai`, `OmaSeal`, `dayflow-linux`,
`jev-compact` — via the existing self-hosted action shape (one workflow
file + config each). The goal is corpus growth, not coverage vanity:
each repo gets a `docs/argus-feedback.md` where acted-on vs dismissed
comments are tallied weekly → feeds the U2 eval corpus. Historical replay
via `code-review --base` seeds data before PRs accumulate.

### U7 — Competitive intake loop

`docs/competitive-review.md` — living delta table across CodeRabbit /
OCR / PR-Agent / Greptile / cubic / Copilot-review: feature, their
mechanism, our equivalent, adopt/skip + why. A recurring sweep (monthly,
or on release notes) evaluates each delta against the U2 harness and
either proposes a unit or records "skip, here's why". This is the
"keep bringing them in and testing them" mechanism — intake is a
documented loop, not ad hoc.

## Risks

- **R-K1** AACR-Bench license/terms unverified → fallback is the
  hand-built corpus in U2(b); do not block the harness on it.
- **R-K2** Eval harness could become a vanity metric — guard: only
  precision + dropped-finding honesty count; comments/PR is a diagnostic,
  not a goal.
- **R-K3** U3 condensation must not hide findings — the dropped-count and
  grouped-nit section keep suppression legible (existing `dropped` field
  precedent).
- **R-K4** Dogfood-on-other-repos uses real CI minutes on the self-hosted
  runner — cap repos at the six named; expand only with data.

## Verification

Per unit: `npm run typecheck && npm run lint && npm run build &&
npm run check:dist && npm run check:parity && npm test`. U2's harness is
itself the verification for U3–U5: every quality change ships with a
before/after corpus table in `docs/audits/`.

## Prior Art / References

- `docs/audits/2026-10-06-loc-optimization-audit.md` — audit-gated unit
  pattern this plan reuses
- `src/cli/review-shared.ts` — diffLineRanges, dropped-count plumbing
  (U4a builds on it)
- `src/review/validate.ts` — existing finding-validation lane
- `src/review/rules.ts` — U8 ruleset registry (U5 additions land here)
- `review.instructions[]` config — U6 parity surface for U3 path filters
- alibaba/open-code-review README — hybrid architecture, AACR-Bench
- docs.coderabbit.ai — path filters/instructions, emit-path-instructions
  loop, review profiles
