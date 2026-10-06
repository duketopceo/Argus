---
title: LOC + optimization audit — Argus main @ 1e499dd (2026-10-06)
type: audit
date: 2026-10-06
plan: docs/plans/2026-10-06-1600-chore-optimization-loc-audit-plan.md
---

# LOC + optimization audit — baseline measurements

Executed as U1 of the optimization plan. These numbers gate U2–U6.

## LOC map

| Area | LOC | Files | Notes |
| --- | --- | --- | --- |
| `src/` | 21,367 | 71 .ts | |
| `src/cli.ts` | 4,931 | 1 | 23% of src; 11 `cmd*` functions; `cmdCodeReview` ≈1,150 lines inline |
| `src/report/html.ts` | 1,069 | | |
| `src/config.ts` | 973 | | |
| `src/engine/loop.ts` | 937 | | |
| `src/probe/queue.ts` | 628 | | |
| `src/probe/generate.ts` | 596 | | |
| `tests/` | 23,217 | | 1.09:1 test:src |
| `action/` | 2,773 | | `sticky-comment.cjs` alone: 1,690 |
| `scripts/` | 4,012 | | |
| `evals/` | 1,435 | | |
| `dist/` (committed) | 20,584 | | by design for git-install consumers |
| `docs/` | 10,406 | 35 .md | out of scope |
| runtime deps | 2 | | playwright + typescript |

## Duplication — measured negative

- `jscpd src/ --min-lines 40 --min-tokens 50`: **0 clones**.
- `jscpd src/ --min-lines 15 --min-tokens 40`: **0 clones** (70 files).
- `cmdCodeReview`/`cmdScan` overlap is orchestration *shape* — both wire the
  same shared helpers (`loadLocalDiff`, `partitionByExclude`, `planChunks`,
  `buildReviewContext`, `createClient`, `validateFindings`, `runRules`) with
  different parameters. No pasted blocks. The consolidation case is thin:
  ~100-150 lines of similar-shaped glue per command.
- **The one real duplication is cross-language and thus invisible to clone
  tools**: `action/sticky-comment.cjs` (1,690 lines) is a hand-maintained
  CJS reimplementation of `src/report/comment.ts` (506) plus copies of
  `src/review/inline.ts` and report helpers — its own comments name it
  "parity copy". `tests/unit/action-contract.test.ts` pins the copies'
  observable behavior equal, so drift is *caught* but sync is still manual.

## Dead code — knip, hand-filtered

knip raw: 76 "unused files", 74 unused exports, 39 unused exported types.
The unused-files list is ~all false positives: `app/worker/`, `electron/`,
`evals/`, `fixtures/`, `launch/` are sub-projects invisible to the root
tsconfig — their entrypoints report as unused.

Filtered `src/` candidates worth verifying per-removal (U5):

- `src/index/scan.ts`: `SCAN_FILE_CAP_BYTES`, `SCAN_DIFF_CAP_BYTES`
- `src/engine/loop.ts`: `instructionMatchesNode`
- `src/pipeline/verify.ts`: `argusVersion`; `src/pipeline/contracts.ts`: `LANE_IDS`
- `src/report/*`: `emptyBudget`, `MANIFEST_HISTORY_DIR`, `reproducedCount`,
  `esc`, `formatDuration`, `readManifest`, `shortHash`
- `src/onboarding/*`: `parseGithubRemote`, `initConfig`, `INIT_TEST`,
  `INIT_WORKFLOW`, `INIT_MENTION_WORKFLOW`, `CONFIG_PATH`
- `src/vision/*`: `extractUsageCost`, several content/question types
- `src/review/*`: `CHUNK_TOKEN_TARGET`, `DEFAULT_SECRETS_THRESHOLD`,
  `TRIAGE_AREAS`, `HUNK_TOLERANCE`, misc types
- `src/detect.ts` `A0_CHILD_ENV_KEYS`, `src/ui/errors.ts` `ISSUE_URL`,
  `retryAfterSeconds`, `BUDGET_KEY`, misc — each needs a real import-site
  check; knip misses dynamic/string-referenced uses

Sub-project (`app/`, `electron/`, `scripts/`) exports reported unused are
**not** trusted — those packages aren't in the root project graph.

## Perf profile — no stall measured

| Command | Time | Size |
| --- | --- | --- |
| `npm test` | **10.3 s** wall (49.9 s user) | 89 files / 1,409 tests |
| `argus scan .` (self-repo) | 0.72 s | 533 files, 76 findings, $0 |
| `argus index` | 0.52 s | 530 files → argus.index.json |
| `code-review --base` | not timed separately — same code path as scan --base, sub-second expected |

vitest reports `isolate: false` would save ~650 ms of worker-spawn — a
~6% suite improvement, not a gate-firing stall.

## Gate decisions (per plan)

| Unit | Gate | Result |
| --- | --- | --- |
| U2 cli.ts split | per-command line counts > 150, mechanical boundaries | **GO** — 4.9k god-file, 11 commands, clean `cmd*` seams |
| U3 pipeline extraction | quantified overlap | **FOLD into U2** — overlap is ~120 lines of shared-shape wiring, not worth a standalone unit; extracting shared stages while splitting commands captures the same value |
| U4 parity/dist hygiene | hand-synced parity or non-reproducible dist | **GO** — `sticky-comment.cjs` confirmed hand-synced; contract test guards drift but not the sync labor. Implementation choice: try generating the cjs via `esbuild --bundle` from `src/` (one new devDep, earns its place by deleting ~1,200 lines of manual parity) — fall back to status-quo + notes if the bundle output can't satisfy the action runtime contract |
| U5 dead code | verified knip findings | **GO** — ~30 `src/` candidates, hand-verify each, batch commits by module |
| U6 perf | measured stall > threshold | **NO-GO** — suite 10.3 s, commands sub-second; record `isolate:false` as an optional micro-fix inside U5's batch, not a unit |
