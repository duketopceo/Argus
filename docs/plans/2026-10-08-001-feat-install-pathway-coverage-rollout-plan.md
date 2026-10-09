---
title: "feat: install pathway go-live + coverage-gap closure + consumer rollout"
type: feat
status: draft
date: 2026-10-08
depth: standard
mode: solo
origin: docs/plans/2026-10-04-0002-feat-github-app-onboarding-plan.md
---

# feat: install pathway go-live + coverage-gap closure + consumer rollout

## Summary

Three converging follow-throughs after v0.5.0:

1. **Coverage honesty** — `app/worker/` ships 63 green tests that no CI leg
   runs; `e2e/smoke.test.ts` is a live td-DSL dogfood target that looks like
   an orphaned vitest file; the Electron views only reach assertions through
   the dashboard smoke script. This is the repo's documented failure class:
   a green signal covering nothing.
2. **Install pathway go-live** — the GitHub App code path is fully in-tree
   (`app/worker` webhook → `onboard.ts` → scaffold PR; `app/register`
   manifest flow) but nothing is deployed and docs still say "planned".
   Finish it: deploy the worker, register the App, install it, flip the docs.
3. **Consumer rollout + roadmap** — kurultai (`75492b8`, pre-v0.4.x), wisp
   (`119cacd`, #107-era), and Pace-Server (v0.4.2) run stale action pins;
   the onboarding plan's status block and the competitive candidate list
   need reconciling with what actually shipped.

## Problem frame

Per STRATEGY.md track 1 (proof & adoption) and the onboarding plan's verdict
(origin doc): the App is a thin onboarding and identity layer, never compute,
never key custody. The code honors that — what remains is operational
(deploy, register, document) plus the coverage gaps found on 2026-10-08.

Learnings that shaped this plan (see `docs/solutions/`):

- `git-diff-path-header-config-evasion` — the canonical "green but covered
  nothing" failure; the fix pattern is an assertion that the covered set is
  non-empty, not just fixing the instance.
- `deterministic-post-parse-filters-and-verdict-derivation` — a pass signal
  must derive from work that provably ran.
- `dataset-commit-fields-verify-against-live-api` — capture-time fields rot;
  strict-parse webhook payloads at the boundary.

## Requirements

- R1. `app/worker` tests and typecheck run in CI and fail PRs when broken.
- R2. An invariant check fails when a `*.test.ts` file exists outside the
  vitest glob without being on a documented non-vitest allowlist — the class
  of bug, not just the instance (learnings: pin the invariant).
- R3. `e2e/smoke.test.ts` is correctly labeled as a td-DSL dogfood target so
  no future agent deletes or moves it into the vitest glob (which would
  break the suite — `td` is undefined there).
- R4. Electron views gain behavioral assertions through the existing
  dashboard-smoke fixture — no new test dependency (no jsdom).
- R5. A deployed worker + registered (duketopceo-owned) App such that
  installing the App on a repo opens the onboarding PR end-to-end.
- R6. README, `docs/onboarding.md`, and `SECURITY.md` describe the live
  state, not "planned".
- R7. kurultai, wisp, and Pace-Server pin `duketopceo/Argus/action` at
  `27887be…` (v0.5.0).
- R8. Roadmap reflects reality: the onboarding plan's stale status block is
  corrected, and the competitive candidates (positioning verify, reflection,
  bundling, walkthrough, config mining) are scheduled or explicitly deferred.

## Key technical decisions

- **KTD1. Worker CI is a separate always-run job in `ci.yml`** via
  `npm --prefix app/worker ci && run typecheck && test` (pattern precedent:
  `argus-reviewer.yml:63` `npm --prefix $TRUSTED_ARGUS_DIR ci`). No path
  gating — the suite runs in ~250ms; a gated check silently rots on the PRs
  that skip it, recreating the exact failure this fixes. Includes the
  `dry-run` step only if `wrangler deploy --dry-run` verifies unauthenticated
  at implementation time.
- **KTD2. The coverage invariant is a unit test inside the glob.**
  `tests/unit/test-coverage-glob.test.ts` globs the repo for `*.test.ts`
  outside `tests/` and asserts each hit is on an explicit allowlist
  (`e2e/`, `evals/`, `app/worker/test/`, `examples/`, `tests/fixtures/`).
  A new non-vitest test file fails the suite with a pointer to either move it
  or extend the allowlist.
- **KTD3. `e2e/smoke.test.ts` stays, relabeled.** It is the configured
  `testsDir: 'e2e'` dogfood target (root `argus-reviewer.config.ts:11`,
  `eslint.config.js:30` grants the `test`/`td` globals). Fix is a header
  comment + one line in AGENTS.md — moving it under `tests/` would put it
  inside the vitest glob and break `npm test`.
- **KTD4. Worker URL: `workers.dev` for go-live.** Flip
  `workers_dev = true` in `wrangler.toml`, deploy manually with `wrangler`,
  set the three secrets (`APP_ID`, `WEBHOOK_SECRET`, `PRIVATE_KEY`). A custom
  route (`argus.<domain>/webhook`) is deferred — it needs a zone decision and
  adds nothing for install correctness. Keep `preview_urls = false`.
- **KTD5. App registered under `duketopceo`, private first.**
  `manifest.mjs` hardcodes `public: false` — correct while only our own
  repos install it; flipping to public is a one-line change at launch (the
  X-post moment), not a registration do-over. Org ownership deferred —
  Marketplace needs a verified publisher org anyway (origin Q1/Q9).
- **KTD6. Deploy is manual; CI deploy deferred.** A `wrangler deploy`
  workflow needs a `CF_API_TOKEN` secret decision — follow-up, not a blocker.
- **KTD7. Consumer pin bumps as one PR per repo.** Branch protection on all
  three requires PRs; the diff is two lines (SHA + comment).
- **KTD8. Roadmap = status correction + candidate scheduling.** Update the
  onboarding plan's `## Status` block (U1–U7 are merged, not "in review"),
  and add a scheduling section to the competitive roadmap covering the five
  pending candidates with their eval gates.

## Open questions

- Q1. Is there an existing Cloudflare account/workers.dev subdomain on this
  machine, or does `wrangler` need `wrangler login` first? (Execution-time
  discovery in U5; `omaseal` may carry a token.)
- Q2. Flip the App `public` at registration or at launch? Plan assumes
  private → flip at launch.
- Q3. Hosted key custody acknowledgment (origin Q5): the worker holding the
  App private key means the maintainer owns rotation/incident response.
  Proceeding assumes accepted — that's what "hosted install" means.

## Scope boundaries

In: CI wiring, coverage invariant, e2e label, dashboard-smoke view
assertions, worker deploy, App registration, docs flip, consumer pin PRs,
roadmap reconciliation.

Deferred to follow-up work: CI deploy workflow for the worker (needs
`CF_API_TOKEN`), custom route/domain, `public: true` flip, Phase 3 token
broker + check-run input (origin U8/U9 — separate threat review), deferred-
repo retry queue, `repository_selection: all` fan-out, `setup_url` landing
page, Marketplace listing, install telemetry (promised never).

## Implementation units

### U1. Worker CI leg

**Goal:** `app/worker` tests + typecheck gate every PR.
**Requirements:** R1.
**Files:** `.github/workflows/ci.yml`; optionally `AGENTS.md` (one line noting
the worker suite runs in its own leg).
**Approach:** Add a `worker` job: `actions/checkout`, `setup-node` (Node 22,
`cache: npm` with `cache-dependency-path: app/worker/package-lock.json`),
`npm --prefix app/worker ci`, `npm --prefix app/worker run typecheck`,
`npm --prefix app/worker test`. Always-run, no path filter (KTD1).
**Patterns to follow:** `npm --prefix` in `argus-reviewer.yml:57-63`; the
single `test` job in `ci.yml`.
**Test scenarios:** Test expectation: CI-shape change — verify by the leg
running green on the unit's own PR; verify it *fails* by a temporary
deliberate break if cheap, else rely on the suite being live.
**Verification:** `worker` check appears and passes on the PR; breaking a
worker test fails the PR.

### U2. Test-glob coverage invariant

**Goal:** a `*.test.ts` file outside `tests/` that isn't a documented
non-vitest target fails the suite.
**Requirements:** R2, R3 (invariant half).
**Files:** `tests/unit/test-coverage-glob.test.ts` (new).
**Approach:** Glob `**/*.test.ts` minus `tests/**`, `node_modules/**`,
`dist/**`; assert every result is under `{e2e/, evals/, app/worker/test/,
examples/, tests/fixtures/}`; failure message names the file and the fix.
**Patterns to follow:** `scripts/check-tmp-leaks.mjs` (repo-wide invariant
script shape); `tests/unit/secrets.test.ts` (pin-the-invariant precedent per
the gitconfig learning).
**Test scenarios:** Allowlisted paths pass; a synthetic non-allowlisted path
would fail (assert the checker's own logic on a fixture list, not by writing
a real orphan).
**Verification:** `npm test` green; the test itself fails when the allowlist
check is fed a foreign path.

### U3. `e2e/smoke.test.ts` labeling

**Goal:** the file is unmistakably a td-DSL dogfood target.
**Requirements:** R3.
**Files:** `e2e/smoke.test.ts` (header comment), `AGENTS.md` (one line in the
"Things that are true and look wrong" section).
**Approach:** Header: "td-DSL dogfood target for `argus run`
(`testsDir: 'e2e'` in root config). NOT vitest — do not move under `tests/`."
**Test scenarios:** Covered by U2's invariant (it must appear on the
allowlist).
**Verification:** comment + AGENTS.md line present; `npm test` green.

