---
title: "feat: Execution-backed review — sandbox lane + authored probes (Phase B.2)"
type: feat
date: 2026-09-15
origin: docs/plans/2026-09-14-006-feat-post-launch-roadmap-plan.md
deepened: 2026-09-15
---

# feat: Execution-backed review — sandbox lane + authored probes (Phase B.2)

## Summary

Phase B.2 of the post-launch roadmap (roadmap U6): for high-severity
findings that B.1 tagged `not_exercised`, Argus authors a probe test,
executes it inside a hardened Docker container on the self-hosted runner —
against both the PR head and the merge base — and upgrades the finding's
evidence to `reproduced` only when the probe fails on head and passes on
base. This is the differentiation half of the execution-backed-review
thesis — "found a defect *and reproduced it*" — versus review bots that
only assert.

---

## Problem Frame

B.1 (shipped in PR #56) classifies every code-review finding against the
PR's own CI evidence: `exercised`, `corroborated`, `not_exercised`,
`inconclusive`. That made findings *verifiable in principle* but left the
`not_exercised` set — typically the highest-value findings, since existing
tests demonstrably don't reach them — as asserted-but-unproven. B.2 turns a
bounded subset of that queue into executed probes: the model writes a test
aimed at the suspected defect, the harness runs it in a scrubbed container,
and a head-fails/base-passes double-run is the only thing that upgrades the
finding. Everything else (clean probe, probe-bug failure on both, authoring
failure, infra failure) leaves the finding at `not_exercised` with severity
intact — the sandbox can only add positive evidence, never negative.

This lane adds a *new* post-install execution path for PR-contributed code
on the consumer's runner — the largest security boundary in the product so
far, and the load-bearing part of this plan. Scope honesty: dependency
install (`npm ci` and its lifecycle scripts) already executes PR code
unsandboxed on the same host before this lane runs — that is a pre-existing
property of the action, documented in `SECURITY.md` as an accepted gap, not
something this plan introduces or silently claims to bound.

---

## Requirements

From the roadmap (R4, R5) and pinned invariants:

- **R1.** During `code-review`, findings with `evidence.status ===
  'not_exercised'` and severity in the blocking set become probe targets,
  up to a per-run cap.
- **R2.** For each target, Argus authors a test file in the consumer's
  detected test-runner idiom and executes it in the sandbox against the
  PR's checkout — and once more against a merge-base worktree.
- **R3.** `reproduced` requires the authored test to *fail on head AND
  pass on base*: a probe that fails on both reveals a probe bug, not the
  defect, and stays `not_exercised`. (Consequence: defects that
  pre-exist on base cannot be proven this way — acceptable under the
  additive-evidence posture; the finding keeps full severity.)
- **R4.** Sandbox invariants: no `GITHUB_TOKEN`, no `OPENROUTER_API_KEY`,
  no consumer secrets or ambient env — *and* no credential material
  reachable on the filesystem (`.git` is masked, checkout must run with
  `persist-credentials: false`); network `none`; read-only root
  filesystem; non-root user; all capabilities dropped;
  `no-new-privileges`; CPU/memory/PID limits; and a *guaranteed*
  wall-clock timeout enforced by daemon-side `docker rm -f`, not by
  signaling the client.
- **R5.** Fork/external-contributor PRs never run probes by default.
  Approval signals: a maintainer-applied `argus-probe` PR label *bound to
  the current head* (a label event that postdates the head's
  `pushed_at`), a trusted `author_association` (MEMBER/OWNER/
  COLLABORATOR), or an explicit `allowForks` config opt-in.
- **R6.** Probe execution is opt-in per repo (`sandbox.enabled`), off by
  default; without Docker, a supported test harness, or a shareable
  workspace path the lane degrades to a detail note and findings stay
  `not_exercised`. The supported workflow event is `pull_request` —
  `pull_request_target` is unsupported for the probe lane (ambient
  secrets + write token make every gap fatal).
- **R7.** Probe output is attacker-controlled: capped and control-
  character-stripped at the module boundary, `sanitizeForComment` applied
  at the comment/prompt render boundary, never rendered verbatim.
- **R8.** Probe spend (authoring calls) and wall-clock are bounded and
  reported in `code-review.json`. Probe outcomes never change `verdict`,
  `ok`, or the process exit code — `reproduced` is informational evidence
  on findings that already gate by severity (KTD8).

---

## Key Technical Decisions

- **KTD1 — Unit/harness-level probes only in v1.** The roadmap allows
  browser-level probes via the vision engine's record/replay loop; that
  requires a running app target, which PR CI does not reliably provide,
  and B.1 findings are file-level defects best proven by a focused test.
  Browser probes are deferred (see Scope Boundaries).
- **KTD2 — Docker-in-runner is the sandbox substrate** (roadmap-pinned),
  with the full untrusted-code flag profile: `--rm`, `--network none`,
  `--read-only`, `--cap-drop ALL`, `--security-opt no-new-privileges`,
  `--user 65534:65534` (nobody), `--pids-limit`, `--memory`, `--cpus`,
  `--tmpfs /tmp:rw,nosuid,nodev,noexec`, deterministic `--name
  argus-probe-<id>` (enables the guaranteed teardown in R4), `-v
  <workdir>:/work:ro`, `-w /work`. Filesystem boundary: `--tmpfs
  /work/.git` shadows the git dir inside the container (mounted after the
  ro bind), and the action documents `persist-credentials: false` on
  checkout with a fail-closed startup check (`.git/config` containing
  credentials → lane degrades). Only the dedicated scratch dir
  `<reportDir>/probes-out/` is bind-mounted writable
  (`-v <…>/probes-out:/work/<rel>/probes-out:rw`, later mounts win);
  report JSON stays under the ro workspace mount so probe code cannot
  forge `run.json`/`code-review.json` or tamper with artifacts the post
  step consumes. Declared env allowlist only: `PATH` (literal), `HOME=/tmp`,
  `npm_config_cache=/tmp/.npm` — `npx`/npm as `nobody` has no writable
  home otherwise. External reference: SOTA container sandboxing rules
  (`sota-skills/03-containers-microvms`) — the untrusted-code profile.
- **KTD3 — Probes are authored in the consumer's own test-runner idiom,
  placed where the runner already looks.** Detection reads `package.json`
  for vitest/jest/`node --test`, returning `{ kind, runCmd(file),
  classify(result) }`. The probe file is written host-side *next to the
  exemplar test file* KTD7 already locates (same directory, matching the
  repo's `*.test.*` naming) — vitest/jest positional args are *filters*
  intersected with configured `include`/`testMatch`/`roots`, so a probe
  outside the consumer's test globs is never collected; co-locating makes
  discovery free by construction. `runCmd` bypasses `npx` (fails as
  `nobody` with no HOME) and invokes the installed binary directly —
  `node node_modules/vitest/vitest.mjs run <file>`,
  `node node_modules/jest-cli/bin/jest.js <file>`, `node --test <file>`
  with loader/strip-types flags captured from `scripts.test` — with each
  runner's cache redirected into `/tmp`. `classify` maps runner output to
  `failed-test` | `load-error` | `not-collected` | `clean` per runner
  (vitest/jest summary counts vs collection errors; `node --test` TAP
  `not ok`). No supported harness → `not_exercised` with detail.
- **KTD4 — One new evidence status: `reproduced`.** `EvidenceStatus`
  gains `'reproduced'`; only the probe stage emits it. Clean probe,
  probe-bug (fails on base too), author failure, not-collected, and infra
  failure all leave the finding at `not_exercised` — never negative
  evidence.
- **KTD5 — Opt-in `sandbox` config block.** `sandbox: { enabled, image,
  maxProbes, timeoutMs, memory, cpus, pidsLimit, allowForks }`; defaults
  `enabled: false`, `maxProbes: 3`, `timeoutMs: 120_000`, `memory: '2g'`,
  `cpus: '2'`, `pidsLimit: 256`, `allowForks: false`. `image` defaults to
  `node:<host Node major>-slim` resolved via `node --version` at probe
  time (native `node_modules` are ABI-bound to the installing Node), and
  is *trusted maintainer config* — a custom image extends the trusted
  computing base. Images are pulled by digest or with `--pull always` —
  `--pull missing` on a persistent self-hosted runner trusts whatever a
  prior job tagged locally (image-poisoning hole). Fork gate per R5:
  `allowForks: true` runs everywhere; otherwise the label must postdate
  head `pushed_at` (fetched via the issue timeline in `fetchPrMeta`), or
  the author must be MEMBER/OWNER/COLLABORATOR. Deleted-fork PRs
  (`head.repo: null`) and unavailable meta are treated as fork —
  fail closed.
- **KTD6 — Reproduction is a double-run, and only an attributed test
  failure.** `reproduced` requires `failed-test` on the head checkout AND
  `clean` on a merge-base `git worktree` (fetched via the PR's `base.sha`
  from `fetchPrMeta`); every other combination stays `not_exercised`.
  This mechanically separates defect-failure from probe-bug-failure —
  the credibility claim the feature exists for. One extra bounded
  `docker run` per target; the worktree is created on the host and
  mounted the same way. Captured probe output (capped, control chars
  stripped) is stored verbatim-ish on the probe record for audit;
  `sanitizeForComment` applies only where output renders into comments
  or prompts.
- **KTD7 — Probe authoring is one bounded model call per finding** on
  `code_model`, fed: the finding (file/line/message), the implicated
  file's contents, one exemplar test file (nearest test per the repo
  index), and the detected harness. Structured output `{ filename,
  content, reasoning }`; the write path is
  `join(<exemplarDir>, basename(filename))` with `filename` required to
  match `^[A-Za-z0-9_.-]+\.test\.[jt]sx?$` — no separators, no `..`,
  forced extension — because the write happens on the *host* and the
  model's input includes PR-controlled file contents (prompt-injection
  → arbitrary host write is the exact hole this closes). `content` is
  size-capped, rejects non-repo imports, and rejects `process.env`
  reads of `*_KEY|*_SECRET|*TOKEN` (defense-in-depth over the stripped
  env). Authoring cost records on the shared `codeReviewBudgetUsd`
  ledger.
