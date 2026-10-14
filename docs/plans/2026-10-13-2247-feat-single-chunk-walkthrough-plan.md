---
title: "feat: Surface the single-chunk review summary as the sticky walkthrough"
date: 2026-10-13
type: feat
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# feat: Surface the single-chunk review summary as the sticky walkthrough

## Goal Capsule

- **Objective:** every completed review's sticky carries one plain-language sentence describing what the PR does — including single-chunk reviews, which today emit no model prose at all.
- **Means:** adopt the chunk call's already-returned `summary` under hardened guards (KTD1) into a new `walkthrough` report field that renders as a dedicated head line — no new model call, no new config.
- **Authority:** `docs/plans/2026-10-07-1900-feat-review-polish-scale-plan.md` (U7 intake), `docs/competitive-review.md` walkthrough row.
- **Stop conditions:** the eval A/B shows the adopted prose citing findings that were dropped, materially wrong about the diff, or reading as a findings recap rather than a PR description; revert means leaving `walkthrough` unset.

## Product Contract

### Summary

`CODE_REVIEW_SCHEMA` already returns `summary` on every chunk call; single-chunk reviews parse it and discard it. Adopting it under hardened guards produces the CodeRabbit-parity walkthrough at zero added spend. Placement correction from doc-review: the line between the lane table and the folds is `findingsLine` (deterministic severity counts) and never carried `report.summary` — prose reached only the review lane's `Result` cell on manifest runs (200-char `cell()` cap) and the collapsed `Findings (N)` fold lead. The walkthrough therefore ships as its own `walkthrough` report field rendered as a dedicated head line in both renderers (`src/report/comment.ts`, `action/sticky-comment.cjs`), between the lane table and the counts line.

### Problem Frame

The competitive delta table calls for a one-paragraph plain-language walkthrough in the sticky head, gated on "must not add noise." The cheapest correct fix is reusing output we already generate — but reuse alone is insufficient: the guards must also cover post-capture mutations (validation drops, reflection drops, adjudication suppression, severity caps) and the budget-stop verdict flip, which the synthesis path's narrower guard misses today.

### Requirements

- R1. A completed single-chunk code review surfaces the model's `summary` in the report's `walkthrough` field (and, per existing `summary` semantics, `summary` itself) when the adoption guards pass, rendered as a sanitized head line in the sticky.
- R2. Adoption is suppressed when the chunk's findings were dropped in-loop, when any post-capture stage removed a model finding (validation, reflection, adjudication — checked by count containment against the union), when the model verdict mismatches the derived verdict, when a budget stop is pending, or when the model emitted no summary (absent/empty — `parseCodeReview` now returns `summary?: string` so absence is distinguishable from fallback literals).
- R3. No additional model call is added; per-review spend is unchanged.
- R4. The eval gate records, per corpus row: whether `walkthrough` was emitted (guard-pass coverage rate), a walkthrough-vs-findings-recap classification of the prose (an accurate findings recap counts as noise → reject), sticky byte delta, comment count (unchanged by construction — the line lives inside the sticky), and spend (unchanged — no new calls). Drop-citation is verified by unit tests; if no corpus row produces a post-capture drop under an adopted summary, the record says so rather than claiming coverage.

## Planning Contract

- KTD1. **Reuse the chunk summary; do not add a walkthrough call.** (session-settled: user-directed — the schema already returns `summary` on every chunk call; a second call would spend tokens re-describing input the first call just read.)
  - Guards: `modelVerdict === verdict`, `modelSummary` non-empty, `describedFindings === finalFindings.length - rulesFindings.length` (every model finding the prose described survives), `!ledger.budgetExceeded`. Applied at the shared adoption site so the synthesis path gets the same hardened guard.
- KTD2. **Single-chunk only.** When `chunks.length > 1`, the synthesis path owns `modelSummary`; per-chunk summaries describe a slice, not the PR, and stay discarded.
- KTD3. **`walkthrough` is a separate report field.** `summary` keeps its existing semantics (model prose when adopted, deterministic otherwise) for the Result cell, Findings fold lead, TUI, and dashboard; `walkthrough` exists only when guards passed, so the head line can render prose unconditionally when present without duplicating the deterministic counts line.

### Assumptions

- The chunk summary's phrasing is acceptable verbatim — UNVERIFIED premise the eval gate must test. Existing synthesis summaries in `docs/audits/eval/reports/` read as findings recaps ("All findings are low-confidence nits…"), not "The PR introduces…" descriptions; the chunk prompt frames `summary` even less as a PR description. The A/B classifies each adopted summary as PR-description vs recap; recap = noise = mechanism-level reject.
- Model-authored prose is prompt-influenceable text from a PR-controlled diff — the head line and the fold lead both render through `cell(sanitizeCommentText(w))` (mention/link/`</tag` neutralization, secret masking, caps), closing an exposure the fold already had on the synthesis path.
- The walkthrough needs no opt-out config — a user who wants terse output has no knob to lose.

