---
title: "Exploratory act policy — bounded free-explore on top of U4a captures - Plan"
type: feat
date: 2026-09-29
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan
execution: code
origin: docs/plans/2026-09-16-001-feat-full-reviewer-roadmap-plan.md
---

# Exploratory act policy — bounded free-explore on top of U4a captures - Plan

## Goal Capsule

- **Objective.** After `argus-reviewer run` finishes its test loop, an enabled
  explore lane walks the target app on its own — clicking, navigating
  same-origin pages, and probing inputs — and the anomalies it provokes land
  on the report as observed evidence, with every step and dollar accounted
  for and no path to a verdict change.
- **Means.** A new `ExploreLoop` (`src/engine/explore.ts`) that reuses the
  existing VisionClient/Ledger/Actions machinery with an explore-specific
  action schema and prompt (KTD1, KTD2), invoked once per `run` after the
  per-file test sessions (KTD2).
- **Authority.** `docs/plans/2026-09-16-001-feat-full-reviewer-roadmap-plan.md`
  R5 and unit U4 own product intent; this plan's Requirements own product
  behavior; KTDs own implementation mechanism.
- **Stop conditions.** Any requirement that forces model output to become
  executable code, cross-origin navigation that cannot be structurally
  refused, or explore evidence acquiring verdict power invalidates the
  approach and stops the work.

## Product Contract

### Summary

U4a shipped passive capture: browser anomalies during test sessions render as
`observed` findings. U4b adds the act half of the roadmap's U4: a
model-driven free-explore pass that deliberately provokes the app — boundary
inputs, unvisited pages, dead ends — so coverage no longer depends on having
recorded flows. It runs once per `run` when `explore.enabled` and a reachable
URL exist, bounded by `explore.maxSteps` and `explore.budgetUsd`, and its
captures join the existing Exploratory report section as `observed` evidence.

### Problem Frame

The shipped capture lane observes whatever the authored tests happen to
touch. Repos with no recorded flows — the exact shape the product claim
("our agent drives your real app") targets — get a page load and nothing
else. The coverage gap is structural: evidence only exists where a human
already wrote a test. The roadmap anticipated this and split U4 deliberately:
U4a proved the capture/render plumbing on dogfood PRs; U4b now puts a bounded
act policy on top of that same plumbing (see origin: roadmap plan, unit U4).

### Requirements

#### Act loop

- R1. When `explore.enabled` is true and a run URL is resolved, `argus-reviewer
  run` executes a free-explore pass after the per-file test loop — observe,
  propose, execute, repeat — even when zero test files were found.
- R2. The model's act vocabulary is `click`, `type`, `pressKeys`, `scroll`,
  `wait`, `navigate`, `done`. Proposals map only to `Actions`/`BrowserDriver`
  primitives; no eval, no code path, no arbitrary command surface.
- R3. `navigate` is confined to the run target's origin: cross-origin or
  non-`http(s)` proposals are refused and journaled, never executed. Targets
  that are not `http(s)` (e.g. `file://`) degrade to a no-navigate policy.
- R4. The loop halts on: model `done`, `explore.maxSteps` (default 20), the
  budget guard (R5), or a stall — the same page signature (URL + a11y hash)
  seen three times.
- R5. Explore model calls bill through the run's Ledger as a distinct
  `CallKind` (`'explore'`), bounded by `explore.budgetUsd` when set and by
  `config.budgetUsd` otherwise; exhaustion stops the loop, not the run.

#### Safety

- R6. Explore executes only where `run` already executes — the existing trust
  posture is unchanged: `explore` is stripped from untrusted-checkout config
  (roadmap U1), and no new trust surface is added.
- R7. Model-typed input is bounded (truncate at 500 chars) and cannot reach
  configured `secrets` values — secrets resolve only through the `td.type`
  DSL, which the explore loop never invokes.
- R8. The page under test is untrusted input: page text (a11y tree, console)
  may attempt prompt injection; the structural bounds (R2, R3, R7) hold
  regardless of what the page asks the model to do.

#### Evidence and reporting

- R9. Anomalies tapped during the explore session (console errors,
  pageerrors, same-origin request failures) attach to
  `report.explore.captures` and render under the existing Exploratory comment
  section as `observed` findings — never verdict-changing.
