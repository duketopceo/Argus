# feat: Trust gate + Jev adjudication + review-bot hygiene + live demo tranche

**Origin:** `docs/plans/2026-09-16-001-feat-full-reviewer-roadmap-plan.md`
(carries forward roadmap U1 with refinements; pulls the secrets piece of
roadmap U2 forward; the Tencent/Jev/demo strands come from the user's
2026-09-17 request and research below).
**Closes:** #58.
**Landing order:** U1 lands **first as its own PR** — it closes an active
host-execution hole and every later lane inherits its trust model. The
remaining units land as independent PRs afterward.

---

## Summary

A four-strand tranche: (1) close the host config-execution hole — trust
resolves before `loadConfig`, untrusted checkouts get JSON-only config
reduced to a safe-field **allowlist**; (2) integrate OpenRouter's Jev
Decisions API as Argus's typed adjudication layer with
degrade-to-deterministic fallback (single provider, no failover
possible); (3) adopt proven review-bot hygiene patterns from Tencent's
tooling research (comment budget, severity gating, author-association
invocation gating, finding categories); (4) make a full PR review run
watchable live — `code-review` emits `live.ndjson` and the existing
`watch` TUI tails it, plus a scripted `npm run demo` run.

## Problem Frame

- **#58 is the last known host-execution hole:** a PR-controlled
  `argus-reviewer.config.ts` executes arbitrary code beside
  `OPENROUTER_API_KEY`/`GITHUB_TOKEN` at `src/cli.ts:979`, before PR
  metadata is even fetched. Doc review also proved a denylist can't
  keep up — even a JSON config controls `severity:[]` (never-fail),
  `openrouter.headers` (overrides `Authorization` — spread after the
  bearer at `src/vision/openrouter.ts:170–176`), `target.url`/`a0.url`
  (env-secret exfil channels), spend knobs, and every new policy field
  this tranche itself adds. Only an allowlist survives contact.
- **Findings carry no calibrated adjudication:** secrets-shaped regex
  hits will false-positive (doc keys, fixtures); severity/dedup rides
  inside the LLM prompt. Jev (`~typesafe/jev-latest` →
  `typesafe/jev-1.13-20260917`) answers typed noul/choice/score
  questions at ~$0.042/M input — verified live 2026-09-17: it correctly
  defused `AKIAIOSFODNN7EXAMPLE` (0.03) and hedged a live-format key in
  `.env.production` (0.21), using file context not just shape.
- **Jev is a single-provider alpha endpoint:** OpenRouter confirms "one
  provider, no routing decisions" — provider fallback is impossible by
  construction, so degradation must mean *skip-and-continue*, never
  failover.
- **Review output policy is implicit:** no comment budget, no
  severity-gated merge option, no finding categories — Tencent's
  CodeAnalysis/TCA and CodeBuddy research shows these are table stakes
  for review bots (and the patterns are cheap to adopt).
- **`code-review` is invisible live:** it writes no `live.ndjson`
  lines unless `ARGUS_DEBUG=1` (and then to the hardcoded default cache
  dir, which may differ from `config.cacheDir`), produces no journal,
  and `watch.mjs` tails nothing — the only live follower is Electron's
  `tailLive`.

## Requirements

- **R1** (from origin): hostile PR config cannot execute, exfiltrate,
  or reshape its own review during load; residual surface documented
  (the "documented safe surface" branch).
- **R2**: secret-shaped literals in a PR diff are detected
  deterministically, adjudicated by Jev, and **masked** in all outputs.
- **R3**: Jev unavailability never blocks or degrades a review —
  findings fall back to unadjudicated (marked), verdicts unaffected.
- **R4**: review output honors a comment budget and optional
  severity-gate config; findings carry a category.
- **R5**: a maintainer can watch a live `code-review` run in the TUI
  and run a scripted demo end-to-end locally.

## Key Technical Decisions

