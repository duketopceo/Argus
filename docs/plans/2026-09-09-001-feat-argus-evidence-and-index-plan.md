---
title: Argus — run evidence store, diff-aware staleness, and repo index
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
status: planned
created: 2026-09-09
origin: brainstorm artifact at ~/Documents/plans/2026-09-09-001-feat-argus-evidence-and-index-plan.md
---

# Argus v2 — Evidence, Staleness, Index

## Problem

Each run starts informationally cold: errors vanish after the run, caches can't
know a PR diff invalidates them until replay-time hashing, and the harness has
no memory of repo structure. Every run and every error should compound into
per-repo evidence that makes later runs cheaper and more accurate.

## Key Technical Decisions (session-settled — structure pins)

| KTD | Decision | Rejected | Why |
|---|---|---|---|
| KTD1 `session-settled` | In-repo GitHub Action is the default run model; org-owned `argus` hub repo is opt-in storage layout only | hub-only, in-repo-only | Zero-friction adoption first; hub adds cross-repo learning without new engine |
| KTD2 `session-settled` | v1 learning = append-only run journal (evidence store) | failure catalog, model scoring | Honest scope: accumulation, not RL |
| KTD3 `session-settled` | Two-layer staleness: diff-aware invalidation (fast path) + content-hash verify (backstop) | hash-only, diff-only | Proactive invalidation plus a ground-truth backstop |
| KTD4 `session-settled` | Argus builds `argus.index.json` itself (TS/JS import graph via `typescript` API — already a runtime dep) | external indexers, route-map-only | Self-contained, no extra deps; full transitive graph |
| KTD5 `session-settled` | Debug logging during development (`ARGUS_DEBUG`/`logLevel: debug`), defensive degrade-gracefully in prod | always-verbose | Dev visibility without user-facing noise |
| KTD6 `session-settled` | `persistCache: 'artifact' | 'commit'` config flag, default `'artifact'`; journal+index+cache are artifacts | always-commit | Committed caches couple history to machine state |

## Requirements → Units

### U1 — Run journal (evidence store)

New module `src/journal/`:

- `src/journal/schema.ts` — `JournalEntry` type: `schemaVersion: 1`, `runId`,
  `repo` (from `git remote`/cwd basename), `commitSha`, `branch`, `prNumber?`,
  `startedAt`, `durationMs`, `outcome`, `totals` (tests/passed/failed,
  visionCalls, visionCostUsd), `steps[]` (instruction, action, coords, resolved
  a11y snippet, healed, model), `asserts[]`, and `errors[]` — structured
  `{stage, message, context?}` entries for fatal AND non-fatal recoveries
  (retries, probe mismatches, parse fallbacks, budget gates).
- `src/journal/store.ts` — append `writeJournal(cacheDir, entry)` writing
  `<cacheDir>/journal/<runId>.json` atomically (tmp+rename, mirroring
  `src/cache/store.ts`).
- Wire into `src/cli.ts` run path: build the entry at run end from
  `RunReport` (`src/report/run.ts`) plus per-session engine data.
- Engine (`src/engine/loop.ts`) gains a lightweight `errors: ErrorRecord[]`
  collector — every recoverable anomaly (verify-mismatch retry, tolerant-parse
  fallback, non-finite coords rejected, stale heal) appends `{stage, message}`
  and is surfaced via `get errorRecords()`.
- Secrets never appear in journal entries (same guarantee as model calls).

Tests (`tests/unit/journal.test.ts`): schema round-trip, atomic write,
non-fatal error records appear, no secret leakage (config.secrets value never
in serialized output), runId uniqueness.

### U2 — Repo index (`argus.index.json`)

New module `src/index/`:

- `src/index/scan.ts` — walk a consumer repo, produce `IndexEntry[]`:
  `{path, purpose?, imports[], importedBy[], packageVersion?, contentHash}`.
  TypeScript/JS: import graph via the `typescript` compiler API
  (`ts.preProcessFile` or Program — no emit). Other files: content-hash-only
  entries with empty dep lists (best-effort, documented).
  - `purpose` is inferred from first doc comment/exports; `undefined` allowed.
  - Exclusions: `node_modules`, `dist`, `.git`, lockfiles, binary files.
- `argus.index.json` written at repo root (path overridable via config
  `indexPath`), schema-versioned.
- `src/cli.ts`: new `argus index [--dir <repo>]` command.

Tests (`tests/unit/indexer.test.ts`): fixture mini-repo scan produces correct
import edges + reverse edges (`importedBy`), version captured from nearest
`package.json`, exclusions honored, deterministic output ordering.

### U3 — Diff-aware invalidation