- **KTD8 — Probe outcomes are informational only.** `reproduced` never
  changes `verdict`, `ok`, severity, or exit code, and the queue only
  admits severities already in `config.severity` — there is no
  reproduction-driven escalation path in v1. This keeps the roadmap's
  "feed pass/fail evidence into the review verdict" honest as a
  visibility contract (the evidence column), not a gating change.

---

## High-Level Technical Design

```mermaid
flowchart TB
  CR[code-review: chunk review + synthesis] --> LK[B.1 linkFindings]
  LK --> Q{queue: not_exercised AND severity in config.severity}
  Q -->|disabled / no docker / fork gate / cap / budget| SKIP[stays not_exercised + detail]
  Q -->|target| AU[author probe via code_model]
  AU -->|author-failure / filename rejected| SKIP
  AU --> HEAD[docker run vs PR head]
  AU --> BASE[git worktree @ base.sha; docker run vs base]
  HEAD -->|failed-test AND base clean| REPRO[evidence: reproduced]
  HEAD -->|any other combination| SKIP
  REPRO --> RPT[code-review.json probes[] + sticky + inline note]
  SKIP --> RPT
```

Linkage (B.1) produces the queue; the probe stage can only move
`not_exercised` → `reproduced`. Every other status is untouched.

---

## Output Structure

