---
title: "feat: argus-reviewer full product roadmap"
created: 2026-09-09
origin: user request
---

# argus-reviewer full product roadmap

## Summary

argus-reviewer is a vision-first, BYOK, self-hosted E2E UI testing harness for GitHub PRs. It records plain-English flows, replays them from screenshot fingerprints, heals on UI drift, asserts page state, and posts a cost-aware PR comment. The codebase is functional but at "early development": there is no real end-to-end smoke test, the package is not on npm, and several user-facing surfaces still carry the legacy `vision-e2e` name. This plan sequences the remaining work into four phases: **core validation**, **rebrand and setup ease**, **package and publish**, and **hardening and scale**.

---

## Problem Frame

- The core engine (`src/engine/loop.ts`, `src/cache/fingerprint.ts`, `src/vision/ledger.ts`) is in place, but the only smoke test is a one-line placeholder (`tests/unit/smoke.test.ts`).
- The GitHub Action (`action/action.yml`) and sticky comment (`action/sticky-comment.mjs`) still reference `vision-e2e` in user-facing text, and the action is not exercised end-to-end.
- The package is not published to npm; consumers must install from `github:duketopceo/argus-reviewer`.
- The config/cache/report defaults still use `vision-e2e`, which is confusing after the product rename to `argus-reviewer`.
- There is no `init` or `setup` command; a new user must write `vision-e2e.config.ts` by hand.

The goal is to ship a reliable, installable, easy-to-set-up product and then harden it for multi-test suites and parallel runners.

---

## Requirements

- **R1.** The full record/replay/heal/assert loop must be validated end-to-end before public release.
- **R2.** The user-facing product surface must be fully rebranded from `vision-e2e` to `argus-reviewer` before the first npm release.
- **R3.** `argus-reviewer` must be installable via npm and runnable with a minimal setup path.
- **R4.** The GitHub Action must post a working, branded PR comment and commit status on a real PR.
- **R5.** The runner and CLI must support parallel, cost-capped execution at scale.

---

## Key Technical Decisions

- **KTD1. Self-hosted-first, not hosted cloud.** The first release targets BYOK OpenRouter and self-hosted GitHub Actions runners. A managed cloud option is out of scope for this roadmap.
- **KTD2. Rebrand before publish.** All `vision-e2e` config/cache/report/comment strings are renamed to `argus-reviewer` before the first npm publish so the public release does not immediately introduce a breaking rebrand.
- **KTD3. Keep the `td` API shape.** The existing `td.find(...).click()`, `td.type`, `td.pressKeys`, `td.assert`, `td.wait`, and `td.scroll` API is the stable test-facing DSL. New actions are out of scope.
- **KTD4. Playwright Chromium only.** Multi-browser support is deferred; the first release pins Chromium to keep 1:1 screenshot-to-coordinate mapping deterministic.
- **KTD5. npm package `argus-reviewer-e2e`, CLI bin `argus-reviewer`.** This matches the current `package.json` and the `npx` invocation.

---

## Scope Boundaries

### In scope

- End-to-end validation of the record/replay/heal/assert loop.
- Full `vision-e2e` to `argus-reviewer` rebrand of user-facing strings and defaults.
- npm package release and GitHub Action hardening.
- Setup friction reduction (config scaffolding, docs).
- Replay/heal/assertion hardening and parallel test execution.

### Out of scope

- Multi-browser support (WebKit/Firefox).
- A hosted or managed cloud service.
- Non-OpenRouter model providers.
- IDE extensions or CI providers other than GitHub Actions.

---

## Implementation Units

### U1. Phase 1 — Real end-to-end smoke test

**Phase:** 1 — Core validation

**Goal:** Replace the placeholder `tests/unit/smoke.test.ts` with a real record-to-run-to-assert test on `tests/fixtures/index.html` that also exercises the heal path.

**Requirements:** R1

**Dependencies:** None

**Files:**
- `tests/unit/smoke.test.ts`
- `tests/fixtures/index.html`
- `src/cli.ts`
- `src/engine/loop.ts`

**Approach:** Extend the fixture page with a button, a text input, and a hidden state. Add a Vitest test that invokes the CLI `record` and `run` commands to record a flow, then perturb the button location and assert that the run still passes via the heal path. Use a mock `VisionClient` for offline unit tests and the real OpenRouter client only for an opt-in integration test.

**Patterns to follow:** The existing `tests/unit/cli.test.ts` pattern of driving `main(argv, deps)` with injected outputs and a temp directory.

**Test scenarios:**
- Happy path: record "click the button" on the fixture, then `run` the generated test and it passes with zero or one vision calls.
- Edge case: move the button 50px and re-run; the engine heals the step and passes.
- Error path: run with an empty or invalid config and the CLI exits with a clear error.