- R10. `run.json`'s `report.explore` reports `steps` (count), `visited`
  (distinct URLs), `stopReason` (`'done' | 'max-steps' | 'budget' |
  'stalled' | 'error'`), `visionCalls`, and `visionCostUsd`; the sticky
  comment shows the same summary line.
- R11. Any failure of the explore pass itself (unreachable URL, browser
  launch failure, model call throwing) degrades to `explore.skipped` with an
  explicit reason string — the run never fails because exploration did.

### Key Decisions

- **Exploration reuses the vision engine, not A0.** Carried from the origin
  plan — free-explore is a new engine loop, not an A0 delegation; A0 remains
  the escalation path. Governs R1, R2.
- **Explore findings are additive evidence.** The milestone's posture is that
  observed anomalies inform reviewers but never gate; no opt-out to
  verdict-changing is added in this unit. Governs R9.
- **Explore runs even with zero test files.** Its purpose is exactly the
  un-recorded-path gap; gating it on test files existing would defeat it.
  Governs R1.

### Scope Boundaries

Deferred for later:

- Discovered preview URLs (check-run `target_url`, deployments API) — the
  roadmap lists them under U4's approach; this unit consumes the already
  resolved run URL only. A run with no URL still exits 2 before explore.
- A user-supplied explore goal/focus string — v1 uses a fixed exploratory
  charter (KTD4).
- Making observed findings verdict-affecting — roadmap's open question,
  unchanged.
- Plugin-lane (`a0-plugin-argus`) port of the `report.explore` render shape —
  keep-in-lockstep follow-up, same as the persist payload before it.

Outside this product's identity:

- Desktop/native exploration (A0's job).
- Explore as a mention command — `review`/`record`/`persist`/`help` are the
  whitelist; `issue_comment` runs never execute code.

### Acceptance Examples

- AE1. Dogfood run, `explore.enabled: true`, fixture app with a seeded
  broken link and a form that throws on empty submit: the explore pass clicks
  the nav, submits the empty form, the pageerror and console error appear in
  `report.explore.captures`, `stopReason` is `done` or `max-steps`, and the
  comment's Exploratory section lists them as `observed` — the run still
  passes. Covers R1, R2, R9, R10.
- AE2. `explore.enabled: true`, `--url` points at a dead port with no
  `target.command`: explore degrades to `skipped: 'no reachable target'`
  (R11); the run's verdict reflects only the test results.
- AE3. Model proposes `navigate` to `https://evil.example`: refusal is
  journaled, the page never leaves the origin, and the step counter still
  advances (R3, R4).
- AE4. Fork PR config ships `explore: { enabled: true, maxSteps: 9999 }`:
  untrusted config strip drops the whole block; the run never explores (R6).

## Planning Contract

### Key Technical Decisions

- KTD1. **New `ExploreLoop` in `src/engine/explore.ts`, not an `Engine`
  mode.** `Engine` is flow-bound (record/replay fingerprints, assert cache,
  per-flow steps). Explore has no flow, no fingerprint, no cache — sharing
  the class would inherit inapplicable state. It takes the same
  `VisionClient`, `Ledger`, `BrowserDriver`, `Actions`, `Config`, and
  `Logger` dependencies Engine already uses. (session-settled: user-approved
  via the origin plan's "new engine mode" design — chosen over subclassing
  Engine: flow machinery would force dead branches throughout the loop.)
- KTD2. **One app-level explore pass per `run`, after the file loop, in its
  own driver session.** Captures are session-scoped (`driver.pageCaptures()`),
  so explore needs its own driver with `captureErrors: true`; running it
  inside a test-file session would attribute its anomalies to that file's
  report and interleave its actions with test steps.
- KTD3. **The origin bound is structural, in the loop, not in the prompt.**
  `navigate` proposals resolve against `new URL(target, page.url())` and are
  refused unless the resolved origin equals the run target's origin. The
  prompt also states the rule, but the check cannot be prompt-injected away
  (R8).
- KTD4. **Fixed exploratory charter.** The system prompt directs bounded
  probing — visit unvisited nav, submit empty/invalid forms, exercise obvious
  interactions — with an explicit non-destructive rule. No user-supplied goal
  in v1: a goal string is a prompt surface worth its own design later.
- KTD5. **`explore` is a new `CallKind`, not a reuse of `ground`.** Ledger
  attribution and `costByModel`/`callsByModel` stay honest: explore spend is
  distinguishable from record/replay spend, which R10's reporting needs.
- KTD6. **`navigate` joins `Actions` as a driver primitive.** `Actions`
  already owns the action-to-driver mapping; adding `navigate(url)` there
  keeps explore's executor identical in shape to Engine's `_executeAction`.

### High-Level Technical Design

```text
cmdRun
  └── after per-file test loop (inside the existing try, before a0 heal)
        └── explore phase   [explore.enabled && url resolved]
              ├── driver = launchDriver(config)      // captureErrors on via config
              ├── driver.goto(target?.url ?? url)
              │     └── throws → report.explore.skipped = reason   (R11)
              ├── ExploreLoop.run()                  // src/engine/explore.ts
              │     loop:
              │       observe({grid:true})
              │       → buildExploreMessages(charter, observation, history)
              │       → client.complete(kind:'explore', schema:exploreActionSchema)
              │       → validate + bound proposal (R3, R7)
              │       → Actions.execute → new Observation
              │       → history += {action, url, note?}
              │       halt: done | maxSteps | budget | stall(3×same signature)
              ├── report.explore = { enabled:true, steps, visited, stopReason,
              │                      visionCalls, visionCostUsd, captures }
              └── driver.close()                     // video discarded — session is probe-shaped
```

Prompt contract (`src/engine/prompts.ts` additions):

- `exploreActionSchema` — same fields as `actionSchema` plus
  `action` enum gaining `'navigate'` and a `url` string field; `required`
  stays `['action','reasoning']`.
- `EXPLORE_SYSTEM` — the charter: probe the app for broken behavior, one
  action per call, same-origin only, non-destructive, `done` when the app
  surface is covered or budgets loom.
- `buildExploreMessages(goal, observation, history)` — mirrors
  `buildActionMessages`: transcript of prior acts with the URL each left the
  page on, current viewport, a11y tree.

Explore loop detail (directional, not implementation spec):

- Page signature for stall detection: `fnv1a(page.url() + a11yYaml)`; a map
  of signature → count; third consecutive identical signature stops with
  `stopReason: 'stalled'`.
- `visited` counts distinct `page.url()` values seen post-action.
- `type`/`navigate` args are the only model-controlled strings reaching the
  driver; both are bounded (500-char truncate; origin check) before use.
- `pressKeys` is bounded to a small key allowlist (`Enter`, `Tab`, `Escape`,
  `Backspace`, arrows) — explore needs form submission and focus movement,
  not arbitrary chords.

### Assumptions

- `cmdRun` already resolves `url` (`--url ?? config.target.url`) and exits 2
  when absent, so the explore phase always has a resolved URL string; the
  only reachability question is whether `goto` succeeds.
- `captureErrors` is already wired through `launchDriver` from
  `config.explore.enabled` (U4a) — the explore session gets taps free.
- `report.explore` is only consumed by `comment.ts`, `sticky-comment.cjs`,
  and `run.json` writers — extending its shape is backward-compatible for
  readers that ignore unknown keys.

## Implementation Units

### U1. Explore loop, prompt, and driver primitive

- **Goal:** `runExplore` produces a bounded, journaled action sequence
  against a live page, enforceable without trusting model output.
- **Requirements:** R1 (loop semantics), R2, R3, R4, R5, R7, R8
- **Files:** `src/engine/explore.ts` (new), `src/engine/prompts.ts`
  (`exploreActionSchema`, `EXPLORE_SYSTEM`, `buildExploreMessages`,
  `describeAction` gains `navigate`), `src/engine/actions.ts`
  (`navigate(url)` → `driver.goto` + `observe`), `src/vision/cost.ts`
  (`CallKind` gains `'explore'`), `tests/unit/explore.test.ts` (new),
  `tests/unit/prompts.test.ts` (explore schema/message cases)
- **Approach:** `ExploreLoop` mirrors Engine's observe→propose→execute
  structure without fingerprints or cache. Each iteration: observe, call
  `client.complete` with `kind:'explore'` and `exploreActionSchema` gated on
  `ledger.canSpend` + `explore.budgetUsd` headroom, parse tolerantly (reuse
  the `_parseAction`-style fallback logic — factor or duplicate minimally per
  existing conventions), validate the proposal (R3 origin check via
  `new URL(...)` against the run target origin; `type` text truncated;
  `pressKeys` filtered to the allowlist), execute through `Actions`, append
  to history with the resulting `page.url()`, and check halt conditions (R4).
  Model calls that throw are caught, journaled via a `_note`-equivalent, and
  stop the loop with `stopReason:'error'` — never propagate (R11 support).
- **Test scenarios:** scripted `StubClient` + stub driver: (a) `done`
  terminates with correct step count; (b) `maxSteps` caps; (c) exhausted
  ledger/`explore.budgetUsd` stops with `stopReason:'budget'`; (d)
  cross-origin and `javascript:` navigate proposals refused, journaled, page
  unmoved; (e) same-origin relative navigate executes; (f) 3× same signature
  → `'stalled'`; (g) oversized `type` text truncated to 500; (h)
  `pressKeys ['Control','Alt','Delete']` filtered to allowlist; (i) model
  throw → `'error'` stop, no rejection; (j) malformed JSON → tolerant parse
  or counted-as-step `fail` note per parse convention.
- **Verification:** `npm run typecheck` + `npx vitest run tests/unit/explore.test.ts tests/unit/prompts.test.ts`.

### U2. `run` wiring and report surfaces

- **Goal:** An enabled run produces `report.explore` carrying act summary and
  captures; a disabled or unreachable run produces the explicit skip.
- **Requirements:** R1 (invocation), R5 (billing into run totals), R9, R10,
  R11
- **Files:** `src/cli.ts` (explore phase in `cmdRun`), `src/report/run.ts`
  (`explore` shape extension), `src/report/comment.ts` (Exploratory section
  summary line + explore captures), `action/sticky-comment.cjs` (mirror),
  `tests/unit/cli.test.ts` (explore-phase integration via `deps.launchDriver`
  stub), `tests/unit/comment.test.ts` (render cases)
- **Approach:** After the per-file loop and inside the existing `try` (an
  argus-booted target must still be alive), when `config.explore.enabled`:
  launch a driver via `launchDriver` (capture taps come free), `goto` the
  resolved URL, run `ExploreLoop`, then populate `report.explore` — but note
  `buildRunReport` runs later, so collect the explore result into a local and
  merge it where `report.explore` is currently assigned (~line 836), folding
  explore `visionCalls`/`visionCostUsd` into run totals via the ledger.
  `goto` or launch failure sets `skipped` with the reason string (R11).
  `comment.ts`'s `exploreRows` gains a summary line (`explored N steps across
  M pages — stopped: <reason>`) and renders `explore.captures` rows alongside
  per-file captures; `sticky-comment.cjs` mirrors it.
- **Test scenarios:** (a) explore enabled + stub driver returns captures →
  `report.explore.steps`/`captures` populated, verdict untouched; (b)
  `goto` throws → `skipped` reason, run exit code unaffected by explore;
  (c) `explore.enabled` false → no `report.explore`; (d) no test files +
  explore enabled → explore still runs and reports; (e) comment renders the
  explore summary line and capture rows; (f) run totals include explore
  vision spend.
- **Verification:** `npm run typecheck` + `npx vitest run tests/unit/cli.test.ts tests/unit/comment.test.ts`.

### U3. Driver-level and docs

- **Goal:** The browser-facing half is exercised against a real page, and the
  feature is documented where users configure it.
- **Requirements:** R1, R3, R9 (end-to-end evidence)
- **Files:** `tests/unit/explore-driver.test.ts` (new — fixture-server
  pattern, gated like existing driver tests), `docs/quickstart.md`
  (explore act section), `src/cli.ts` init template `explore` comment
  (already lists `enabled`/`maxSteps` — add `budgetUsd` and one line on
  what act does), `ROADMAP.md` (mark E2.U4 complete if its status block
  tracks units)
- **Approach:** Extend the seeded-anomaly fixture page (the one U4a's
  capture tests use) or add a sibling page with an in-page link, a form that
  logs a console error on empty submit, and a nav target. Drive a short
  scripted `StubClient` sequence (navigate → click → type → done) through
  `ExploreLoop` against the real `BrowserDriver` to prove `Actions.navigate`,
  origin refusal, and capture collection end-to-end. Docs: one `explore`
  subsection update covering the act pass, budgets, the same-origin bound,
  and the non-destructive posture + disposable-target warning.
- **Test scenarios:** (a) scripted explore against fixture page yields
  `stopReason:'done'` and ≥1 capture; (b) scripted cross-origin navigate
  leaves `page.url()` unchanged; (c) config template comment mentions
  budgets (doc-shape check if a template test exists, else manual).
- **Verification:** `npx playwright install chromium` once if needed, then
  `npx vitest run tests/unit/explore-driver.test.ts` plus the repo-standard
  four-command pass.

## Verification Contract

Repository gates (`AGENTS.md`, in order):

- `npm run typecheck`
- `npm run lint`
- `npm run build` — `dist/` is committed; rebuilt output ships with the diff
- `npm test`

Unit-specific: `npx vitest run tests/unit/explore.test.ts` (U1),
`tests/unit/cli.test.ts tests/unit/comment.test.ts` (U2),
`tests/unit/explore-driver.test.ts` (U3 — requires
`npx playwright install chromium`).

Done means: an `explore.enabled` run with a reachable target produces
`report.explore` with steps, visited count, stop reason, spend, and captured
anomalies as `observed` evidence; an unreachable or disabled lane shows the
explicit skip; no explore outcome changes the run verdict or exit code.

## Definition of Done

- Global: all four repo gates pass; `dist/` rebuilt and committed; every
  requirement above is either implemented or explicitly deferred with the
  reason recorded in this section's spirit (none are deferred by default).
- U1: loop halts on every defined stop reason under test; no model output
  reaches the driver without the structural bounds.
- U2: `run.json` and the comment surface show the explore summary for both
  the ran and skipped cases; run totals account for explore spend.
- U3: real-browser test proves navigation + capture end-to-end; quickstart
  documents the lane and its safety bounds.
- Cleanup: no abandoned scaffolding, no dead prompt variants, no skipped
  tests committed.

## Risks & Dependencies

- **Model quality floors.** Cheap models may loop or propose unusable
  actions; the stall bound (R4) and per-step caps turn that into bounded
  waste, not a hang. Dogfood will show whether the charter needs tuning —
  recorded as a residual if it ships rough.
- **Side effects are real.** `click`/`type`/`navigate` on a live app can
  submit forms and create state. The prompt's non-destructive rule is a
  request, not a guarantee (R8 names page-side injection; the symmetric risk
  is the model choosing a destructive-but-legit-looking action). v1's answer
  is the documented "point explore at disposable targets only" posture;
  structural destructive-action detection is a deferred problem.
- **Depends on** U4a's capture plumbing (shipped in #97) and the U1 config
  strip (shipped) — both verified in-tree, no external dependencies.
- **Plugin mirror drift.** `a0-plugin-argus`'s `render_sticky_body` ports
  `sticky-comment.cjs`; the new explore fields need the same lockstep port —
  follow-up on the plugin repo, not this PR.

## Appendix — Research anchors

- `src/engine/loop.ts` — `VisionClient` iface (line ~29), `_callModel`
  ledger gate (~634), `_executeAction` dispatch (~825), `_parseAction`
  tolerant fallback (~665).
- `src/engine/actions.ts` — primitive surface to extend.
- `src/driver/browser.ts` — `captureErrors` taps (~142), `pageCaptures()`
  (~178), `goto` (~190), `Observation` (~53).
- `src/config.ts` — `Explore` iface (~63), `DEFAULT_EXPLORE` (~234),
  untrusted strip via `UNTRUSTED_CONFIG_KEYS` (~422).
- `src/cli.ts` — `launchDriver` capture wiring (~283), `attachCaptures`
  (~594), per-file loop (~643), `report.explore` assignment (~836), a0 heal
  block the explore phase precedes (~779).
- `src/report/run.ts` — `RunReport.explore` (~76); `src/report/comment.ts` —
  `exploreRows` (~91); `action/sticky-comment.cjs` — render mirror.
- `src/vision/ledger.ts` — `canSpend`/`recordCall`/`visionCostUsd`.
- `tests/fixtures/` — seeded-anomaly page pattern used by U4a driver tests.