| # | Decision | Rationale |
|---|---|---|
| KTD1 | Trust resolves **before** `loadConfig`; fork status comes from `GITHUB_EVENT_PATH` for `pull_request*` events (no token needed — the payload carries `head.repo.fork` + `author_association`); `fetchPrMeta` is used only for `issue_comment` (deriving `pr` from `issue.number` in the payload) or when the payload is absent | Reading the event payload avoids both a token dependency (the `run`/`index` action steps have none) and a serial API call on the hot path. |
| KTD2 | Untrusted config = JSON-only + **allowlist**, applied to the raw parsed object pre-`resolveConfig`; `.ts` refused before the extension loop prefers it | `.ts` shadows `.json` in the name×ext loop — gating after stat() is too late. A denylist was proven unbounded in doc review: `severity:[]` disables blocking, `openrouter.headers` overrides `Authorization`, `target.url`/`a0.url`/`heal` are exfil channels, `codeReviewBudgetUsd`/`model`/`provider` enable spend abuse, `indexPath`/`cacheDir`/`reportDir` are write-location knobs — and this tranche adds more (`decisionModel`, `review.*`, the adjudication threshold). |
| KTD3 | The untrusted allowlist contains **only** policy-free fields: `logLevel`, `sourceGlobs` (and similarly inert display/scope fields as they arise). Everything else — `target.*`, `pageSetup`, `testsDir`, `sandbox.*`, `explore.*`, `secrets`, `severity`, `review.*`, `decisionModel`, all model/budget/provider fields, `openrouter.*`, `a0`/`heal`, path fields — is ignored on untrusted checkouts | The review policy over hostile code must not be authored by that code. `secrets` is dropped too: `td.type(name,{secret:true})` falls back to `env[name]` (`api.ts:258`), and the run lane still scans the PR's own `tests/` — keeping env secrets out of fork-PR `run` lanes is documented policy in SECURITY.md regardless. |
| KTD4 | Local runs default **trusted**; `--untrusted` flag / `ARGUS_UNTRUSTED=1` opts in; **any present-but-unlisted `GITHUB_EVENT_NAME` fails closed to untrusted** | Fail-closed locally would strip `target.command` from normal dev. But `workflow_run`/`workflow_dispatch` checkouts of fork SHAs are the standard privileged-CI-over-hostile-code pattern — an unlisted event must not resolve trusted just because nobody enumerated it. |
| KTD5 | Decisions client is a **separate interface** mirroring `OpenRouterClient` ctor shape (injectable `fetch`, `onCall`), never shares `complete()`; new `CallKind 'decide'` | `/api/alpha/decisions` has no messages/choices — `VisionClient` cannot represent it. |
| KTD6 | Jev failures degrade to **unadjudicated**, never suppression | Single provider = no failover; suppression without adjudication is the FP risk we're removing. Retry-once (honor `Retry-After`), then mark `unadjudicated` and continue — mirrors the probe lane's "additive only" posture. Verified safe direction: attacker-induced Jev failure yields *more* findings, not fewer. |
| KTD7 | Batched questions, capped; client-side validation (≤255 choice options, 2–10 score levels, ≥1 question); ~15s AbortController timeout; **≤50 candidates adjudicated per run** — overflow reported count-only, never reaching the client | Confirmed live-API limits; questions evaluate independently so batching is free; the cap removes the diff-stuffing spend/stall vector (a hostile PR can mint thousands of secret-shaped literals). `ghGet`'s 30s pattern (`ci.ts:68–69`) is the repo's timeout idiom, tightened since Jev is sub-second typical. |
| KTD8 | Pin `typesafe/jev-1.13-20260917` in config default, not `jev-latest`; log resolved `model` per call | Preset aliases drift silently; thresholds are calibrated to a version. Alias stays supported for experimentation. |
| KTD9 | Candidate literals **do** transit to the Jev provider inside `state` — a documented, deliberate exception to the origin's "never republished into prompts" masking rule | Adjudication quality depends on the literal's shape, and the full diff already crosses to OpenRouter in the review call. Masking still applies to every *output* (findings, comments, report, sticky). |
| KTD10 | Tencent pulls are the **policy layer only**: `maxComments`, `severityGate`, author-association for *invocation* gating, finding `category` | TCA's 3-tier deploy, tool-fetch manifests, and log-only quick mode are the anti-patterns. Its real gifts are taxonomy + diff-scoping posture + gate model. |
| KTD11 | Config trust keys on **fork status only** — `author_association` never participates; a MEMBER-authored fork PR is still untrusted | Fork ⇒ untrusted is unconditional (U1). `isTrustedAssociation` is reused only for *invocation* gating (future mention triggers), never for config trust — an OWNER can author a hostile fork tree. |
| KTD12 | Demo uses a new `--fixture <dir>` seam: `code-review` builds `PrFile[]` from the local merge-base diff and skips `fetchPrFiles`/`fetchPrMeta` | `cmdCodeReview` hard-requires repo+pr+token and a live GitHub API (`cli.ts:1013–1021`); a local fixture repo can't demo the real pipeline otherwise. The fixture mode reuses the same local diff the secrets scan computes — real code path, no mocks, and it unblocks U5's local verification too. |