```text
src/
  executor/
    sandbox.ts        # docker availability + hardened run/teardown wrapper
  probe/
    harness.ts        # runner detection, direct invocation, output classify
    author.ts         # probe prompt, schema, filename/content validation
    queue.ts          # target selection, double-run orchestration, upgrade
tests/unit/
  sandbox.test.ts
  probe-author.test.ts
  probe-queue.test.ts
```

New files only; modified surfaces are enumerated per-unit below.

---

## Implementation Units

### U1. Evidence model + config surface + PR metadata

- **Goal:** The types and switches B.2 needs exist before any execution.
- **Requirements:** R5, R6
- **Dependencies:** none
- **Files:** `src/evidence/link.ts` (extend `EvidenceStatus`),
  `src/config.ts` (`Sandbox` interface + `sandbox` field + defaults +
  `resolveConfig` normalization), `src/evidence/ci.ts` (`fetchPrHeadSha`
  → `fetchPrMeta` returning `{ headSha, baseSha, isFork,
  authorAssociation, labels, labelApprovedAt } | undefined`), `src/cli.ts`
  (call-site update), `tests/unit/evidence.test.ts`, config coverage
- **Approach:** `EvidenceStatus` gains `'reproduced'` — additive only;
  `linkFindings` never emits it. `fetchPrMeta` reads `/pulls/{pr}` fields
  (`head.sha`, `base.sha`, `head.repo.fork`, `author_association`,
  `labels[].name`) plus one issue-timeline call to find the newest
  `labeled` event for `argus-probe`, compared against
  `head.repo.pushed_at` — label approval binds to the current head, so a
  post-label `synchronize` push does not inherit approval. `head.repo:
  null` (deleted fork) → `isFork: true`, fail closed. `mayProbePr(meta,
  sandboxConfig)` is a pure function, unit-testable without GitHub.