### U4. Electron view assertions

**Goal:** views gain behavioral coverage through the existing smoke fixture.
**Requirements:** R4.
**Files:** `tests/e2e/dashboard-smoke.mjs`, possibly
`scripts/qa/dashboard-fixture.mjs` (new seeded states if needed).
**Approach:** Extend `dashboard-smoke.mjs` with per-view assertions: runs
list row states, repo view rendering, spend view ledger rows, heals view
entries — all through the `seededState`/`partialState` fixtures and the
installed `window.argus` stub. No jsdom.
**Patterns to follow:** the existing ~60 checks in that file.
**Test scenarios:** Each view renders populated rows from `seededState`;
each view renders its empty state from `emptyState`; error path from
`reject` fixture.
**Verification:** `npm run smoke:dashboard` passes locally and in the
existing CI step.

### U5. Worker deployment

**Goal:** `argus-app-worker` serves `POST /webhook` at a stable URL.
**Requirements:** R5 (deploy half).
**Files:** `app/worker/wrangler.toml` (`workers_dev = true`); deployment note
in `docs/self-host-app.md` if the hosted steps differ.
**Approach:** one sequence across U5+U6: `wrangler deploy` first to obtain
the `*.workers.dev` URL, then register the App (U6's manifest flow needs the
URL), then `wrangler secret put` for the three secrets, then install.
Optionally add `dry-run` to U1's job if unauthenticated.
**Dependencies:** secrets can't be set until the App exists, but they gate
nothing in the deploy itself — deploy → register → secrets → install.
**Test scenarios:** `curl -X POST <url>/webhook` with a bad signature → 401;
GET/other paths → 404/405; `X-GitHub-Delivery` replay handled.
**Verification:** webhook endpoint live and fail-closed.