## High-Level Technical Design

### Trust resolution flow (U1)

```
cmdCodeReview entry
  │
  ├─ derive repo/pr (ARGUS_REVIEWER_TRACE; on issue_comment,
  │   pr = GITHUB_EVENT_PATH.issue.number)
  ├─ resolveTrust():
  │     GITHUB_EVENT_NAME = pull_request | pull_request_target
  │       → parse GITHUB_EVENT_PATH → head.repo.fork
  │         fork → UNTRUSTED · same-repo → TRUSTED · payload absent/unreadable
  │         → fetchPrMeta (token) → still unknown → UNTRUSTED
  │     GITHUB_EVENT_NAME = issue_comment
  │       → fetchPrMeta(issue.number) → fork → UNTRUSTED · unknown → UNTRUSTED
  │     GITHUB_EVENT_NAME present, any other value
  │       → UNTRUSTED (fail closed — unlisted CI events)
  │     no event env at all (local run)
  │       → TRUSTED unless --untrusted / ARGUS_UNTRUSTED=1
  │     (author_association NEVER feeds this decision — KTD11)
  │
  ▼
loadConfig(cwd, { trust })          ← trust param REQUIRED
  ├─ untrusted: skip .ts candidates entirely (before stat loop)
  │             parse .json → keep ONLY allowlisted keys → resolveConfig
  ├─ trusted:   current .ts→transpile→import path (unchanged)
  │
  ▼
rest of cmdCodeReview (probe lane keeps existing fork gate — unchanged)
```

### Jev adjudication pipeline (U2+U3)

```
materialize diff: merge-base via compare-API inside fetchPrMeta →
  git cat-file -e head/base → shallow-fetch missing objects
  (--depth 1, probe-lane pattern) → local git diff head vs base
  (NOT the API patch field — GitHub omits it for large/binary files)
  │   └─ cannot materialize → skip with explicit reason in report
  │
  ├─ deterministic scan: secret-shaped regexes → candidates[]
  │   (file, line, pattern-class; literal captured for Jev state only,
  │    NEVER emitted to findings/comments/report)
  │
  ├─ cap 50 candidates → decisions.decide({state: {literal + line
  │      context + filename}, questions: {cand_i: {type:'noul'}}})
  │      ← ONE batched call
  │
  ├─ success → suppress where P(live) < threshold (default ~0.3)
  │            suppressed → recorded masked in report.json
  │            {suppressed: true, pLive} — audit trail, never posted
  │            survivors → findings {file,line,class, pLive,
  │            adjudicated:true} — literals masked
  │
  └─ timeout/4xx/5xx/malformed → retry once (Retry-After) →
       all candidates kept {adjudicated:false} — degrade UP
       │
       ▼
  unioned into finalFindings AFTER synthesis replacement
  (cli.ts:1095 replaces allFindings — deterministic findings are
   re-attached before linkFindings, never passed through the model)
```

### Live demo surface (U5+U6)

```
cmdCodeReview ──liveLog()──▶ <cacheDir>/live.ndjson
                                    │ tail (inode-aware, ported from electron)
                                    ▼
              watch.mjs: new "Live" pane + review pane
              (renders code-review.json verdict/cost when present)
                                    │
npm run demo: --fixture fixture repo → local code-review → TUI watch
```

## Implementation Units

### U1. Config trust gate (#58)

- **Goal:** PR-controlled config can no longer execute code, override
  credentials/policy, or open exfil channels on untrusted checkouts;
  trust is decided before config load.