- **Test scenarios:**
  - `mayProbePr`: same-repo → allowed when enabled; fork + stale label
    (applied before head `pushed_at`) → denied; fork + fresh label →
    allowed; fork + MEMBER → allowed; `head.repo: null` → denied without
    label; meta `undefined` → denied; `allowForks: true` → allowed;
    `enabled: false` → denied regardless.
  - `resolveConfig`: absent `sandbox` → defaults with `enabled: false`;
    partial → defaults fill; non-finite `maxProbes`/`timeoutMs`/
    `pidsLimit` → normalized.
  - `linkFindings` never produces `reproduced` (regression guard).
- **Verification:** types compile; gate matrix covered.

### U2. Sandbox executor

- **Goal:** One audited function running a command in the hardened
  container, all subprocess calls behind `ExecFn`, with guaranteed
  teardown.
- **Requirements:** R4, R6, R7
- **Dependencies:** U1
- **Files:** `src/executor/sandbox.ts`, `src/detect.ts` (`ExecResult`
  gains `timedOut`/`signal` from `err.killed`/`err.signal` so a client
  timeout is distinguishable from a nonzero exit),
  `tests/unit/sandbox.test.ts`
- **Approach:** `dockerAvailable(exec)` runs `docker version` *plus* a
  cheap mount smoke check — `docker run --rm -v <workdir>:/work:ro <image>
  test -f /work/package.json` — because the daemon resolves bind-mount
  sources on *its* filesystem; containerized/remote daemons would
  silently mount an empty dir. `runProbeInSandbox({ exec, image, workdir,
  scratchDir, cmd, limits })` builds the KTD2 argv: hardened flag set,
  `--name argus-probe-<id>`, `-v <workdir>:/work:ro`, `--tmpfs /work/.git`,
  `-v <scratchDir>:/work/<rel>/probes-out:rw`, env allowlist `PATH`/
  `HOME=/tmp`/`npm_config_cache=/tmp/.npm`. On `timedOut` (or a
  post-start spawn error) it issues a second exec `docker rm -f
  argus-probe-<id>` — SIGKILL via the daemon is non-ignorable, so the R4
  wall-clock bound holds even when container PID 1 traps SIGTERM.
  **Path safety:** before any `docker run`, `fs.realpath` the workdir and
  scratch dir; the resolved scratch dir must be a strict descendant of
  the resolved workdir with no symlink in the chain (a checked-in
  `argus-reviewer-report` symlink must not become a writable bind of
  `$HOME`) — violation degrades to the detail note. Same check rejects a
  `reportDir` configured outside `ctx.cwd`. The scratch dir is
  pre-created host-side with permissive perms for the `nobody` user.
  Result `{ exitCode, stdout, stderr, durationMs, timedOut }`; output
  capped and C0/ANSI control bytes stripped at this boundary
  (`sanitizeForComment` itself is applied later, at render).
- **Patterns to follow:** `src/executor/a0.ts` — thin ExecFn wrapper,
  spawn rejection degrades to a failed result, never throws past the
  caller.