### U6. App registration + first installs

**Goal:** a duketopceo-owned GitHub App exists; installing it opens
onboarding PRs.
**Requirements:** R5 (App half), R7.
**Files:** `app/register/manifest.mjs` (only if `public:` or naming needs a
flag for the maintainer flow); no repo code changes expected beyond docs.
**Approach:** `node app/register/manifest.mjs --worker-url <deployed URL>
--html /tmp/register.html`; open the form, register under `duketopceo`,
convert the manifest code (documented in `docs/self-host-app.md`), set the
three worker secrets, install the App on Argus itself + one consumer repo to
prove the path, then the rest.
**Known v1 limits to keep/disclose:** `repository_selection: all` delivers
no repo list → no-op; >~3–4 fresh repos per delivery → `deferred` with no
retry queue (re-add or `init --pr` are the remedies).
**Test scenarios:** Onboarding PR appears on an installed repo with the
scaffold files + secrets checklist; installing on an already-onboarded repo
is a no-op (`pr-exists`/`already-onboarded`); fork/archived skip.
**Verification:** a real `argus/onboarding` PR opened by the App on at least
one repo; merged state optional.

### U7. Docs reality flip

**Goal:** docs say what exists, not what was planned.
**Requirements:** R6.
**Files:** `README.md` (:47 "planned and not available yet" → install link),
`docs/onboarding.md` (:3, :41, :49 "not built" → live path + self-host path),
`SECURITY.md` (:28 "(planned)" → the live boundary statement),
`docs/self-host-app.md` (hosted-vs-self-host positioning line if needed).
**Approach:** Path order in onboarding doc becomes: App install (one click)
→ `init --pr` → plain `init` → self-hosted App. Keep the v1 limit
disclosures from U6.
**Test scenarios:** none — docs. Links resolve.
**Verification:** no doc still claims "not built" for a shipped path.

