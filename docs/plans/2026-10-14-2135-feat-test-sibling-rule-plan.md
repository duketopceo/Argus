---
title: Test-sibling rules-lane signal - Plan
type: feat
date: 2026-10-14
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# Test-sibling rules-lane signal - Plan

## Goal Capsule

**Objective:** on repos whose own diffs demonstrate colocated test pairing,
a PR that updates one sibling-tested source file while leaving another's
sibling untouched produces one file-level `nit` naming the uncovered file —
at zero added comment volume.

**Means:** a new rules-lane rule `test-sibling` that requires an in-diff
pairing witness before flagging uncovered eligible sources (KTD1–KTD5).

**Authority:** parent plan U5 ranks this candidate first and fixes the
adoption contract — named ruleset, eval-corpus measurement, no comment
volume without precision (`docs/plans/2026-10-07-1900-feat-review-polish-scale-plan.md`).

**Stop conditions:** firings on the firing-capable corpus are dominated by
the known FP shapes (witness convention legit but change needed no test
update; sibling pairing proven in one subsystem but applied to another);
or no row — real or synthetic — exercises a firing at all, in which case
the rule stays written but off `REVIEW_RULES` until evidence exists.
Revert means removing the registry entry; post-release removal also
breaks any explicit `review.rules` list naming the id, so the entry only
ships when the gate says keep.

**Ships and finishes:** the implementing agent, one PR.

## Product Contract

### Summary

Add a `test-sibling` rule to the deterministic rules lane. Where the
shipped `missing-test` rule fires only when a diff contains zero test
files, this rule covers the narrower gap inside diffs that do touch tests:
a changed source file whose own test sibling went untouched. It is
deliberately self-scoping — it can only fire after the diff itself proves
sibling pairing is the repo's convention — and emits at most one
file-level `nit`, mirroring `missing-test`'s signal-not-nag contract.

### Problem Frame

The parent plan's U5 gap analysis ranks a missing-test signal first among
coverage candidates. The shipped `missing-test` rule (0.5.0) only catches
the fully source-only diff; a PR that updates `bar.test.ts` while changing
`foo.ts` emits no test signal today, which is the more frequent gap.
Sibling pairing cannot see mirror-tree layouts (`tests/` mirrors,
Maven `src/test/java`, `FooTest` suffixes) — the dominant convention
outside JS — so the trigger must prove colocated pairing from the diff
itself rather than infer a convention from any test file at all.

### Requirements

- R1. The rule fires only when the diff contains at least one **witness**:
  an eligible source file whose stem-group holds a changed genuine-test
  member. The witness proves sibling pairing is this diff's convention;
  without one the rule is silent regardless of how many test files or
  uncovered sources exist.
- R2. With a witness present, the rule emits exactly one `nit`/`testing`
  finding on the highest-churn eligible source file whose group holds no
  changed test member.
- R3. The rule emits zero findings when `addedLines` shows no genuine-test
  file — the same trigger surface `missing-test` uses, so the two rules
  are disjoint by construction.
- R4. Finding and record shapes, provenance stamping, audit `records`,
  and severity behavior follow the existing `ReviewRule` contract
  unchanged; the finding is file-level (no `line`), folds with nits, and
  never posts inline.
- R5. A test member is a changed path satisfying `isTestPath` whose
  basename does not end `.snap` and whose path contains no `__mocks__/` or
  `fixtures/` segment. `.stories`/`.gen`/`.generated`/`.test-d` stem-mates
  join the source's group but never satisfy coverage (`isTestPath` does
  not match them; `.snap` is excluded despite matching).
- R6. Eligible sources reuse `missing-test`'s predicates (code extension,
  not data/generated/script path) plus a test-sibling-local exclusion of
  `.gen.`/`.stories.`/`.test-d.`/`.d.ts` shapes — those may group with a
  source but must not themselves be flagged as needing tests. The shared
  predicate list itself stays byte-identical for `missing-test`.
- R7. The eval gate measures firings on a corpus that provably contains
  the trigger shape and records each firing's legitimacy before the
  registration ships.