- **Test scenarios:**
  - argv asserts every hardened flag; the only `-e`/`--env` entries are
    the declared allowlist with literal values; no flag value is sourced
    from host env or secrets.
  - `--tmpfs /work/.git` present; rw mount targets `probes-out` only.
  - timeout → `timedOut: true` *and* a `docker rm -f <name>` call is
    issued (asserted on the stub).
  - docker missing → availability false, run never attempted; mount smoke
    check failure → degraded.
  - symlinked/outside-workdir scratch dir → clean degradation, no run.
  - output over cap → truncated; ANSI escape sequence does not survive.
  - spawn rejection → failed result, message carried, no throw.
- **Verification:** flag-set assertions pass; exactly one argv builder
  and one teardown path exist.

### U3. Harness detection + probe authoring

- **Goal:** Given a `not_exercised` finding, produce one runnable probe
  file — or a clean "cannot author".
- **Requirements:** R2, R7
- **Dependencies:** U1
- **Files:** `src/probe/harness.ts`, `src/probe/author.ts`,
  `tests/unit/probe-author.test.ts`
- **Approach:** `detectHarness(cwd)` per KTD3 — vitest/jest devDeps or
  `scripts.test`, `node --test` including its loader flags
  (`--import tsx`, `--experimental-strip-types`, `--loader`) captured
  verbatim into `runCmd`; returns `{ kind, runCmd(file), classify }`
  with the per-runner `failed-test`/`load-error`/`not-collected`/`clean`
  mapping. `buildProbeMessages(finding, fileContents, exemplarTest,
  harness)` — system + user; emit one self-contained test importing only
  repo modules + installed devDeps, asserting the *correct* behavior the
  finding describes (so defect-present ⇒ test fails). `parseProbe`
  enforces the KTD7 filename regex and content rules; the exemplar's
  directory is the write target.
- **Patterns to follow:** `CODE_REVIEW_SCHEMA`/`parseCodeReview` in
  `src/cli.ts` — schema-first, parse failure → clean no-probe result.
- **Test scenarios:**
  - `detectHarness`: vitest devDep → vitest invocation via
    `node_modules/vitest/vitest.mjs`; `scripts.test: "node --import tsx
    --test"` → node test with `--import tsx` preserved; neither →
    `undefined`.
  - `classify`: vitest "1 failed" → `failed-test`; "No test files found"
    → `not-collected`; syntax error → `load-error`; clean → `clean`.
  - `parseProbe`: happy path; `filename: '../../x.test.ts'` or missing
    `.test.` → reject before any write; oversized content → reject;
    `process.env.OPENROUTER_API_KEY` read → reject; parse failure →
    `{ ok: false }`.
  - prompt includes finding file/line/message and exemplar text.
- **Verification:** generated probe for a fixture repo parses, writes to
  the exemplar's directory, and would be collected by the detected
  runner's own config.

### U4. Probe queue + double-run orchestration inside `code-review`

- **Goal:** Wire the lane end-to-end: queue → author → sandbox ×2 →
  evidence upgrade → report.
- **Requirements:** R1, R2, R3, R6, R8
- **Dependencies:** U1, U2, U3
- **Files:** `src/probe/queue.ts`, `src/cli.ts` (`cmdCodeReview`,
  post-`linkFindings`), `tests/unit/probe-queue.test.ts`
- **Approach:** After `linkFindings`, when `sandbox.enabled` (or
  `ARGUS_SANDBOX=1` — enable-only opt-in; unset/other values leave config
  authoritative) and `mayProbePr` and `dockerAvailable` and
  `detectHarness` all pass and the ledger has budget: take
  `not_exercised` findings with severity in `config.severity`, first
  `maxProbes`. Per target: author (KTD7) → write probe next to the
  exemplar → `git worktree add` a merge-base checkout from
  `fetchPrMeta().baseSha` → `runProbeInSandbox` on head and on base →
  classify per KTD6 (`failed-test` on head ∧ `clean` on base →
  `reproduced`, detail "reproduced by Argus probe `<name>`"; everything
  else → unchanged `not_exercised`). Probe files and the base worktree
  are removed after classification (or on failure). Every failure mode
  is a `debug()`/`err` note + report field, never an exit-code change —
  additive evidence, not a new failure surface (KTD8).
