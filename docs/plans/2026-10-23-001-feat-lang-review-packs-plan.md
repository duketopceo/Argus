---
title: "feat: Per-language review packs (competitive U10 / #154)"
type: feat
date: 2026-10-23
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
origin: docs/plans/2026-10-04-0003-feat-competitive-roadmap-plan.md#U10
issue: https://github.com/duketopceo/Argus/issues/154
execution: code
---

# feat: Per-language review packs (competitive U10 / #154)

## Goal Capsule

**Objective:** each review chunk's prompt gains language-shaped rubric
blocks auto-selected from that chunk's file extensions, stacked under any
configured `review.profiles`, with zero new config for the common case.

**Means:** extend `src/review/packs.ts` with `LANG_PACKS` + selection;
thread per-chunk filenames into `buildCodeReviewMessages`; add
`review.langPacks` (default on).

**Authority:** competitive roadmap U10 (#154); M7 after shipped U9
tool-use (#203).

**Stop conditions:** unknown extensions must leave the prompt
byte-identical to today when lang packs would add nothing; eval recall
regression on a pack → that pack stays out of the default map (residual
if live eval cannot run this session).

**Ships and finishes:** the implementing agent, one PR. Do not merge.

## Product Contract

### Summary

Language rubrics (TS/JS, Python, Go, SQL) append to the review prompt the
same way named `review.profiles` lenses do — prompt composition only.
Auto-detection from the chunk's filenames keeps the ≤3-step onboarding
promise; `review.langPacks: false` (or env) turns the feature off.

### Requirements

- R1. Per-chunk: extensions present in `plan[i].files` select zero or more
  language packs; selected rubrics appear under an `Active language lenses`
  (or equivalent) block stacked after profile lenses.
- R2. Unknown / non-code extensions → no language block (prompt otherwise
  unchanged vs profiles+instructions alone).
- R3. `review.langPacks` defaults `true`; literal `false` disables.
  Workflow-author override via `ARGUS_REVIEW_LANG_PACKS=0|false|off`.
- R4. Packs never bypass posting policy — same severity/dedup/adjudication
  path as profiles (rubric-only).
- R5. Unit tests cover happy (`.ts`+`.sql`), edge (unknown ext), config off,
  and composition with profiles.
- R6. `dist/` rebuilt; typecheck/lint/test green.

### Explicit assumptions (pipeline)

- A1. Initial pack set: `ts` (`.ts`/`.tsx`/`.js`/`.jsx`/`.mjs`/`.cjs`),
  `py` (`.py`), `go` (`.go`), `sql` (`.sql`). Further languages are
  follow-ups.
- A2. Eval-corpus recall gate (parent U10) runs when `OPENROUTER_API_KEY`
  is available; if not, ship on unit-test gate and record residual in the
  PR body (packs are prompt-only, not deterministic findings).

## Planning Contract

### Key Technical Decisions

- KTD1. **Extend `packs.ts`, do not fork a second rubric module.** Profiles
  and language packs share `packRubric` composition so
  `buildCodeReviewMessages` stays one call site.
- KTD2. **Selection input is chunk `files: string[]`, not patch text.**
  Filenames already exist on `PlannedChunk`; parsing `### path` from prompt
  text would drift.
- KTD3. **`packRubric(profiles, langIds?)` merges both blocks.** Empty
  langs → omit language section entirely (R2). Stable order: profile order
  as configured, then language ids in `LANG_PACK_IDS` declaration order.
- KTD4. **`review.langPacks` boolean default true.** Only literal `false`
  disables (match `requestChanges` / `repoTools` posture for booleans that
  default true — wait: `repoTools` is default false with `=== true`. For
  default-true, use `!== false` like `requestChanges`).
- KTD5. **Call sites in `code-review.ts` (3× `buildCodeReviewMessages`) pass
  `selectLangPacks(plan[i]?.files ?? [])` when lang packs enabled.** Scan
  path: only if it already uses `buildCodeReviewMessages` with profiles —
  match existing behavior; do not invent scan-only wiring.

### Scope boundaries

- Out: new model calls, new findings, GitLab (#23), MCP/skills, changing
  profile names, auto-enabling packs from repo language stats beyond the
  chunk.

## Implementation Units

### U1. Language packs + selection + config + prompt wiring

**Files:**
- `src/review/packs.ts` — `LANG_PACK_IDS`, `LANG_RUBRICS`, extension→id map,
  `selectLangPacks`, extend `packRubric`
- `src/cli/review-shared.ts` — `buildCodeReviewMessages(..., langIds?)`
- `src/cli/code-review.ts` — pass selected langs at three call sites; env
  override for lang packs
- `src/config.ts` — `review.langPacks: boolean` default true; resolve
  `!== false`
- `docs/quickstart.md` — one short paragraph on auto language lenses
- `tests/unit/lang-packs.test.ts` (new) + extend `review-packs.test.ts` if
  `packRubric` signature changes
- `dist/` rebuild

**Test scenarios:**
- Happy: files `a.ts`+`b.sql` → both TS and SQL rubric lines
- Edge: `README.md` only → no language block
- Edge: `langPacks: false` → no language block even for `.ts`
- Compose: profile `security` + `.py` → both sections present
- Config: mis-typed `langPacks` string → default true (`!== false`)

**Verification:** `npm run typecheck && npm run lint && npm run build &&
npm test` (focused packs tests first); `check:dist` if scripted.

## Verification Contract

- Unit tests above green.
- Full suite green.
- Optional: `node evals/review-quality/run.mjs` when key present — no
  planted-finding recall regression vs baseline label; else residual.

## Definition of Done

- U1 merged to a pushed PR branch; PR links #154; CI decided; not merged
  to main by this agent.