## Implementation Units

### U1. Adopt the single-chunk summary into a `walkthrough` field under hardened guards

**Goal:** the report carries `walkthrough` prose on reviews where guards pass, and the sticky renders it as a head line.

**Requirements:** R1, R2, R3

**Files:**
- `src/cli/code-review.ts` — hoist `modelVerdict`/`modelSummary` above the chunk loop; add `describedFindings`/`walkthrough`; capture per plan; widen the adoption guard
- `src/cli/review-shared.ts` — `parseCodeReview` returns `summary: string | undefined` (no fallback literals); `CodeReviewReport.walkthrough?: string`
- `src/report/comment.ts` — `CodeReviewInput.walkthrough`, `walkthroughLine()` (sanitize + 400-char cap), `head()` gains the line before the counts
- `action/sticky-comment.cjs` — parity: same helper, `layout({walkthrough})`, three call sites; fold lead now sanitized (`cell(sanitizeCommentText(codeReview.summary), 1000)`)
- `tests/unit/fixture.test.ts`, `tests/unit/comment.test.ts`

**Approach:** as implemented — capture inside the chunk loop under `chunks.length === 1`, adopt at the shared site, serialize `walkthrough`, render through both renderers.

**Test scenarios:**
- Single chunk, guards pass → `summary` and `walkthrough` carry the prose; exactly one model call.
- Verdict mismatch → deterministic summary, `modelVerdict` recorded, `walkthrough` absent.
- Post-parse drop → deterministic summary, `walkthrough` absent.
- `summary` empty or absent → deterministic summary, `walkthrough` absent.
- Multi-chunk → chunk prose ignored; synthesis prose flows to `walkthrough` when its guards pass.
- Head render: `walkthrough` line appears above the counts line; mention/`</details>`/newline injected prose is neutralized.

**Verification:** unit tests green; the eval gate in U2 measures the corpus delta.

### U2. Eval gate and honest recording

**Goal:** measure whether the walkthrough adds signal without noise, then record adopt/reject (scoped to this mechanism) in `docs/competitive-review.md`.

**Requirements:** R4

**Files:**
- `docs/competitive-review.md`
- `docs/audits/eval/` — new run artifacts
- `CHANGELOG.md`

**Approach:**
1. Run the clean corpus and the AACR subset on `google/gemini-2.5-flash` with U1 in place (the "off" side is the absence of the field in every committed prior run — no separate baseline needed for presence/byte deltas; comment count and spend are unchanged by construction).
2. Per row, classify adopted prose as PR-description vs findings-recap; record guard-pass coverage; note whether any row produced a post-capture drop (drop-citation check is unit-verified; corpus coverage likely absent — say so).
3. Record a mechanism-scoped verdict in `docs/competitive-review.md`: a reject on prose shape closes "reuse of the chunk `summary` field", not the walkthrough candidate — the fallback is pinning `summary`'s semantics in the prompt or a dedicated field, still zero added calls.

**Verification:** artifacts committed under `docs/audits/eval/`; the competitive-review line states adopt or reject with numbers and the coverage caveat.

## Verification Contract

- `npm run typecheck && npm run lint && npm run build && npm run check:dist && npm run check:parity && npm test` — the standard battery.
- The no-emoji/em-dash budget (`tests/unit/no-emoji.test.ts`) must stay green; no new stage line is expected.
- Eval artifacts land under `docs/audits/eval/` and are referenced from the competitive-review entry.

## Definition of Done

- `walkthrough` surfaces on reviews where guards pass; all guard-path unit tests pass; head render parity between `src/report/comment.ts` and `action/sticky-comment.cjs`.
- The eval record shows guard-pass coverage per row, the prose-shape classification, and states whether drop-citation was exercised or untested.
- `docs/competitive-review.md` records the measured mechanism-scoped outcome and `CHANGELOG.md` carries the entry.
- No abandoned experiment code or temporary flags remain in the diff.

## Deferred / Open Questions

From 2026-10-13 ce-doc-review round 1 (5 personas):

- **Manifest Result-cell duplication.** On manifest runs, `lane.summary` (=`report.summary`, already model prose when adopted) renders truncated in the Result cell while `walkthrough` renders fully below the table — tolerable duplication; revisit only if it reads badly in eval output.
- **Rules-union additions don't invalidate prose.** A rules-lane finding can't be cited by prose written before it existed; severity demotions that don't flip the verdict can still leave prose citing a finding at its old severity (corner-of-corner, accepted).
- **`modelVerdict` now serializes on divergent single-chunk runs** — a report-schema-visible delta; informational only.
- **20 KB collapse.** Under `COLLAPSE_ORDER` the Findings fold can collapse on huge PRs — the head line is outside folds, so the walkthrough actually survives collapse better than the old placement.
- **Recap-vs-walkthrough re-litigation.** If U2 rejects on prose shape, whether a prompt-pinned `summary` semantic or dedicated walkthrough field stays within the zero-added-calls premise is the open candidate question.