**Verification:** `npm run test` passes; the new smoke test is not skipped; the run report shows 1 passed test and one healed step.

---

### U2. Phase 1 — Release-ready GitHub Action

**Phase:** 1 — Core validation

**Goal:** Make the composite action work end-to-end on a real PR, including the `argus-reviewer` PR comment and commit status.

**Requirements:** R4

**Dependencies:** U1

**Files:**
- `action/action.yml`
- `action/sticky-comment.mjs`
- `src/report/run.ts`
- `src/report/comment.ts`

**Approach:** Update the sticky-comment sentinel and report `tool` field from `vision-e2e` to `argus-reviewer`. Add an example consumer workflow in `examples/` or `.github/workflows/` that a user can copy. Validate that `npx argus-reviewer run` exits 0 and the action posts or updates a PR comment.

**Patterns to follow:** Keep the existing `SENTINEL` comment-finding behavior; only change the marker string. The `vision-e2e` to `argus-reviewer` rebrand here is a pure string substitution in the report and comment renderer.

**Test scenarios:**
- Happy path: run the action in a test repo with a valid `argus-reviewer.config.ts` and it posts a `## argus-reviewer ✅ PASS` comment.
- Error path: missing `OPENROUTER_API_KEY` produces a neutral status and a skipped comment.
- Integration: an existing PR comment with the old `<!-- vision-e2e -->` sentinel is either updated or left as a legacy artifact while a new `<!-- argus-reviewer -->` comment is posted.

**Verification:** A test PR receives the sticky comment and a green commit status.

---

### U3. Phase 2 — Full `vision-e2e` rebrand

**Phase:** 2 — Rebrand and setup ease

**Goal:** Remove all product-facing `vision-e2e` strings and rename config/cache/report defaults to `argus-reviewer`.

**Requirements:** R2

**Dependencies:** U2

**Files:**
- `src/config.ts`
- `src/cli.ts`
- `src/driver/browser.ts`
- `src/report/run.ts`
- `src/report/comment.ts`
- `action/action.yml`
- `action/sticky-comment.mjs`
- `runner/register-runner.sh`
- `runner/README.md`
- `README.md`
- `tests/unit/*.test.ts`

**Approach:** Replace the `vision-e2e.config.ts` default with `argus-reviewer.config.ts`, the `.vision-e2e-cache` default with `.argus-reviewer-cache`, `vision-e2e-report` with `argus-reviewer-report`, and temp-dir prefixes. Update the runner labels and docs. Update tests to use the new defaults. Add a one-release compatibility warning if an old `vision-e2e.config.ts` is detected, or document a one-time migration in `README.md`.

**Patterns to follow:** Centralize the default filenames in `src/config.ts` so the strings are not duplicated across `src/cli.ts` and `action/action.yml`.

**Test scenarios:**
- Happy path: `argus-reviewer run` discovers `argus-reviewer.config.ts` and writes to `.argus-reviewer-cache`.
- Edge case: old `vision-e2e.config.ts` is detected and either auto-migrated or prints a clear migration message.
- Error path: missing config still falls back to defaults and warns the user.

**Verification:** `grep` for `vision-e2e` in `src/`, `action/`, `tests/`, and `runner/` returns only intentional history/compat references; `npm run test` passes.

---

### U4. Phase 2 — Setup/init CLI

**Phase:** 2 — Rebrand and setup ease

**Goal:** Add a one-command setup path that scaffolds a config file and an example test.

**Requirements:** R3

**Dependencies:** U3

**Files:**
- `src/cli.ts`
- `README.md`
- `tests/unit/cli.test.ts`

**Approach:** Add `argus-reviewer init` (or `setup`) that prompts for target URL, OpenRouter model, budget, and writes `argus-reviewer.config.ts` plus a `tests/landing.test.ts` example. Support `--yes` to accept defaults.

**Patterns to follow:** Use the existing `parseArgs` path and the existing `resolveConfig` defaults. Keep prompts short and non-blocking in `--yes` mode.

**Test scenarios:**
- Happy path: `argus-reviewer init` writes a working config and example test.
- Edge case: `argus-reviewer init --yes` uses the default Google/Moonshot models and a local target URL.
- Error path: `argus-reviewer init` in an existing config directory asks before overwriting.

**Verification:** A new contributor runs `npm i -D argus-reviewer-e2e && npx argus-reviewer init` and can `npx argus-reviewer record` in under five minutes.

---

### U5. Phase 3 — npm publish and release automation

**Phase:** 3 — Package and publish

**Goal:** Ship `argus-reviewer-e2e` to npm and automate future releases.

**Requirements:** R3, R4

**Dependencies:** U4

**Files:**
- `package.json`
- `package-lock.json`
- `.github/workflows/release.yml` (new)
- `README.md`
- `CHANGELOG.md` (new)