- **Report:** `CodeReviewReport` gains `probes?: { file, findingFile,
  findingLine, outcome: 'reproduced' | 'clean' | 'load-error' |
  'not-collected' | 'error', durationMs, costUsd, detail, output? }[]`;
  a probes summary joins the completion log.
- **Execution note:** the orchestrator is a pure-ish function taking
  injected `exec`, `client`, and paths — tests stub all three, never
  touch Docker or git.
- **Test scenarios:**
  - seeded defect (off-by-one in an untested helper): head `failed-test`
    + base `clean` → `reproduced`, detail names the probe.
  - probe fails on head AND base → `not_exercised` (probe bug), outcome
    `load-error`-recorded on the probe record, finding untouched.
  - probe passes on head → `not_exercised`, outcome `clean`.
  - sandbox exec rejects → `not_exercised`, outcome `error`.
  - `maxProbes: 2` with 4 eligible → exactly 2 probe pairs.
  - `sandbox.enabled` unset → zero authoring calls (ledger untouched).
  - runner reports "no tests" → `not-collected`, not `reproduced`.
  - budget exceeded before probes → queue skipped.
  - verdict/ok identical with and without a `reproduced` finding (KTD8).
- **Verification:** unit suite covers the matrix with stubs; dogfood PR
  exercises the real path.

### U5. Report/comment surface + action input + docs

- **Goal:** `reproduced` evidence is visible where reviewers look, and
  consumers can enable the lane.
- **Requirements:** R3, R6, R7
- **Dependencies:** U4
- **Files:** `action/sticky-comment.mjs` (icon + probes summary row +
  inline note), `action/action.yml` (`sandbox` input → `ARGUS_SANDBOX`
  env), `docs/quickstart.md`, `README.md`, `SECURITY.md` (threat-model
  paragraph)
- **Approach:** evidence icon map gains `reproduced: '🧪'`; code-review
  detail gets a "Probes" line (`N probes run, M reproduced`); inline
  comments on `reproduced` findings append "*Reproduced by an Argus probe
  against the PR head (clean on base) — see workflow artifacts*".
  `SECURITY.md` documents the invariants, the fork/label gate, the
  `pull_request`-only scope, `persist-credentials: false`, and the
  accepted pre-existing gap that dependency install runs unsandboxed.
  Docs state the trigger requirement: consumer workflows must include
  `labeled` in `pull_request.types` for label-gated approvals to fire.
- **Test scenarios:** sticky renders the `🧪` row + probe count; inline
  note appears only on `reproduced` findings (extend
  `tests/unit/comment.test.ts` coverage or verify on the dogfood PR).
- **Verification:** dogfood PR shows a `🧪 reproduced` row.

### U6. Dogfood verification

- **Goal:** Prove the lane on this repo with a seeded defect.
- **Requirements:** R3
- **Dependencies:** U4, U5
- **Files:** none permanent — throwaway branch/PR seeded with an
  unexercised defect (e.g. off-by-one in a helper outside
  `testReachableFiles`)
- **Approach:** draft PR → confirm `code-review.json` shows a
  `reproduced` finding and the sticky comment renders it. A second
  seeded PR whose defect also exists on base confirms the double-run
  does *not* upgrade it. Close both without merging.
- **Test expectation:** none — manual/CI verification.
- **Verification:** draft PR argus report shows `reproduced`; the
  base-defect control PR shows `not_exercised`.

---

## Scope Boundaries

### Deferred to Follow-Up Work

- **Browser-level probes** via record/replay (roadmap-allowed) — needs
  a running app target; revisit after unit probes prove the loop.
- **Non-Node test harnesses** (pytest, go test, …) — v1 probes are
  Node-harness-only by deliberate scoping; extending `detectHarness`
  plus a matching sandbox image is follow-up work. Stated in docs so
  the JS/TS-only moat is a choice, not silent degradation.
- **Managed sandbox providers** (Cloudflare Sandbox, E2B) — per-repo
  opt-in alternative when Docker-first shows its limits.
- **Coverage-instrumented probe targeting** — strengthens `reproduced`
  by proving the implicated lines executed; adds a coverage toolchain.
- **Probe persistence** — probes are ephemeral; a follow-up could offer
  them back as suggested tests.
