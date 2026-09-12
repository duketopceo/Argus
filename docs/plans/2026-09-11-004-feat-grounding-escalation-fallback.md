---
title: "feat: grounding → escalation-model fallback for locate"
created: 2026-09-11
origin: issue #14 (M2 — Vision reliability); eval showed cold-run grounding failures
---

# Grounding → escalation-model fallback

## Summary

When `locate` fails after its verify-then-correct loop — model returned
`fail`/`done`/no usable coordinates, or grounded to a mismatched node — retry
the whole locate once with `escalation_model` as the primary model. The
OpenRouter `models` array we already pass is provider-level fallback (model
unavailable/rate-limited); it does not retry when the model *answers* but
grounds badly. Issue #14 asks for the semantic fallback.

The 2026-09-11 eval showed exactly this failure class: `gemini-2.5-flash-lite`
returned `done` on `locate: the "Name" input` and the step failed with no
recovery.

## Problem Frame

- `src/engine/loop.ts` `locate` runs: initial `_callModel` → correction loop
  (max 2 attempts) → failure return. On failure the step is dead.
- `config.escalation_model` already exists and is passed as the OpenRouter
  provider fallback for heal/specialist calls — never as a semantic retry.
- Cost: escalation only fires on failure, so cold-run spend stays bounded by
  `budgetUsd` via `ledger.canSpend`.

## Requirements

- **R1.** A failed locate (any `ok:false` path from the correction loop)
  retries once with `escalation_model` as the primary model — fresh observe +
  fresh initial call + the same verify-then-correct loop.
- **R2.** Fallback only fires when `escalation_model` is set, differs from the
  model that just failed, and `ledger.canSpend` allows it.
- **R3.** The journal records the escalation (`_note('locate', ...)`), and the
  step result carries which model produced the accepted point (`model` field
  already exists).
- **R4.** No new config keys. Behavior is additive — unchanged when no
  escalation model is configured (never in practice: default is kimi-k2.5) or
  when the primary succeeds.
- **R5.** Specialists (`grounding_model` set) also get the fallback — the
  escalation call uses the same specialist prompt shape.

## Key Technical Decisions

- **KTD1. Extract `locateOnce`, don't nest a second loop.** The existing
  call+correction+verify block becomes an inner routine parameterized on the
  model; `locate` iterates `[primary, escalation]`, first success wins. Keeps
  the correction loop readable and the fallback honest.
- **KTD2. Re-observe before the escalation call.** The failure may have left
  the page in a different state; the escalation model gets a fresh
  observation, not the stale one.
- **KTD3. Failure result = last attempt's.** If escalation also fails, the
  reported reason comes from the escalation attempt (more informative), with a
  journal note carrying the primary's reason.
- **KTD4. Budget gate before the escalation call, not per-attempt.** One
  `canSpend` check guards the whole retry.

## Scope Boundaries

### In scope
- `src/engine/loop.ts` — extract + retry
- `tests/unit/engine.test.ts` (or wherever locate tests live) — fallback cases
- eval note in `docs/evals/` is optional, not required

### Out of scope
- Escalation for `assert` or flow `record` steps (locate only — asserts have no
  coordinates to escalate on; record termination is issue #13)
- Multi-level fallback chains (one escalation hop only)
- Automatic model-quality scoring

## Implementation Units

### U1. `locateOnce` extraction + escalation retry in `src/engine/loop.ts`

**Goal:** `locate` tries the primary model, then `escalation_model` once on
failure.

**Requirements:** R1–R5

**Files:** `src/engine/loop.ts`

**Approach:** Extract the current initial-call + correction-loop body (from
the `specialist`/`useHeal`/`escalation` setup through the post-loop failure
returns and success return) into a private routine — e.g.
`_locateWithModel(instruction, observation, useHeal, modelOverride)` returning
the same `LocateResult` the code already produces. `locate` then:

1. Run `_locateWithModel` with the grounding/vision model (current behavior).
2. On `ok:false` — if `escalation_model` is configured, differs from the
   failed model, and `ledger.canSpend(0.001)` — `_note` the escalation, take a
   fresh `driver.observe()`, and run `_locateWithModel` again with the
   escalation model as primary (specialist prompt shape preserved when
   `grounding_model` is set).
3. Return whichever result is final; on double-failure return the escalation
   attempt's result.

The existing `escalation` OpenRouter-fallback array passed to `_callModel`
stays as-is (provider fallback, orthogonal).

**Patterns:** existing `_note`, `_callModel(kind, messages, escalation,
groundingModel)` signature, `LocateResult` shape, ledger `canSpend` checks.

**Test scenarios:**
- Primary grounds fine → no escalation call, result model = primary
- Primary returns `done` twice → escalation model called, its good point
  accepted, journal note recorded, result model = escalation model
- Primary fails AND escalation fails → `ok:false` with escalation's reason
- `canSpend` false → no escalation call, primary failure returned
- `escalation_model` === primary model → no duplicate call
- Cache-hit path never reaches fallback (locate short-circuits earlier)

**Verification:** `npm run typecheck && npm run lint && npm test` green.

## Risks

- **Double-spend on pathological pages** — bounded: one escalation hop, gated
  by the ledger; a locate that always fails now costs ≤2 model calls + the
  inner correction retries.
- **Report semantics** — `healed` stays as-is (cache heals only); escalation
  is visible via `model` on the result + journal notes. No schema change.