**Approach:** Create a release workflow that runs tests, builds `dist/`, publishes to npm on git tags, and updates the composite action examples to point to the released version. Add a `prepublishOnly` script that ensures `dist/cli.js` exists and is executable. Pin the `playwright` version and document the install path.

**Patterns to follow:** Use the existing `prepare` script for the build step. Keep the workflow minimal (test, build, tag, publish) and avoid pre-release branches unless requested later.

**Test scenarios:**
- Happy path: `npm publish --dry-run` passes and the package contains `dist/`, `action/`, and `README.md`.
- Integration: installing `argus-reviewer-e2e` from npm and running `npx argus-reviewer --help` works in a fresh directory.
- Error path: a release with failing tests or a dirty working tree is blocked by the workflow.

**Verification:** A real or test npm install of `argus-reviewer-e2e` succeeds and `npx argus-reviewer --help` prints the new usage.

---

### U6. Phase 4 — Heal/assertion hardening

**Phase:** 4 — Hardening and scale

**Goal:** Reduce flaky failures and improve the usefulness of `td.assert` and heal events.

**Requirements:** R1, R5

**Dependencies:** U5

**Files:**
- `src/engine/loop.ts`
- `src/engine/prompts.ts`
- `src/report/comment.ts`
- `tests/unit/loop.test.ts`

**Approach:** Add retry/escalation for `td.assert`, richer assertion prompts, and `healEvent` detail in the PR comment. Add a `maxHeals` or `healBudget` guard so a single run cannot spiral on a broken UI.

**Patterns to follow:** Re-use the existing `escalation_model` fallback pattern in `src/vision/openrouter.ts` and the existing `Ledger.canSpend` budget check.

**Test scenarios:**
- Happy path: a healed step is recorded and shown in the PR comment with the new element description.
- Edge case: a flow with more than `maxHeals` mismatches is stopped early with a budget message.
- Error path: an assertion with an ambiguous question is retried with the escalation model and returns a clear `pass`/`fail` verdict.

**Verification:** A real PR with a small UI change shows exactly one heal and the assertion still passes.

---

### U7. Phase 4 — Parallel execution and runner scaling

**Phase:** 4 — Hardening and scale

**Goal:** Run multiple test files concurrently and support a pool of self-hosted runners.

**Requirements:** R5

**Dependencies:** U5

**Files:**
- `src/cli.ts`
- `src/cache/store.ts`
- `runner/register-runner.sh`
- `runner/README.md`

**Approach:** Use `Promise.allSettled` for independent test files in `cmdRun`, with per-test directories for videos and reports. Document runner label naming (`argus-reviewer`) and a matrix workflow that fans out tests across runners. Ensure each test gets an isolated browser context and does not share cache state.

**Patterns to follow:** The existing `discoverTestFiles` and `runReport` aggregation in `src/cli.ts` is the integration point. The runner labels already exist; only the documentation and example commands need updating.

**Test scenarios:**
- Happy path: two independent test files run in parallel and produce separate `run.json` reports.
- Edge case: two parallel runs targeting the same app do not share mutable state (separate browser contexts, separate cache dirs).
- Error path: one failing test does not abort the other tests.

**Verification:** A suite of 3+ test files completes in less than the sum of individual run times; the final PR comment aggregates all results.

---

## Risks & Dependencies

- **OpenRouter cost variability.** The ledger and budget cap are the primary mitigations. Additional cost alerts are a future consideration.
- **Self-hosted runner friction.** Consumers must install Playwright Chromium with system deps. The first mitigation is documentation and `runner/register-runner.sh`.
- **Rebrand breaking early users.** The only early users are the repo itself; rebrand before npm publish minimizes breakage.
- **Vision model brittleness.** Coordinate grid, prompt wording, and screenshot quality are the main levers. The escalation model and grounding specialist are already in place.
- **npm package name `argus-reviewer-e2e`.** If a different name is desired, it should be decided before Phase 3.

---

## Open Questions

- Should the first release support a GitHub-hosted `ubuntu-latest` runner, or stay self-hosted only?
- Do we keep `vision-e2e.config.ts` as a deprecated alias for one release, or cut over cleanly?
- What is the target pricing model? (Free open-source, per-seat, BYOK only, etc.) This affects whether a hosted cloud is ever built.

---

## Acceptance Examples

- A new user installs `argus-reviewer-e2e`, runs `npx argus-reviewer init`, records a flow, opens a PR, and the check posts `argus-reviewer ✅ PASS`.
- A UI change in the PR causes a single heal, and the PR comment lists the healed step with the model that re-grounded it.
- A suite of five test files runs in parallel across two self-hosted runners, and the total wall time is less than the sum of individual run times.