- **Pre-existing unsandboxed install path** — `npm ci` lifecycle scripts
  run PR code on the host before this lane exists; closing that (e.g.
  `npm ci --ignore-scripts` inside a container build step) is separate
  hardening, documented as accepted gap in `SECURITY.md`.

### Rejected alternative

- **Author-only probe hand-off** (probe emitted as a suggested test for
  the consumer's own CI to run, B.1 picking up the result) — rejected
  for v1: synchronous reproduction inside the same review run is the
  differentiator, and a composite action cannot inject files into a
  separate consumer job anyway. Remains viable as a fallback if Docker
  availability proves too limiting.

---

## Assumptions

- The Actions runner user can reach a Docker daemon *that resolves the
  runner's workspace path* — bare-metal/VM runner, or a runner container
  that bind-mounts the host workspace at the same path. The mount smoke
  check (U2) degrades cleanly when this fails.
- Probes exercise whatever commit the consumer's checkout step fetched —
  commonly the merge ref on `pull_request`. Docs note this; the base
  worktree is always `base.sha` from the PR API.
- `node_modules` exists at probe time (the action's `npm ci`). Consumers
  running `code-review` without installed deps degrade to the harness
  note, not a failure.
- `node:<major>-slim` exists for the host's Node major and the runner's
  arch (the dogfood runner is aarch64 — multi-arch official images cover
  it); `sandbox.image` overrides.
- Minimum runner versions for cache redirection are discovered at
  implementation time (vitest's ro-`node_modules` cache fix is recent);
  uniform `load-error` outcomes surface in the report rather than
  silently failing.

---

## Risks & Dependencies

| Risk / dependency | Mitigation |
| --- | --- |
| PR code escapes the container | KTD2 flag set + non-root + no env + no net + ro mount + masked `.git` + credential-free checkout; boundary is the plan's core |
| Model-authored probe fails for its own reasons → false `reproduced` | KTD6 double-run: fails-on-base ⇒ probe bug ⇒ no upgrade; per-runner `classify` separates test failure from load error |
| Prompt-injected probe filename writes outside the tree | KTD7 basename + strict regex on the host write path |
| Checked-in symlink turns the rw mount into arbitrary host write | U2 realpath + descendant + no-symlink-in-chain check |
| Probe output poisons prompt/comment/logs | capped + control-char strip at module boundary; `sanitizeForComment` at render; output never re-fed to the model in v1 |
| Hung probe outlives the job | deterministic container name + `docker rm -f` on timeout — daemon-side kill, non-ignorable |
| Maintainer label outlives the approved head | label event must postdate head `pushed_at`; `synchronize` after approval requires re-label |
| Local image poisoning on persistent runners | digest pull / `--pull always`; `sandbox.image` documented as trusted config |
| Docker absent, daemon can't see workspace, or no harness | `dockerAvailable` + mount smoke + `detectHarness` gates → clean degradation note |
| Authoring cost balloons | `maxProbes` cap + shared `codeReviewBudgetUsd` ledger |
| `pull_request_target` consumers | documented unsupported for the probe lane (R6, SECURITY.md) |

---

## Sources / Research

- Roadmap: `docs/plans/2026-09-14-006-feat-post-launch-roadmap-plan.md`
  (U6, staged-moat decision, pinned sandbox invariants)
- B.1 implementation: `src/evidence/ci.ts`, `src/evidence/link.ts`
- Executor/ExecFn conventions: `src/executor/a0.ts`, `src/detect.ts`
- Container hardening: SOTA sandboxing container rules
  (github.com/martinholovsky/sota-skills, `03-containers-microvms`),
  Docker `run` reference, GitLab self-managed-runner security guidance
- Runner-discovery constraint: vitest positional args filter against
  `test.include` (vitest-dev/vitest#7045); vitest ro-`node_modules`
  cache behavior (vitest-dev/vitest#5227, #7893)
- Doc review: 5-persona pass (coherence, feasibility, security,
  adversarial, product) — 20 findings, all actionable ones incorporated
  (double-run classification, `.git` masking, filename traversal,
  per-head label binding, container teardown, probe placement,
  HOME/env allowlist, image pinning, mount realpath checks)
- Issue of record: duketopceo/Argus#52