## Planning Contract

### Key Technical Decisions

- KTD1. **New rule id `test-sibling`, not an extension of `missing-test`.**
  The shipped id's documented trigger is "zero test files in the diff" and
  `review.rules` consumers opted into exactly that; the sibling check is a
  different trigger, so a second id keeps both semantics intact. R3 makes
  the two disjoint.
- KTD2. **Pairing key is a new exported `testSiblingKey(path)` in
  `src/review/testfiles.ts`.** `bundleKey` (`src/review/chunks.ts:56`) is
  private and extending it would alter shipped chunk-bundling semantics for
  no gain here. `testSiblingKey` normalizes a path by stripping
  `__tests__`/`__snapshots__`/`__mocks__` directory segments and the full
  sibling-affix set from the basename — test affixes (`_test.ext`,
  `test_*.py` prefix, `.test.`/`.spec.`/`.test-d.` infixes, `.snap`
  suffix) plus `.stories.`/`.e2e.`/`.gen.`/`.generated.` infixes. Two paths
  are siblings when their keys match. The directory is otherwise
  preserved: `e2e/foo.spec.ts` does not pair with `src/foo.ts`.
- KTD3. **Pure-diff semantics with a convention witness; all enumeration
  on `addedLines`.** Rules are pure functions over diff text, and every
  trigger input comes from `addedLines` — the same surface `missing-test`
  reads — so rename-only, mode-only, binary, and deleted-file sections are
  invisible to this rule exactly as they are to the existing one. That
  single choice resolves three failure shapes doc review surfaced: a
  deleted test can never satisfy coverage or the gate, no
  `src/cli` import inverts the lane's dependency direction, and R3's
  disjointness is mechanical rather than asserted. The rejected
  alternative — a repo file list on `RuleRunContext` to check
  sibling-existence — would erase the "tests exist but weren't touched"
  gap the whole rule exists to catch; it is recorded as a deliberate
  non-choice, with the residual FP surface handled by the witness (R1) and
  measured by the gate (R7).
- KTD4. **One finding max, `nit`/`testing`, file-level, churn-ranked by
  added+removed lines.** Mirrors `missing-test`'s volume contract
  (`rules.ts:456`): one audit record per uncovered source, one surfaced
  finding naming the highest-churn file plus the uncovered count. Churn
  counts both directions (`diffLines`) so deletion-heavy refactors compete
  fairly against add-only bulk. Message wording stays valid in `scan`
  mode, where the same code reads as "sources whose stem-group gained no
  test edit" over a whole-tree diff.
- KTD5. **`missing-test`'s predicate list is shared for path-shape
  eligibility; the supplementary exclusions are test-sibling-local.**
  Exporting the eligibility test as one module-private helper keeps the
  exclusion sets from drifting, while `.gen.`/`.stories.`/`.test-d.`/
  `.d.ts` filtering lives only in `test-sibling`'s candidate filter —
  extending the shared list would change `missing-test`'s shipped
  behavior, which the Definition of Done forbids.

### Assumptions

- `REVIEW_RULE_IDS` auto-propagates the new id into config defaults — no
  schema or `action.yml` change; users with an explicit `review.rules`
  list never receive the rule, which is consistent opt-in semantics the
  eval verdict must not over-claim.
- Churn via `diffLines` (added+removed) is available from the same module
  surface the rule already iterates; the exact helper is an
  implementation-time detail.

### Risks & Dependencies

- **Legit-but-unneeded FP** — a witness can coexist with a source change
  that honestly needed no test (type-only, mechanical). Nit severity and
  the one-finding cap bound the cost; the gate measures the rate.
- **Recall is intentionally narrow** — mirror-tree repos, untouched-repo
  siblings, and diffs with no paired change all stay silent. That is the
  precision-first posture the parent plan's contract requires; the eval
  records coverage rather than implying it.

## Implementation Units

### U1. `test-sibling` rule and `testSiblingKey` helper