- **Requirements:** R1
- **Dependencies:** none. **Lands first as its own PR.**
- **Files:** `src/config.ts`, `src/cli.ts`, new `src/trust.ts`,
  `action/action.yml` (pass `GITHUB_TOKEN`/`github.token` to the `run`
  and `index` steps for the `issue_comment` path), `SECURITY.md`,
  `tests/unit/trust.test.ts`, `tests/unit/config.test.ts`
- **Approach:** New `resolveTrust(ctx)` in `src/trust.ts` implementing
  the HTD flow: `pull_request*` → fork status from `GITHUB_EVENT_PATH`
  payload (token-free); `issue_comment` → `fetchPrMeta` on
  `issue.number`; unlisted event name present → `untrusted`; no event
  env → `trusted` unless flag/env override. In `cmdCodeReview`, derive
  repo/pr above `loadConfig` (line 979) — `issue_comment` runs resolve
  `pr` from the event payload, fixing today's dead path
  (`ARGUS_REVIEWER_TRACE.pr` is empty there). The existing
  `fetchPrMeta` promise at line 1040 is reused for metadata (no
  second fetch when it was already needed for trust).
  `loadConfig(cwd, opts)` gains a **required** `trust:
  'trusted'|'untrusted'` — every call site passes it explicitly
  (`cmdRecord` 271, `cmdRun` 452, `cmdCodeReview` 979, `cmdCache`
  1235, `cmdDelegate` 1331, `cmdIndex` 1546, `electron/main.mjs:17`
  passes `'trusted'`), so no missed/future call site can silently
  default to executing config code. Untrusted: `.ts` candidates skipped
  before stat, `.json` parsed, keys reduced to the allowlist (KTD3)
  before `resolveConfig`. `node:vm` is not used and not presented as
  a boundary. SECURITY.md documents the allowlist, the residual
  surface (`run`-lane test files on untrusted trees — including that
  env secrets can be typed into PR-controlled test files, so fork-PR
  workflows must not expose env secrets to `run`/`delegate`), `npm ci`
  lifecycle scripts, and the local-trust model. Note: the composite
  action's staged `config:` input becomes inert on fork PRs by design
  — document that too.
- **Patterns to follow:** `DEFAULT_SANDBOX` fork-precedent
  `src/probe/queue.ts:356`; `isFork` derivation `src/evidence/ci.ts:143`.
- **Test scenarios:**
  - `.ts` config with side effects / `process.env` / dynamic `import`
    refused on untrusted — never transpiled or imported (no temp `.mjs`)
  - fork PR adding `.ts` does not shadow committed `.json`
  - untrusted JSON with `severity:[]`, `review.maxComments:0`,
    `decisionModel`, `codeReviewBudgetUsd`, `model`, `provider`,
    `openrouter.headers`, `target.url`, `a0.url`, `heal`, `secrets`,
    `indexPath`/`cacheDir`/`reportDir` → all inert post-load
  - allowlisted keys (`logLevel`, `sourceGlobs`) still honored
  - trusted context keeps TS config incl. relative imports
  - `pull_request` fork: untrusted resolved from event payload with
    **no token** (fetch stubbed absent)
  - `issue_comment` on fork PR: untrusted via `fetchPrMeta(issue.number)`
  - `workflow_run`/`push`/unknown event names present ⇒ untrusted
  - local: no env ⇒ trusted; `ARGUS_UNTRUSTED=1` ⇒ JSON-only path
  - bare `loadConfig(cwd)` without trust ⇒ compile error (required param)
- **Verification:** #58 closed; exploit attempts (sentinel-file config,
  `Authorization`-overriding headers, env-secret exfil via `target.url`)
  demonstrably inert on untrusted checkout — proven by hostile-fixture
  tests, not inspection.

### U2. Jev decisions client

- **Goal:** typed adjudication primitive available to all lanes, with
  cost tracking and fail-soft semantics.
- **Requirements:** R3
- **Dependencies:** none (parallel with U1)
- **Files:** new `src/vision/decisions.ts`, `src/vision/cost.ts`
  (`CallKind` + `'decide'`), `src/config.ts` (`decisionModel` field),
  `src/api.ts` (export), `tests/unit/decisions.test.ts`
