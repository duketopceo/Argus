# Changelog

All notable changes to argus-reviewer are documented here. The project is
pre-1.0; breaking changes may ship without a major bump until `1.0.0`.

## [0.4.2] — 2026-10-04

Onboarding and reviewer throughput. `init --pr` opens a ready-to-merge
onboarding PR on your repo, large diffs review in chunks, and a default
spend cap makes runaway cost opt-in rather than default.

### Added
- **`argus-reviewer init --pr`** — scaffolds the workflow on a branch and
  opens an onboarding PR with the secrets checklist, what-is-sent statement,
  and how to stop (#125, App plan U1–U3). `docs/onboarding.md` covers the
  CLI / App / self-hosted-App paths (#126).
- **Chunked review and OpenRouter batch mode** — large diffs review in
  chunks; the batch lane uses a separate model and a configurable request
  timeout (#121, #124).
- **GitHub App webhook worker** (`app/worker/`) — signature verification,
  replay guard, single-repo installation token, and an onboarding PR opened
  on installation events; self-host deploy guide and manifest registration
  (#131, #134, #135).
- **Default budget cap** — $1 per-run spend cap; explicit `0` means
  unlimited (#127).
- Reviewer bake-off eval harness and report under `evals/reviewer-bakeoff/`
  (#123).

### Fixed
- `action.yml` parse failure since v0.4.0 — descriptions containing `': '`
  are now quoted (#133).
- Test temp files are isolated in a per-run TMPDIR removed at teardown;
  cleanup binds to the creating test, and the leak check spawns vitest's
  JS entry so it also works on Windows (#136).

### Docs
- The OCR static-lane plan recorded its dry run: the kill criterion tripped
  (the tool hung on a one-file scan) — **do not integrate** (#137).

## [0.4.1] — 2026-10-04

### Fixed
- The `init` scaffold's `duketopceo/Argus/action@` pin now references the
  v0.4.0 release commit as a full 40-char SHA, so newly scaffolded
  workflows run the action that includes the v0.4.0 finding-quality
  filters — not the pre-release pin the 0.4.0 tarball shipped with.
- Internal rename `TestDriverApi` → `UiDriverApi` (no behavior change).

## [Unreleased]

### Changed
- **Every run is capped at $1 by default.** `budgetUsd` now resolves to `1`
  (USD per run) instead of unset, and `codeReviewBudgetUsd` follows it unless
  set. Before, a repo without the init scaffold ran uncapped. The cap covers
  realtime review chunks, synthesis, the flow (vision) lane, explore, the app
  lane, and triage/secrets decisions. Raise it with `budgetUsd: 5` in config,
  `ARGUS_BUDGET_USD=5`, or the action input `budget-usd: 5`. Disable it
  explicitly with `0` (`budgetUsd: 0`, `ARGUS_BUDGET_USD=0`, `budget-usd: 0`);
  uncapped runs log `warning: spend cap disabled ... UNCAPPED`. Invalid or
  negative values keep the $1 cap. Untrusted PR config cannot change the cap.
  Batch review (`review.mode: batch`) now sizes the batch against the
  remaining budget before submitting: a conservative token-based estimate
  trims the batch to the chunks that fit, and the rest run realtime with the
  per-chunk gate (a batch cannot be stopped once submitted). The run summary
  line now reads `total $X of $Y budget`.
- **Default review models changed** (from the reviewer model bake-off, #123).
  Realtime `code_model` is now `deepseek/deepseek-v4-flash` (was
  `deepseek/deepseek-v4.1-flash`): about $0.0001 per demo review, recall 1.00
  and precision 0.93 there, but noisier on real code (about 27% of findings
  judged valid), so the validate step and severity gating stay on. Batch mode
  now uses `deepseek/deepseek-v4.1-flash:batch` (62% judged valid). If you rely
  on the default model, pin the old one with `code_model:
  'deepseek/deepseek-v4.1-flash'` (or `ARGUS_CODE_MODEL`) and set
  `review.requestTimeoutMs: 600000`, since it exceeds the 120 s default
  timeout in realtime. Batch is recommended for large PRs.

### Added
- `review.requestTimeoutMs` / `ARGUS_REQUEST_TIMEOUT_MS`: per-request OpenRouter
  timeout (integer ms, 1 to 900000, default 120000). Invalid values are a
  usage error.
- `review.batchModel` / `--batch-model` / `ARGUS_BATCH_MODEL`: separate model
  for batch mode. Unset, it derives `<code_model>:batch` for models known to
  have a batch endpoint, else `deepseek/deepseek-v4.1-flash:batch`.
- Chunked review for large PRs: files are grouped by directory, oversized
  files split at hunk boundaries, the run stops before a chunk the budget
  cannot cover, and the summary says how many chunks and files were reviewed.
- `review.mode: 'batch'` (also `--mode batch`, `ARGUS_REVIEW_MODE`): review
  through OpenRouter's async Batch API with automatic realtime fallback.
- `code-review --base <ref>` reviews a local merge-base→worktree diff with
  no PR and no posting; the report names the reviewed range and head binding
  is marked `local`. `config.diffBase`/`ARGUS_DIFF_BASE` supply the default
  only when no PR context exists (#151, #163).
- Incremental review on `pull_request` and `@argus review` re-runs: only
  commits since the last *verified* reviewed head are re-diffed. The sticky
  comment carries an `argus:last-reviewed-sha` marker; a stored SHA counts
  only when the compare API proves it an ancestor of the current head and
  the repo's own `argus-reviewer` commit status exists there — forged,
  equal, unreachable or truncated baselines fall back to the full diff.
  `@argus review full` / `--full` / `ARGUS_REVIEW_FULL=1` forces a full
  re-review (#147, #165).
- `@argus fix` opens a PR applying every posted, still-valid inline
  suggestion: comments are re-read from the API, bound to the current head
  commit and Argus's own author login, re-validated against the live diff,
  and committed to `argus/fix-<pr>-<head8>` onto the PR's head branch. The
  head is re-verified before the PR opens; rotated anchors and oversized
  spans are skipped and named. Fork PRs are refused (#148, #166).
- `review.instructions[]` per-glob rules injected into the chunks that carry
  matching files, plus `ARGUS_REVIEW_INSTRUCTIONS` (JSON) and the
  `review-instructions` action input for lanes where PR config never runs
  (#149, #164).
- `run --keep-alive [--keep-alive-ttl <sec>]` and `verify --keep-alive`
  hold a failed lane's argus-booted target for a bounded window so it can be
  inspected in a headed browser; interactive terminals only, CI prints a
  skip line (#146, #162).
- `--generate-tests` / `@argus generate` authors spec coverage from the PR
  diff into a reviewable PR on `argus/generated-tests-<head8>`; on the
  pull_request lane specs are sandbox-validated green first, on the mention
  lane they ship marked unvalidated (#146, #161).
- Flow heal write-back: `flow.healWriteback: 'pr'` / the `heal-writeback`
  action input proposes each model-relocated step back to the repo on
  `argus/flow-heals-<sha7>` — relocation fields only; a heal that rewrote
  the instruction, action kind, text, keys or timing is suppressed (#144, #160).

## [0.4.0] - 2026-10-03

A redesign and a quieter reviewer. Argus now looks and reads the same
everywhere, and review comments carry fewer false alarms.

### Changed
- **One visual language everywhere.** The PR comment, inline review
  comments, commit status, CLI output, terminal UI, desk app and the
  offline `report.html` share one emoji-free design: the same words, the
  same severity labels, the same layout. Evidence reports open offline
  with no network requests.
- **Readable errors.** CLI failures are classified with a stable code, a
  plain summary and a fix line saying what to run next. With `--json`, the
  error is printed as one JSON object on stdout (it used to go to stderr),
  so a pipe captures it.
- **Quieter reviewer.** Files that are generated or fixtures are skipped by
  default (`review.exclude` changes the list), findings that point outside
  the diff are dropped, and findings
  in test files are capped so they cannot crowd out real issues.
- **Spend confirmations.** Paid eval runs show the estimated cost and ask
  before spending anything, in the CLI and in the terminal UI.
- Inline review comments use a new format. Comments posted by older
  versions are still recognised, so upgrading does not repost them.

### Added
- Brand assets: logo, mark and social images, with a reproducible
  `npm run brand` build.
- A new README with a hero image and demo recordings.
- A launch film, "The witness", under `launch/` in the repository. It is
  not part of the npm package.
- `docs/github-app.md` + a commented opt-in block in the `init` scaffold:
  create and install your own GitHub App so Argus can submit APPROVE /
  REQUEST_CHANGES — token minted per run via
  `actions/create-github-app-token`, no webhook, no hosted service. The
  scaffolded action pin now tracks the latest release.

### Notes
- The desk app and the terminal UI remain contributor tools in the
  repository. They are not shipped in the npm package.

## [0.3.1] — 2026-10-01

### Added
- `ARGUS_CODE_MODEL` env override for the review model (#96).

## [0.3.0] — 2026-09-30

### Added
- **CodeRabbit-style review surface** (#92): inline suggestions with
  `suggestion` blocks and a gated `REQUEST_CHANGES` verdict.
- **Formal GitHub review lane** (#91): Argus can submit an APPROVE /
  REQUEST_CHANGES review so its verdict satisfies
  `require_approving_reviews` (see `docs/approval-token.md`).
- **Head-bound four-lane verification** (#88): review, flow, app, and a0
  lanes all bind their verdict to the PR head SHA.
- `code-review --fixture <dir>` offline review against a local fixture.

### Fixed
- Budget float drift tripping the USD cap (#89).
- `cacheDir` default — `record` persisted nothing and wrote empty test
  files (#85).
- CI: `ARGUS_TRUSTED` scoped to non-PR events — the env override beats fork
  detection, so it must not be set on `pull_request` (#83).

### Docs
- README rewritten for clean install + onboarding (#86); AGENTS.md added
  (#90).

## [0.2.0] — 2026-09-21

### Added
- **Confidence model in every lane: triage, adjudication, probe targeting** (#70):
  - PR triage (`triage` report field): confidence-model pre-review signals,
    an area and risk classification that annotates and routes findings but
    never gates the deterministic severity verdict
  - Secrets adjudication (`secretsScan` report field): candidate secrets
    found in the diff are adjudicated by a decision model before surfacing
  - Finding adjudication: typed decision records for model verdicts,
    fail-open on decision-API errors
  - Probe targeting: the confidence model routes probe generation toward
    adjudicated findings
- `code-review --fixture <dir>`: review a local fixture repo
  (`argus-fixture-base` ref as merge base) — enables offline dogfooding
  and demos without a GitHub PR (#70)
- Review-only mode for `run`-less consumers: the action and CLI now
  support review-only invocation (#70)
- Live observability: `live.ndjson` event stream, `scripts/tail-live.mjs`
  watcher, scripted demo via `scripts/demo.mjs` (#70)
- `review` config block for confidence-model lane tuning (#70)

### Security
- **Config-execution trust gate** (#64, fixes #58): executable config
  (`argus-reviewer.config.ts` and variants) only loads when the checkout
  is trusted; untrusted checkouts run with `ARGUS_UNTRUSTED=1` and
  non-executable config only. Previously a hostile PR's config executed
  in the host process beside `OPENROUTER_API_KEY`/`GITHUB_TOKEN`

### Changed
- Open-source readiness: community health files, issue templates,
  Dependabot, CI Node 22/24 matrix (Electron 44 devDep requires ≥22.12)
  (#63)

## [0.1.3] — 2026-09-16

### Added
- **Sandbox probe lane (B.2)**: `code-review` can now generate and execute
  bounded regression probes for `not_exercised` blocking findings. Probes
  run in Docker (non-root, `--network none`, `--read-only`, cap-drop ALL,
  `no-new-privileges`, resource caps, digest-pinnable image) against both
  the PR head and the merge-base; evidence upgrades to `reproduced` only
  when head fails and base passes. Fork PRs require the `argus-probe`
  label bound to the head SHA and always run with `DEFAULT_SANDBOX`
  settings — PR-controlled image/limits/approval config is ignored.
  Opt-in via `sandbox.enabled` + action `sandbox` input (#59)
- Probe-lane results surface in the sticky comment (record count, per-probe
  outcome, skip reason) and the report JSON (#59)
- Probe authoring spend is folded into the shared cost/token ledger (#59)

### Fixed
- Merge-base for base-side probe runs is resolved via the compare API —
  `merge_base_sha` is null on the pulls payload and silently fell back to
  the base-branch tip (#60)
- Generated probe imports are containment-checked from the probe's actual
  write location; `..` escapes and `file:`/`data:` specifiers rejected,
  while legitimate `tests/ → ../src/x` imports still work (#60)
- Probe files are exclusively created (`wx`) — a generated probe can never
  overwrite a consumer's real test file (#60)
- Docker availability smoke check runs the full hardened profile, uses a
  300s timeout covering cold image pulls, and fails closed on spawn
  errors (#60)
- Probe stdout/stderr is control-character-stripped before entering
  comments/reports; node:test output pinned to TAP for stable failure
  classification (#60)

## [0.1.2] — 2026-09-15

### Added
- CI evidence linkage on `code-review` findings — findings carry
  check-run/workflow context where available (Phase B.1, #56)

### Fixed
- `init`-generated workflow now requests `issues: write` — without it the
  sticky comment upsert 403'd on first run (#57)

## [0.1.1] — 2026-09-12

### Fixed
- `.ts` config loading in CommonJS consumer projects: configs are always
  transpiled to ESM (written beside the config so relative imports and
  `node_modules` resolve normally) and `argus-reviewer-e2e` self-imports are
  rewritten to the installed package's real API module (#44)

## [0.1.0] — 2026-09-12

### Added
- Live NDJSON log (`<cacheDir>/live.ndjson`) tailed by the Electron dashboard's
  new Live Log card; `ARGUS_DEBUG` output streams there too (#40)
- Per-run "logs" button in the dashboard streaming `gh run view --log` (#40)
- `npm run app` — Electron dashboard for local observability (#39)
- `npm run watch` — local TUI for PRs, runs, evals, and journals (#38)
- Index-informed code review — context blocks for changed files (#36)
- Grounding → escalation-model fallback for locate (#37)
- Repo index, run journal, and diff-aware cache invalidation
- M3 code review: inline comments, `code_review.budgetUsd`, file chunking,
  severity filter, multi-stage review (#31–#34)

### Changed
- **Rebrand complete**: user-facing `vision-e2e` strings renamed to
  `argus-reviewer` — config default (`argus-reviewer.config.*`), cache dir
  (`.argus-reviewer-cache`), report dir (`argus-reviewer-report`), runner
  labels, DOM overlay ids. `vision-e2e.config.*` still loads as a legacy
  fallback (#8)
- Default review model is `deepseek-v4.1-flash` (#29)

### Fixed
- `liveLog` can no longer hang on Node >= 26 (non-recursive mkdir, atomic
  rotation) and `debug()` can no longer throw on BigInt/cyclic args (#40)
- Action: `cache-dependency-path` + `node-version` inputs — npm cache failed
  for consumers without a root package-lock.json

## [0.0.1] — unreleased baseline

Initial functional build: OpenRouter client with provider routing and a hard
budget cap, Playwright driver with pixel actions, record/replay/heal engine
with screenshot-fingerprint cache, `record`/`run`/`cache` CLI, composite
GitHub Action with sticky PR comment, self-hosted runner registration, and
the `td` test API.