**Goal:** the rule is registered, default-enabled when the gate keeps it,
and fires exactly under R1–R3 with full unit coverage.

**Requirements:** R1–R6.

**Dependencies:** none.

**Files:**
- `src/review/testfiles.ts` — add exported `testSiblingKey` (KTD2)
- `src/review/rules.ts` — shared eligibility helper (KTD5),
  `testSiblingRule`, `REVIEW_RULES` entry (KTD1)
- `tests/unit/review-rules.test.ts` — new describe block
- `tests/unit/fixture.test.ts` — pipeline-level: `rulesScan.ran` includes
  the id and the finding unions into `finalFindings`
- `docs/quickstart.md` — rule-id prose list
- `CHANGELOG.md` — Unreleased/Added entry

**Approach:**
1. `testSiblingKey` per KTD2, co-located with `isTestPath` so the eval
   harness's classifier mirror stays in one module.
2. Extract `missing-test`'s path-eligibility predicates into one
   module-private helper both rules call (KTD5); `missingTestRule` calls
   it with no behavior change.
3. One pass over `addedLines` builds stem-groups of changed files, marks
   each group covered when a member satisfies the R5 test predicate,
   tracks added+removed churn per eligible uncovered source, and applies
   the R6 supplementary exclusions to candidates.
4. Skip unless a witness exists (R1); then emit the KTD4 finding shape
   and one `records` entry per uncovered source (`detail` = stem +
   `N source file(s) untested alongside a paired-test change` — pattern
   class, never raw line text).
5. Register in `REVIEW_RULES` only when U2's gate says keep (see Goal
   Capsule stop conditions); id auto-propagates through
   `REVIEW_RULE_IDS`.

**Patterns to follow:** `missingTestRule` (`src/review/rules.ts:459-507`)
for trigger/skip structure, churn ranking, message voice, record shape;
`testfiles.ts` for classifier placement and header-comment style.

**Test scenarios:**
- Witness + uncovered: `src/foo.ts` + `src/foo.test.ts` +
  `src/bar.ts` → one nit naming `bar.ts` (witness `foo` proves
  convention).
- All covered: `src/foo.ts` + `src/foo.test.ts` → silent.
- Tests changed, none paired: `src/foo.ts` + `src/bar.test.ts` → silent
  (no witness — mirror-tree and first-test FPs unreachable by
  construction).
- No test files: `src/foo.ts` + `docs/x.md` → silent; R3 disjointness —
  `missing-test` may fire, this rule must not.
- `__tests__` pairing: `src/a/foo.ts` + `src/a/__tests__/foo.ts` +
  `src/a/baz.ts` → fires on `baz`; `src/a/foo.ts` +
  `src/b/__tests__/foo.ts` + `src/a/baz.ts` → silent (dir-preserved).
- Go/Python affixes: `pkg/foo.go` + `pkg/foo_test.go` + `pkg/bar.go` →
  fires on `bar.go`; `pkg/foo.go` + `tests/test_foo.py` + `pkg/bar.go` →
  silent (cross-dir `tests/` is not a sibling and cannot be a witness).
- Non-test stem-mates: `src/foo.ts` + `src/foo.test.ts` +
  `src/foo.gen.ts` → silent on `foo.gen.ts` (grouped but R6-excluded);
  `src/foo.ts` + `src/foo.test.ts` + `src/foo.stories.ts` → same.
- `.snap` never covers: `src/foo.ts` + `src/foo.test.ts` +
  `src/bar.test.ts.snap` regen + `src/baz.ts` → fires on `baz.ts` (the
  `.snap` regen is `isTestPath` but R5 excludes it).
- `__mocks__`/`fixtures` never cover or witness: `src/foo.ts` +
  `src/__mocks__/bar.ts` + `src/baz.ts` → silent.
- Multiple uncovered sources → exactly one finding naming the
  highest added+removed-churn file, count in message; one record each.
- Deletion-heavy uncovered source (200 removed, 5 added) outranks a
  500-adds mechanical file for the finding slot (KTD4).