- **Approach:** `DecisionClient` class mirroring `OpenRouterClient`
  ctor conventions (`apiKey`, `fetch?`, `trace?`, `onCall?`). One
  method: `decide({state, questions})` → `POST
  https://openrouter.ai/api/alpha/decisions` with Bearer auth +
  `X-Title: argus-reviewer`. Client-side validation before sending
  (≥1 question; choice `criteria` is a record of option→description;
  ≤255 options; score rubric 2–10 levels) — invalid ⇒ throw locally,
  no spend. Response: validate `answers` keys against questions sent
  and `type` per answer; any mismatch ⇒ whole call failed. Timeout
  ~15s AbortController; one retry on 429/5xx honoring
  `Retry-After`/`retry-after-ms`. Typed error taxonomy
  (`auth | validation | rate_limited | overloaded | server_error |
  timeout | unexpected`) with a retryable predicate, borrowed from
  the unofficial clients. Cost: decisions `usage` shape is
  `input_tokens`/`output_tokens`/`cost` (live: $0.000042/1008in) —
  extend `makeCallCost` or add a decisions variant tolerant of missing
  `cost_details`; record via `ledger.recordCall` under `'decide'`.
  Client may throw typed errors; callers catch and degrade (KTD6).
  Log resolved `model` per call for drift detection.
- **Patterns to follow:** ctor/injectable-fetch of
  `src/vision/openrouter.ts:28–50`; timeout idiom
  `src/evidence/ci.ts:68–69`; never-throws resilience of `src/live.ts`.
- **Test scenarios:** (injected stub `fetch`)
  - batched noul+choice+score serializes correctly; answers map by ID
  - `usage` → `CallCost` recorded under `'decide'`; spend accumulates
  - 429 + `Retry-After` → single retry; second 429 → `rate_limited`
  - 503/timeout → `overloaded`/`timeout`; malformed `answers` →
    `unexpected`
  - 0 questions / >255 choice options / 11-level score → local throw,
    fetch never called (a 1-question call is **valid** — the common
    single-candidate case)
  - resolved `model` echoed and captured for drift logging
- **Verification:** unit tests prove schema + degradation; optional
  key-gated live smoke confirms round-trip.

### U3. Secrets scan + Jev adjudication

- **Goal:** deterministic detection of secret-shaped literals in the
  PR diff, Jev-adjudicated live-vs-fixture, masked in all outputs.
- **Requirements:** R2, R3
- **Dependencies:** U2
- **Files:** new `src/review/secrets.ts` (scan + orchestration),
  `src/cli.ts` (`cmdCodeReview` wiring — unioned into `finalFindings`
  **after** the synthesis replacement at `cli.ts:1095`, before
  `linkFindings` at 1134), `src/config.ts` (`review.secretsThreshold`
  — inside the U4 `review` block, NOT `secrets.*` which is the
  credential map), `tests/unit/secrets.test.ts`