- `src/index/diff.ts` — `diffChangedFiles(cwd, base)` via `git diff
  --name-only <base>...HEAD` (or `git status --porcelain` for working tree).
  Git absent → empty set, degrade silently.
- `src/index/invalidate.ts` — map changed files → affected flows: a flow's
  cache entry is marked `stale` when a changed file is in the dependency cone
  of the route/test's known source files. v1 mapping: test file path +
  configured `pageSetup`/`target` globs; routes resolved via the index's
  `importedBy` walk from changed file to route-level files
  (`pages/`, `routes/`, `app/` conventions).
- `src/cache/store.ts`: `FingerprintRecord` gains optional `stale?: string`
  (reason). `locate()` treats `stale` entries as cache-miss (re-ground) but
  keeps them for reference; journal records the invalidation.
- Wire in `src/cli.ts` run path: load index if present → diff → mark stale →
  proceed. Index missing/unparseable → warn once, continue (content-hash
  backstop unchanged).

Tests (`tests/unit/invalidate.test.ts`): fixture diff marks only affected
flows stale; unrelated change (README) invalidates nothing; missing index
degrades cleanly; stale entry re-grounds exactly once.

### U4 — Debug logging + defensive hardening

- `src/log.ts` — tiny leveled logger: `debug|info|warn|error`, level from
  `ARGUS_DEBUG=1` → debug, or config `logLevel`. `debug` emits model
  request/response excerpts (sanitized: never secret values), probe results,
  parse-fallback paths, and timing.
- Audit every `catch`/fallback in `src/engine/loop.ts`, `src/cli.ts`,
  `src/index/`, `src/journal/` — each logs at `warn`/`debug` and degrades;
  journal/dir/index corruption never aborts a run.
- Config gains `logLevel?: 'debug'|'info'|'warn'|'error'` (default `warn` in
  prod paths, `debug` when `ARGUS_DEBUG` set).

Tests (`tests/unit/log.test.ts`): level gating, secret-value sanitization,
fallback paths still function with a read-only cacheDir.

### U5 — Stress suite + model audit (dev tooling)

- `tests/stress/` — dev-only suite, not in default `vitest run`:
  - Synthetic fault-injection fixtures: malformed JSON model responses, bare
    coord strings, missing coords, drifted elements, provider 5xx — each must
    produce a journal error record and correct degradation.
  - Model audit mode: `argus run --audit` tags journal entries with the model
    actually used per call (already tracked) — gives the dataset for later
    model scoring without building scoring.
- Print-debugging during build is covered by U4's `ARGUS_DEBUG`.

Tests: stress fixtures assert graceful-degradation invariants (no uncaught
throws; errors journaled).

### U6 — Persistence policy + Action surface

- Config: `persistCache?: 'artifact' | 'commit'` (default `'artifact'`).
- `action/action.yml`: new inputs `index` (default `true` — run `argus index`
  before tests) and `persist_cache` (passthrough); artifact upload gains
  `e2e-vision/cache/` + journal + index paths (already `continue-on-error`
  from quota work).
- Hub layout documented in README: `<hub>/<owner>/<repo>/{tests,cache,journal,
  argus.index.json}` — storage contract only, no aggregation logic.

Tests (`tests/unit/cli.test.ts` extension): `argus index` command smoke;
artifact-vs-commit flag parsing.

## Sequencing

U1 → U4 (journal + logging first — everything else emits into them) → U2 → U3
(index feeds invalidation) → U5 → U6.

## Risks

- Import graph accuracy across mixed-language repos — mitigated: best-effort,
  hash-only fallback, never blocks runs.
- Journal growth unbounded — bounded by artifact retention (30d) for v1;
  pruning is a later concern.
- `argus index` runtime on large repos — mitigate with file-count cap +
  timeout, degrade to hash-only mode.

## Existing patterns to follow

- Atomic JSON writes: `src/cache/store.ts` (tmp+rename)
- Structured records: `src/report/run.ts` RunReport shape
- CLI command wiring: `src/cli.ts` `cmdCache`/`cmdRun` dispatch
- Engine error collection: existing `healEvents`/`steps` pattern in `src/api.ts`

## Success criteria

- Every run writes a complete journal record; corrupt journal/index/cache is
  skipped with a warning, never a crash.
- README-only PR invalidates no UI fingerprints; a change under `ui/src/pages/`
  invalidates covering flows — they re-ground once and journal why.
- `ARGUS_DEBUG=1 argus run` emits verbose diagnostics; default stays quiet.
- All 43 existing tests pass; new tests for journal, index, invalidation,
  logging, and stress fixtures.