- Deleted test file `src/foo.test.ts` + `src/foo.ts` + unrelated real
  test change `src/x.test.ts` + `src/x.ts` → `foo` counts uncovered, not
  covered — a removed sibling is not coverage.
- Finding has no `line`, severity `nit`, category `testing`, message
  `nit:` token matches severity for `deriveSeverity`; scan-mode wording
  reads sensibly on a whole-tree diff.
- `REVIEW_RULES` containing the id produces `test-sibling` in
  `rulesScan.ran` on a fixture run; absent it (pre-registration) the lane
  shows no record.

**Verification:** new describe block green; existing `missing-test` cases
byte-identical; `npm run typecheck`.

### U2. Eval gate and adoption record

**Goal:** measured evidence for keep-or-remove — which diffs fire and
whether each firing is legitimate — recorded before `REVIEW_RULES`
registration ships.

**Requirements:** R7.

**Dependencies:** U1 (rule exists; registration withheld per KTD3 stop
condition until the gate resolves).

**Files:**
- `docs/audits/eval/test-sibling.json` — run record
- `docs/competitive-review.md` — new Pending-evaluations checklist line
  and a new Delta-table row recording the verdict
- `scripts/review-eval.mjs` — export the repo-resolve/diff machinery the
  gate script reuses (see Approach), if not already importable
- one synthetic corpus row proving the trigger shape, committed under the
  eval-fixtures convention used by `eval-fixtures/large-clean`

**Approach:**
1. Deterministic, zero model spend: a small script materializes each
   corpus row's diff at merge-base (the SHAs the reviews actually ran —
   `diffRange.baseSha`, not the corpus entry's `base`) and calls
   `runRules` with the default registry, collecting `test-sibling`
   records. It reuses `review-eval.mjs`'s `resolveRepo`/history machinery
   — exported for reuse if currently module-private — so fetched
   worktrees match what review produced.
2. Corpus selection is firing-capable by construction: committed AACR and
   clean rows mostly contain zero test files (missing-test records prove
   it), so the gate adds consumer-repo PRs that touch `src`+test pairs
   (wisp/kurultai merged PRs — verify they use colocated tests; if none
   do, record that and rely on the synthetic row) plus one committed
   synthetic diff where a covered sibling and an uncovered sibling are
   known by construction.
3. Classify each firing legit-gap vs FP-class (witness convention real
   but change needed no test update; cross-subsystem convention bleed);
   classification checks the repo tree for a would-be sibling on
   committed rows — cheap once the worktree exists.
4. Verdict mapping is explicit: keep the registration iff at least one
   firing (real or synthetic) exercises the trigger AND legitimate
   firings ≥ FP firings; if zero real firings and only the synthetic row
   exercised it, ship registered with an "unmeasured on real PRs" note;
   if nothing exercised the trigger, leave the rule written but
   unregistered and record why.
5. Record per-row outcomes, the FP-class tally, the verdict, and the
   corpus-coverage caveat in `docs/audits/eval/test-sibling.json`; update
   `competitive-review.md` checklist + Delta row.

**Test expectation:** none — measurement and documentation unit; its
assertions are the committed artifact and verdict line, validated by
re-running the script.

**Verification:** artifact committed; every firing row classified; verdict
recorded honestly including a "no real rows fired" outcome.

## Verification Contract

`npm run typecheck && npm run lint && npm run build && npm run check:dist && npm test`
— `rules.ts` is not a parity surface (`check:parity` unaffected); `dist/`
is committed and must rebuild. Eval artifact committed under
`docs/audits/eval/`.

## Definition of Done

- U1: rule implemented and unit-green under R1–R6; `missing-test`
  behavior byte-identical; docs + CHANGELOG updated. `REVIEW_RULES`
  registration lands only with U2's keep verdict.
- U2: eval record committed with per-firing classification, explicit
  verdict, and honest coverage statement; `competitive-review.md`
  updated.
- No rule fires twice on one diff, no finding posts inline, no added
  model spend anywhere, and a deleted or renamed test file can neither
  cover a sibling nor unlock the gate.