### U8. Consumer pin bumps

**Goal:** kurultai, wisp, Pace-Server run v0.5.0.
**Requirements:** R7.
**Files (per repo):** `.github/workflows/argus-reviewer.yml` (kurultai,
Pace-Server), `.github/workflows/argus.yml` (wisp) — `uses:` SHA +
version comment only.
**Approach:** One PR per repo: pin `27887be6438ad284566073835939210edc4cdeb8 # v0.5.0`.
Pace-Server's comment explains its pin already; update to match.
Optionally also install the App on these repos (U6) instead of hand-editing —
but the pin bump is a separate concern from onboarding (they're already
onboarded); do both.
**Test scenarios:** none — pin bumps; each repo's own CI + reviewer lane
runs on the PR.
**Verification:** each repo's next review run uses the v0.5.0 action
(nit fold active).

### U9. Roadmap reconciliation

**Goal:** plan docs and STRATEGY tracks reflect reality.
**Requirements:** R8.
**Files:** `docs/plans/2026-10-04-0002-feat-github-app-onboarding-plan.md`
(status block: U1–U7 done, U8–U9 deferred/optional),
`docs/plans/2026-10-04-0003-feat-competitive-roadmap-plan.md` (schedule or
defer: positioning verify [U4a — partially shipped], reflection pass
[U4b — eval-gated], file bundling [U4c], walkthrough paragraph,
emit-path-instructions mining [blocked on feedback data]), `STRATEGY.md`
tracks if the ordering changed.
**Approach:** Status edits only where verified against git; competitive
candidates keep their eval gates — none ship on competitor parity alone
(per `docs/competitive-review.md` adoption rule).
**Test scenarios:** none — docs.
**Verification:** no stale "in review" units on merged work; every pending
candidate has an eval gate or an explicit defer reason.

## Security section

| Threat | Mitigation |
|---|---|
| Worker holds the App private key | Key lives only in `wrangler secret`; never in the repo or logs (`redact.ts`); rotation steps in `docs/self-host-app.md`; custody is the accepted trade-off for hosted install (Q3) |
| Forged webhook | HMAC-SHA256 constant-time verify, 401 before parsing — already implemented + tested; U5 verifies live fail-closed behavior |
| Coverage-invariant gamed | Deleting the invariant file removes the check itself — detectable only through review; the residual is reviewers noticing a deleted test in the diff |
| Consumer pin bumps bypass review | PRs on protected branches; their own CI + reviewer lane runs |
| `workers.dev` URL enumeration/abuse | Worker only accepts `POST /webhook` with valid signature; unsigned hits get 401 — no open endpoint |

## Deferred implementation notes

- Whether `wrangler deploy --dry-run` runs unauthenticated (decides the
  optional U1 step).
- The actual `workers.dev` subdomain (depends on the account).
- If Cloudflare auth isn't on this machine, U5 pauses until `wrangler login`
  or a `CF_API_TOKEN` lands in omaseal — flag early rather than mid-PR.