- **Approach:** Diff materialization first: merge-base from the
  compare-API result already inside `fetchPrMeta`; `git cat-file -e`
  both SHAs; shallow-fetch missing objects `--depth 1` (reusing the
  probe lane's fetch pattern — `queue.ts:183–198` already solved
  "shallow checkouts lack the base"); if the diff cannot be
  materialized, record an explicit `secretsScan: {skipped: reason}`
  in the report rather than silently scanning nothing. Scan `+` added
  lines with the pattern table (private-key headers,
  `AKIA[0-9A-Z]{16}`, `sk_live_`, `ghp_`/`gho_`, `xox[baprs]-`, JWT-ish
  `eyJ`, generic `token|secret|password\s*=`) → `{file, line,
  patternClass, contextExcerpt}`. Raw literals are captured for the
  Jev `state` only (KTD9) and masked everywhere else. Cap at 50
  candidates (KTD7); overflow = one count-only note. One batched
  `noul` per candidate. Below `review.secretsThreshold` (default ~0.3,
  tunable after dogfooding) ⇒ suppressed — but **recorded** in
  `code-review.json` as `{file,line,class,pLive,suppressed:true}` with
  literal masked, for audit + threshold calibration; at/above ⇒
  finding `{adjudicated:true,pLive}` masked. Jev failure or
  `decisionModel` unset ⇒ all candidates `{adjudicated:false}`
  (regex-only mode = today's information level, degrade UP). Findings
  are **unioned after synthesis** — the synthesis call at
  `cli.ts:1095` replaces `allFindings` and an attacker could
  prompt-inject it to drop deterministic findings; secrets records
  re-attach unconditionally before `linkFindings`.
- **Patterns to follow:** masking precedent `src/index/context.ts:14`;
  base-fetch `src/probe/queue.ts:183–198`; additive-only posture.
- **Test scenarios:**
  - seeded diff: doc key in docs file + `sk_live_`-shaped literal in
    `.env.production` → both detected; literals never appear in
    findings/report/sticky output
  - Jev stubbed 0.03/0.21 → doc candidate suppressed (recorded,
    `suppressed:true`), env-file candidate adjudicated finding
  - Jev throws `overloaded` → all candidates `adjudicated:false`,
    run completes, verdict unaffected
  - `decisionModel` unset → regex-only mode, same unadjudicated output
  - shallow checkout: base object absent → fetch attempted; fetch
    failure → `skipped` reason in report, zero silent loss
  - binary/large file scanned via local diff (API `patch` bypass)
  - 200 candidates → 50 adjudicated, remainder count-only
  - synthesis stubbed to return findings list WITHOUT the secrets
    findings → they still appear post-union
- **Verification:** dogfood PR with seeded fake secret: flagged under
  a cheap model, masked, `pLive` visible in report; doc-key seed
  suppressed but auditable.

### U4. Review-bot hygiene (Tencent pulls)

- **Goal:** adopt the proven review-bot policy patterns surfaced by
  the Tencent CodeAnalysis/CodeBuddy research.
- **Requirements:** R4
- **Dependencies:** none (independent)
- **Files:** `src/config.ts` (`review: {maxComments?, severityGate?,
  categories?}`), `src/cli.ts` (finding `category` + cap + gate),
  `action/sticky-comment.mjs` (comment budget + gate display),
  `action/action.yml` (inputs passthrough), `SECURITY.md`/`docs/quickstart.md`,
  `tests/unit/review-policy.test.ts`
- **Approach:** Four adoptions:
  (a) **`maxComments`** (CodeBuddy pattern): cap inline findings
  posted — default 20; overflow summarized count-only in the sticky
  ("+7 findings not posted").
  (b) **`severityGate`**: expressed in Argus's real vocabulary —
  `severityGate: 'bug'|'risk'` selects which severities fail the
  commit status. It is the consumer-facing alias over the existing
  `config.severity` block list (`cli.ts:1140`, default `['bug']`) —
  one knob, documented relationship, not a second mechanism.
  (c) **Finding `category`**: TCA taxonomy as optional field
  (`correctness|security|performance|usability|convention|other`),
  assigned via prompt rubric; `security` for secrets findings;
  displayed in comments/report.
  (d) **Author-association = invocation gating only** (CodeBuddy/BKFlow
  pattern): `isTrustedAssociation` (`evidence/ci.ts:13`) is shared for
  deciding whether review *runs* on future mention triggers — it
  never feeds config trust (KTD11; fork status alone decides that).
  **Not** copied: TCA's 3-tier deploy, tool manifests, log-only quick
  mode, blame-owner (deferred — no consumer).
- **Test scenarios:**
  - `maxComments: 3` + 6 findings → 3 posted, sticky "+3 not posted",
    all 6 in report.json
  - `severityGate: 'risk'` → bug|risk findings fail status;
    nit-only review passes; unset → current `config.severity` behavior
  - findings carry `category`; unknown → `other`
  - association gate: `author_association: NONE` blocks invocation in
    the shared helper; a MEMBER-authored fork PR still resolves
    untrusted for config (KTD11 — association never overrides fork)
- **Verification:** dogfood PR shows capped comments + categories;
  report.json carries category + adjudication fields.

### U5. `code-review` live observability

- **Goal:** a running `code-review` is watchable — live lines in
  `live.ndjson` at `config.cacheDir`, progressive findings visible.
- **Requirements:** R5
- **Dependencies:** none
- **Files:** `src/cli.ts` (`cmdCodeReview` `liveLog` calls),
  `src/debug.ts` (route debug writes through `config.cacheDir` when
  known — fixes the split-stream bug), new `scripts/tail-live.mjs`
  (shared helper), `scripts/watch.mjs`, `scripts/collect.mjs`,
  `tests/unit/` coverage for the tail helper
- **Approach:** `cmdCodeReview` gets `liveDir = config.cacheDir ??
  default` and emits `liveLog` at real stage boundaries (trust
  resolved, config loaded, files fetched, chunk N/M, findings linked,
  probes run, report written) — unconditional, not `ARGUS_DEBUG`-gated
  (`liveLog` never throws). `debug()` joins `liveDir` when set,
  fixing the hardcoded-default-dir split (research gotcha #4).
  `watch.mjs` gains a Live pane tailing `live.ndjson` via a shared
  plain-node helper (`scripts/tail-live.mjs`: port of
  `electron/main.mjs:32–58` — 2s poll, inode-rotation detection, 32KB
  seed); Electron can adopt the shared helper later. Review pane: if
  `code-review.json` exists under reportDir, render
  verdict/cost/findings-count.
- **Test scenarios:**
  - `code-review` (stubbed client) emits ordered stage lines to
    `live.ndjson` under a custom `cacheDir`
  - `debug()` lines land in `config.cacheDir` when a live dir is set
  - tail helper: truncate+rewrite rotation doesn't drop/duplicate;
    nonexistent file handled
  - watch.mjs collect() includes live/review data; existing panes +
    sanitization intact
- **Verification:** run `code-review --fixture` locally with
  `npm run watch` alongside — stage lines stream live.

### U6. Scripted demo (`npm run demo`)

- **Goal:** one command reproduces a full watchable review run locally.
- **Requirements:** R5
- **Dependencies:** U5; U3 (secrets adjudication is the most visual
  moment — Jev suppressing a doc key live)
- **Files:** `scripts/demo.mjs`, `fixtures/demo-pr/` (committed fixture
  repo dir — reviewable in the PR, deterministic), `src/cli.ts`
  (`code-review --fixture <dir>` seam per KTD12), `package.json`
  (`demo` script), `docs/quickstart.md`, README demo mention
- **Approach:** `--fixture <dir>` mode (KTD12): `code-review` treats
  the fixture dir's local merge-base diff as `PrFile[]`, skips
  `fetchPrFiles`/`fetchPrMeta`, resolves trust locally (trusted —
  it's the maintainer's own fixture), and runs the real review +
  secrets pipeline. `scripts/demo.mjs` builds/uses `fixtures/demo-pr`
  (intentional doc-shaped key + a real seeded bug), runs
  `code-review --fixture fixtures/demo-pr --report-dir .argus-demo`,
  and instructs the user to run `npm run watch` alongside — or spawns
  both. Requires `OPENROUTER_API_KEY` (BYOK; no mocks — the point is
  the real pipeline). Prints cost summary from ledger/report at end.
  Not for CI.
- **Test scenarios:**
  - `--fixture` without `OPENROUTER_API_KEY` → clear non-zero message
  - fixture produces deterministic scan candidates (unit-test fixture
    + scan, not model output)
  - `--fixture` skips all `api.github.com` calls (assert via stubbed
    fetch never hit)
  - temp artifacts cleaned up
- **Verification:** `npm run demo` + `npm run watch` — maintainer
  watches trust → config → scan → adjudication → review → findings
  stream live end-to-end.

## Scope Boundaries

- **Not in this tranche:** roadmap U2's `reviewProfiles` prompt-pack
  system (secrets scan ships standalone here; packs remain U2);
  roadmap U3 persist, U4 explore, U5 mentions, U6/U7 Agent Zero,
  U8–U10 ops — all unchanged in the roadmap.
- **Jev breadth:** client + secrets adjudication only. Severity
  scoring, finding dedup, probe-worthiness gating consume the same
  `DecisionClient` later — designed for, not built here.
- **Electron:** untouched except it benefits from the `debug()` dir
  fix; the shared tail helper may later replace its inline `tailLive`.
- **Local-web demo variant** (collect.mjs + tail over SSE): deferred —
  TUI-first; build only if the TUI proves insufficient.
- **TCA machinery:** no 3-tier services, tool-fetch manifests, polling
  job API, or git-blame ownership (deferred — no consumer).
- **GitLab/other SCMs:** out (per prior scope decision).

### Deferred to Follow-Up Work

- `run`-lane test-file execution on untrusted trees (documented
  residual — env secrets can reach PR-controlled test code there;
  needs sandboxed `run` or lane-level trust gating, larger item)
- `npm ci` lifecycle-script exposure in the composite action
  (`--ignore-scripts` trade-off vs native deps)
- Jev adjudication for severity/dedup/probe-gating (client designed
  for it; secrets proves the pattern)
- Git-blame finding ownership (TCA pattern; needs plumbing)

## Open Questions

- **`review.secretsThreshold` initial value** — 0.3 proposed;
  calibrate after first dogfood round (live test: doc keys ≤0.08,
  suspicious-context live-format ≥0.14). Defer to execution.
- **Removed/context diff lines** — carried from origin Open Questions:
  a rotated-out-but-live secret in a `-` line deserves a finding, but
  echoing it republishes. Current spec scans `+` lines only; decide
  masking policy for `-`/context at implementation.
- **`maxComments` default** — 20 proposed; pick after dogfood noise.
- **Jev-vs-deterministic-allowlist** — flagged in review: a
  documented-placeholder allowlist + path rules (docs/, fixtures/)
  would suppress canonical FPs for free. Jev is preferred for
  context-aware discrimination (same key, different verdict by file);
  if the FP rate proves low, the allowlist becomes regex-mode's
  fallback. Revisit after dogfooding.
- **Jev error envelope on OpenRouter specifically** — TypeSafe-direct
  codes confirmed (400/401/429/529); OpenRouter alpha envelope assumed
  same-class; validated by the typed taxonomy at first live failure.

## Risks & Dependencies

- **Jev is alpha, single-provider, no fallback** (confirmed by
  OpenRouter). Mitigation: KTD6 degrade-up; scan is useful without
  Jev; versioned slug pinned; drift logged per call.
- **Trust resolution exposes `fetchPrMeta`'s up-to-3 sequential API
  calls before config load** on `issue_comment` (pulls, compare,
  conditional issue-events). Mitigation: `pull_request*` needs no API
  call at all (event payload); on `issue_comment` the call was already
  made later today — hoisted, not added.
- **`--untrusted` local flag is advisory** — a local attacker with
  shell doesn't need it. Acceptable: it exists for
  CI-on-untrusted-checkout and defense-in-depth (documented in
  SECURITY.md).
- **TCA license** reads MIT in README but GitHub reports "Other"
  (bundled tools) — we borrow *patterns*, not code; no concern.
- **Live-verified Jev facts** (this session): decisions API works
  end-to-end; resolved model `typesafe/jev-1.13-20260917`;
  ~$0.00004 per batched 6-question call; context-aware adjudication
  confirmed.

## Sources & Research

- Origin plan: `docs/plans/2026-09-16-001-feat-full-reviewer-roadmap-plan.md`
  (U1 spec lines 144–182, U2 secrets lines 184–217)
- Repo research (this session): config seam `src/config.ts:235–292`,
  call chain `src/cli.ts:979 vs 1040`, `.ts`-shadows-`.json`,
  `queue.ts:356` fork precedent, `queue.ts:183–198` shallow-fetch,
  `cli.ts:1095` synthesis replacement, `cli.ts:1013–1021` skip gates,
  `api.ts:258` env-secret fallback, `openrouter.ts:170–176` header
  spread order, `watch.mjs`/`tailLive`/`live.ndjson` inventory,
  `action.yml` missing `GITHUB_TOKEN` on run/index steps
- External research (this session): Tencent/CodeAnalysis (taxonomy,
  compare-branch, gates); CodeBuddy CNB review + BKFlow
  author-association gate; Jev OpenRouter page + TypeSafe docs
  (schema, ≤255/2–10 limits, single provider, $0.042/M, alpha);
  community clients (pi-jev-auto-mode bands; Elixir error taxonomy)
- Live API verification (this session): batched noul+choice call,
  doc-key vs env-file discrimination, resolved model ID, cost
- Doc review (this session): 22 findings across coherence, feasibility,
  security-lens, adversarial personas — all applied: allowlist over
  denylist, event-payload trust, `GITHUB_TOKEN` on run/index,
  shallow-fetch diff materialization, post-synthesis union, unlisted-
  event fail-closed, `--fixture` demo seam, candidate cap + audit
  trail, `review.secretsThreshold` naming, KTD11 association split,
  `severityGate` vocabulary, landing order.
