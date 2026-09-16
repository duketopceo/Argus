# Changelog

All notable changes to argus-reviewer are documented here. The project is
pre-1.0; breaking changes may ship without a major bump until `1.0.0`.

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
