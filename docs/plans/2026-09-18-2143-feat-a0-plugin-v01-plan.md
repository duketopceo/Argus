---
title: Agent Zero Plugin v0.1 - Plan
type: feat
date: 2026-09-18
topic: a0-plugin-v01
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-brainstorm
execution: code
---

# Agent Zero Plugin v0.1 - Plan

## Goal Capsule

- **Objective.** An Agent Zero user installs the argus plugin into their A0 instance, asks their agent to review a PR or replay a recorded flow against a checkout, and gets the verdict back in chat — with a GitHub sticky comment on explicit request — and the plugin is submitted to the community Plugin Index for distribution.
- **Means.** A standalone `a0-plugin-argus` repo ships `plugin.yaml` + thin `Tool` subclasses that shell out to the `argus-reviewer` CLI inside a user-provided checkout and parse its JSON reports (KTD2, KTD4).
- **Product authority.** This plan; brainstorm-settled decisions are marked `session-settled` under Key Decisions.
- **Stop conditions.** Hosted A0 verification (R11) fails in a way that shows the CLI path cannot run in A0's tool env → stop and re-evaluate the HTTP-surface hedge rather than shipping unverified.
- **Execution profile.** New standalone repo `duketopceo/a0-plugin-argus` (target repo for all file paths below, which are repo-relative to it). Implementation, review, and PR in this pipeline; index submission PR to `agent0ai/a0-plugins` is a separate second repo PR.

## Product Contract

### Summary

A standalone `a0-plugin-argus` repo ships `plugin.yaml` + `tools/` per the A0 plugin contract, giving Agent Zero two tools — `argus_review` and `argus_flow` — that shell out to the argus CLI (`argus-reviewer-e2e` on npm) inside a user-provided checkout. Results narrate into the A0 conversation by default; an explicit `post` flag writes a sticky comment to the PR. Verified against the user's hosted A0 instance, then submitted to `agent0ai/a0-plugins`.

### Problem Frame

Argus today has one invocation surface in each direction it supports: the GitHub Action triggers reviews on PRs, and `argus-reviewer delegate`/`heal:'a0'` lets Argus hand exploratory work *to* Agent Zero. Nothing lets an A0 user reach *into* Argus. The user lives in A0, wants argus's review discipline (diff analysis, Jev triage, inline comments, cost ledger) and its cache-cheap flow replay available there, and wants the plugin in the community index so other A0 users get the same — the "get v0.1 shipped to the a0 marketplace" goal the user named. The roadmap had deferred this behind live delegate verification; that ordering produced no plugin, and the user's hosted A0 instance now makes plugin load-verification the reachable path anyway.

### Key Decisions

- **Plugin before Argus→A0 depth.** (session-settled: user-directed — chosen over the roadmap order: the plugin builds and verifies host-free, while delegate live-verify proceeds as its own later unit.) The roadmap's U7/U8 depth items stay deferred; this plan covers U6 only.
- **Two tools, review + flow.** (session-settled: user-directed — chosen over a review-only v0.1: A0's ad-hoc browsing doesn't replace recorded flows, which replay at near-zero model cost with self-heal.) Governs R4, R5.
- **Narrate default, post on explicit flag.** (session-settled: user-directed — chosen over narrate-only and post-everything: read-safe default keeps GitHub writes deliberate.) Governs R8, R9.
- **Sticky-only posting, implemented plugin-side.** (session-settled: user-approved — chosen over widening v0.1 posting to inline findings + commit status: the CLI has no posting surface, so all posting is plugin code; sticky-only keeps the write surface small.) Governs R8, R9; mechanism in KTD1.
- **`argus_flow` replays only, gated on trust.** (session-settled: user-approved — `record` deferred as interactive/browser-heavy; `run` executes checkout test files, so it requires the `trust_checkout` setting rather than pretending `ARGUS_UNTRUSTED` protects it.) Governs R5, R10; mechanism in KTD3.
- **CLI shell-out, not HTTP.** The tools invoke the argus CLI via `npx` inside the target checkout; an argus HTTP surface is built only if hosted verification shows the CLI path cannot run. Governs R6.
- **Standalone repo, contents at root.** The plugin ships as its own repository with `plugin.yaml`, `LICENSE`, `README.md`, and `tools/` at the root, so it can be cloned into `usr/plugins/argus` and referenced by the community index. Governs R1–R3.

<!-- ce-section: work-relationships -->
### How This Work Fits Together

This plan covers the **A0→Argus distribution surface** (roadmap U6). The surrounding breakdown is current understanding, not a committed roadmap:

- **Argus→A0 depth (U7/U8)** — live-verify `delegate`/`heal:'a0'` against a reachable instance, plus scope and delegated-spend controls. Can proceed independently; the hosted A0 this plan verifies against is the same environment depth work would target later.
- **Prompt packs (roadmap U2)** — shares the "alternate invocation surfaces" theme but is independent; packs may later ship as plugin-adjacent content.
- **Flow-runtime hardening** — depends on the R12 verification outcome; exists only if the hosted tool env can't run Playwright and a fallback is warranted.
- **Local-diff review** — reviewing a checkout diff without a live PR (argus `--fixture` staging). Deferred; v0.1 takes a real PR reference.

### Actors

- A1. **A0 user** — asks their Agent Zero, in natural language, to review a PR or run a recorded flow against a checkout they control.
- A2. **A0 instance (hosted)** — the user's Agent Zero; loads the plugin and executes its tools inside A0's own tool-execution environment.
- A3. **argus CLI** — `argus-reviewer` (npm package `argus-reviewer-e2e`); does the review/flow work inside the checkout. Never posts to GitHub.
- A4. **GitHub** — the PR surface receiving a sticky comment when posting is requested.
- A5. **Community Plugin Index** — `agent0ai/a0-plugins`, the distribution surface the plugin is submitted to.

### Requirements

**Packaging**

- R1. The plugin is a standalone repo whose root contains `plugin.yaml`, MIT `LICENSE`, `README.md`, and `tools/`, matching the A0 `usr/plugins/<name>` contract.
- R2. `plugin.yaml` declares `name: argus` (`^[a-z0-9_]+$`, matching the index folder), `title`, `description`, `version`, and settings sections so A0 loads it from a local plugin directory.
- R3. After hosted verification passes, an index entry (`plugins/argus/index.yaml` with `title`, `description`, `github` — the only required fields) is submitted to `agent0ai/a0-plugins` as a PR.

**Tools**

- R4. `argus_review` invokes the argus code-review lane against a provided checkout + PR target and returns verdict, findings, and cost as text the A0 conversation can narrate.
- R5. `argus_flow` invokes the argus `run` (replay) lane against a provided checkout and returns flow status and cost as text.
- R6. Tools invoke the CLI from a plugin-vendored install of `argus-reviewer-e2e` (provisioned at plugin install); checkout-local binaries are used only on trusted checkouts — resolution is part of the trust boundary per KTD4.
- R7. Every tool failure mode (missing checkout, missing token, missing runtime, argus nonzero exit) returns a clear human-readable error, not a stack trace.
- R13. Each tool ships an agent-facing prompt fragment (`prompts/agent.system.tool.<tool_name>.md`) declaring the tool name, JSON call shape, arguments, and when to use it — A0 cannot discover call semantics from the Python file alone.

**Output and permissions**

- R8. Results narrate to the A0 conversation by default; a GitHub sticky comment is written only when the caller explicitly requests it for that invocation.
- R9. Posting uses a repo-scoped read+comment token whose env var name is configured in plugin settings; the plugin never ships or embeds a token.
- R10. The README instructs users to point the tools only at checkouts they trust, and explains that checkout code and config execute inside the A0 host's environment.

**Verification**

- R11. The plugin loads in the user's hosted A0 instance and `argus_review` returns a real verdict for a test PR before index submission.
- R12. `argus_flow` is smoke-tested on hosted A0; if the tool environment lacks Playwright or another flow-only runtime, v0.1 ships review-verified with flow documented behind a runtime requirement rather than blocked. Missing node/npm kills the review lane too — that triggers the Goal Capsule stop condition, not this fallback.

### Key Flows

```mermaid
flowchart LR
    U[A0 user] -->|asks in chat| A0[A0 instance]
    A0 -->|loads| P[plugin: argus_review / argus_flow]
    P -->|vendored CLI shell-out| CLI[argus CLI, cwd=checkout]
    CLI -->|JSON report| P
    P -->|narrate| A0
    P -.->|only when post flag set| GH[GitHub PR sticky comment]
```

- F1. **Review, narrated.** **Trigger:** user asks A0 to review a PR. A0 calls `argus_review` with `checkout` and `pr`; the tool validates, preflights, runs `code-review` in the checkout, parses the fresh `code-review.json`, and returns verdict/findings/cost text for A0 to narrate. **Covers R4, R6, R8.**
- F2. **Review + post.** **Trigger:** user explicitly asks for results posted. Same as F1 plus `post: true`; the plugin's own post lane upserts the sentinel sticky comment on the PR using the configured comment token. **Covers R8, R9; posting mechanism in KTD1.**
- F3. **Flow replay.** **Trigger:** user asks A0 to replay recorded flows in a checkout. `argus_flow` verifies `trust_checkout` is set, preflights browsers, runs `argus-reviewer run`, parses `run.json`, and returns pass/fail plus cost. **Covers R5, R6, R10.**
- F4. **Onboarding.** **Trigger:** user installs the plugin (local `usr/plugins/argus` clone or index install), `hooks.py` `install()` probes runtimes and caches the result, user sets env var names in plugin settings, first call fails clear if misconfigured. **Covers R7, R9, R10.**

### Acceptance Examples

- AE1. **Covers R7.** When `argus_review` is pointed at a nonexistent path or a checkout without argus, the tool returns a "no argus checkout at \<path\>" style error — not a Python traceback.
- AE2. **Covers R8.** When no post flag is given, nothing writes to GitHub even when a token is configured.
- AE3. **Covers R12.** When the hosted environment lacks node/npm, the tool reports the missing runtime plainly, and the README names the requirement.
- AE4. **Covers R9.** When a post-flagged review runs with the token env var unset, the tool refuses before spending on the review, with a "configure \<ENV_NAME\>" message.
- AE5. **Covers R5.** When `run` matches zero test files (argus exits 0 with `totals.tests: 0`), the tool narrates "no test files matched" rather than success.

### Success Criteria

- The plugin loads in the hosted A0 instance and a real PR review round-trips end to end (R11).
- The index submission PR is filed at `agent0ai/a0-plugins` — filing is the done bar; maintainer acceptance is external.
- The README takes a cold A0 user from install to first narrated review without needing support.
- No new config or secret surface lands in the argus repo — the plugin is a wrapper, not a product change.

### Scope Boundaries

**Deferred for later**

- Argus→A0 depth: live-verifying `delegate`/`heal:'a0'`, scope controls, delegated-spend ceilings (roadmap U7/U8).
- An argus HTTP surface — only if R11/R12 verification proves the CLI path can't run in A0's tool env.
- Ephemeral-A0-in-Actions and any GH Marketplace listing.
- Inline review comments and commit status on the post lane (v0.1 posts sticky only, per Key Decisions).
- `record` mode in `argus_flow` (interactive and browser-heavy; `run` replay only).
- Local-diff review without a live PR (argus `--fixture` staging).

**Outside this product's identity**

- Changes to Argus core review/flow behavior — the plugin wraps the CLI; argus-side additions are bounded to whatever output surface the tools strictly need (none currently required).
- Managed hosting, SaaS distribution, or anything that makes A0 a prerequisite for ordinary Argus use.

### Dependencies / Assumptions

- The user's hosted A0 instance can load a local plugin (`usr/plugins/argus` or equivalent).
- `argus-reviewer-e2e` is published on npm (released, bin `argus-reviewer`, engines `node >=20.19.0`).
- The hosted A0 tool environment provides node/npm, and for R5 a browser-capable runtime — **unverified**, gated by R11/R12.
- The A0 plugin format per primary docs: `plugin.yaml` + `tools/` + `prompts/` at root; index entry at `plugins/argus/index.yaml` in `agent0ai/a0-plugins` with fields `title`, `description`, `github` (`tags`, `screenshots` optional).
- The vendored CLI install (KTD4) requires registry reachability from the A0 tool env at plugin-install time.

### Outstanding Questions

- A0's per-tool wall-clock limit and whether `add_progress()` heartbeats extend it — **Deferred to Implementation** (checked during hosted smoke; timeouts are plugin settings).
- Whether hosted A0's tool env has node/npm/git/network/Playwright — gated by R11/R12 verification, not planning.
- Thumbnail/screenshot assets for the index entry (optional fields) — **Deferred**; index submission works without them.

### Sources / Research

- `docs/plans/2026-09-16-001-feat-full-reviewer-roadmap-plan.md` — U6 spec and the `npx` naming trap; U7/U8 deferred.
- `docs/plans/2026-09-14-006-feat-post-launch-roadmap-plan.md` — earlier U7/U8 with hosted-A0 deployment notes.
- `src/cli.ts`, `src/config.ts`, `src/trust.ts`, `src/report/run.ts`, `action/sticky-comment.mjs`, `action/action.yml` — the CLI contract this plugin wraps (see Planning Contract).
- `src/executor/a0.ts` — the existing Argus→A0 seam; opposite direction, shared subprocess patterns.
- `SECURITY.md` — `a0`/`heal` treated as exfil channels on untrusted checkouts; same trust reasoning drives R10 and KTD3.
- `STRATEGY.md` — track 3 (Agent Zero depth) framing.
- External (primary sources): `agent0ai/agent-zero` `skills/a0-create-plugin` + `skills/a0-contribute-plugin` + `docs/developer/plugins.md` (plugin.yaml schema, repo layout, lifecycle hooks, prompt fragments); `agent0ai/a0-plugins` README (index validation rules); `python/helpers/tool.py` (`Tool`/`Response` contract, `add_progress`).

---

## Planning Contract

### Key Technical Decisions

- KTD1. **Posting is a plugin-side sticky upsert.** The argus CLI never writes to GitHub — posting lives in `action/sticky-comment.mjs`. The plugin implements its own upsert in `helpers/`: list PR comments **paginating all pages** (the action only reads page 1 — plugin improves on it), find the sentinel `<!-- argus-reviewer -->`, `PATCH` else `POST` via the issues API. Reuses the action's sentinel deliberately — one argus comment per PR, last writer wins; README warns that repos also running the Argus action share the comment. Body mirrors the action's shape: sentinel first line, verdict/cost/`budgetExceeded` summary, findings table capped at 25 rows with `|`-escaped 200-char cells, well under the 65,536-char limit. `summary` and finding messages are model output shaped by PR-controlled diffs — the body sanitizes them (cell rules + length caps) and carries a fixed "automated review — verify findings before acting" line so a hostile diff can't steer a public comment under the token owner's identity. Governs R8, R9; mechanism for F2.
- KTD2. **Verdict comes from JSON, never exit code.** `code-review` exits 0 on skip (`skipped:true`, reason in `summary`) and on `verdict: needs_changes`; it exits 1 only on crash. The tool always passes `--report-dir` pointing at a **fresh per-invocation temp dir**, then parses `code-review.json` — eliminating the stale-report hazard from a crashed prior run. `ok:false`/`needs_changes`/`budgetExceeded` are narrated data, not tool errors. Governs R4, R7.
- KTD3. **Trust split per tool.** `argus_review` always injects `ARGUS_UNTRUSTED=1` — the checkout's `argus-reviewer.config.ts` never executes beside `OPENROUTER_API_KEY`/`GITHUB_TOKEN` in v0.1 (untrusted config honors only `logLevel`/`sourceGlobs`; model/budget/target silently default — the tool result notes "checkout config ignored" when the file exists). `argus_flow` cannot be protected this way — `run` imports and executes the checkout's test files and `pageSetup` modules regardless — so it **requires** the `trust_checkout` setting to run at all, and then runs trusted (`config.target`, `testsDir` honored). `trust_checkout` gates flow only; it never weakens review isolation. Governs R10.
- KTD4. **CLI resolution is part of the trust boundary.** Executing `<checkout>/node_modules/.bin/argus-reviewer` or `npx` with cwd=checkout runs checkout-controlled code — a forged shim defeats `ARGUS_UNTRUSTED` entirely. So: `hooks.py` `install()` vendors the CLI once (`npm install --prefix <plugin-dir> argus-reviewer-e2e[@<argus_version_pin>]`), and the default untrusted path spawns only `<plugin-dir>/node_modules/.bin/argus-reviewer` with cwd=checkout. Checkout-local `.bin` and `npx --no-install` are consulted **only** when `trust_checkout` is set; the vendored binary remains the fallback there too. Never bare `npx argus-reviewer` (package `argus-reviewer-e2e` ≠ bin `argus-reviewer`); vendoring at install also absorbs the `npx -p` cold-start download. Governs R6.
- KTD5. **Result shape is a compact narration block.** Fields: `verdict`, `summary`, counts by severity, top-N findings (`file`, `line`, `severity`, `category`, `message`, `evidence.status`, `p`; bug/risk first, N≈10), `model`, `tokens`, `visionCostUsd`, `budgetExceeded`, `skipped`+reason, degraded-lane notes (`secretsScan.skipped`, `probeLaneSkipped` — a security lane skipping silently is a finding, not a detail), `reportPath` (drill-down escape hatch — a host path the agent can open on request), and `posted`/`commentUrl` when `post:true`. Raw stdout/stderr tail (≤4KB) only on failure. Governs R4, R5, R8.
- KTD6. **Single flexible `pr` arg; `checkout` is just a working directory.** Accept `https://github.com/o/r/pull/N`, `o/r#N`, `o/r/pull/N`, or bare `N` (repo derived from the checkout's `origin` remote). Reject non-`github.com` hosts with "GitHub Enterprise not supported in v0.1". `checkout` falls back to `default_checkout`, and for `argus_review` it need not be a real clone — the diff comes from the GitHub API, so a writable scratch dir works (secrets scan degrades gracefully); a real checkout only matters for `argus_flow`. The prompt fragment tells the agent it may create a scratch dir rather than failing on "no checkout". Governs R4, R7.
- KTD7. **`hooks.py` probes, never enforces.** `install()` checks `node --version` (≥20.19), `npx`, `git`, and Playwright browser caches (both `~/.cache/ms-playwright` and macOS `~/Library/Caches/ms-playwright`), caches results to a plugin-local JSON, and always succeeds — a hosted env without node must not break plugin load; tools surface the cached gap as a friendly preflight error. Governs R11, R12, AE3.
- KTD8. **Progress via stderr/stdout streaming; kill on every exit path.** The child stream carries `openrouter … $cost` per-call lines, warnings/errors, and completion summaries — stage lines are `live.ndjson`-only and `debug()` needs `ARGUS_DEBUG=1`, so progress is coarser than stage granularity (acceptable for v0.1). `live.ndjson` tailing is skipped — shared per-checkout, rotated at ~1MB, interleaved under concurrency. `run_argus` kills the **process group** (npx→node child) in a `finally`/atexit covering every exit path — timeout, exception, and A0-side cancellation — so an aborted call can't orphan a spending child; the streaming loop periodically calls `self.agent.handle_intervention()` so user abort reaches the tool. Governs R7.
- KTD9. **Preflights before spend.** Before spawning: `node`/`npx` presence (cached from KTD7), required env vars set, and `GET /repos/{o}/{r}/pulls/{n}` with the token to disambiguate 404/401/403 that would otherwise collapse into "could not fetch PR diff". `post:true` with unset comment token fails **before** the review runs (AE4). Governs R7, R9.
- KTD10. **Plugin settings carry env-var names and policy, never values.** `default_config.yaml` keys: `github_token_env` (default `GITHUB_TOKEN`), `comment_token_env` (default same), `openrouter_key_env` (default `OPENROUTER_API_KEY`), `trust_checkout` (default `false`; gates `argus_flow` only), `review_timeout_s` (1200), `flow_timeout_s` (1800), `argus_version_pin` (empty = latest), `flow_budget_usd` (empty = uncapped; injected as `ARGUS_BUDGET_USD`, honored by `run` — **reviews run uncapped in v0.1**: `code-review` reads its cap only from `codeReviewBudgetUsd`, which untrusted mode ignores), `default_checkout` (empty). Tool args: `checkout`, `pr`, `post` (review); `checkout`, `url`, `pattern` (flow). Governs R9.
- KTD11. **Subprocess env is an allowlist, not a passthrough.** Ambient `os.environ` leaks unrelated secrets and control vars — `ARGUS_SANDBOX=1` would force-enable the Docker probe lane, `GH_TOKEN`/`GIT_*`/`NODE_OPTIONS`/`NPM_CONFIG_*`/`GITHUB_*`/`ACTIONS_*`/`ARGUS_*` all influence the child. Build child env from an allowlist (`PATH`, `HOME`, `USER`, `LANG`/`LC_*`, `TMPDIR`, proxy/SSL vars) plus explicit overlays only: resolved token values, `ARGUS_REVIEWER_TRACE` (`{"repo","pr"}`), `ARGUS_UNTRUSTED`, `ARGUS_BUDGET_USD`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null` (a hostile `.git` can arm `core.hooksPath`/credential helpers). Secrets travel via env only — never argv, never `self.args`, never echoed in errors/progress; streamed lines are scrubbed for `https://<userinfo>@` patterns before `add_progress`. Governs R9, R10.

### High-Level Technical Design

```mermaid
sequenceDiagram
    participant A0 as A0 agent
    participant T as tools/argus_review.py
    participant H as helpers/argus.py
    participant C as argus CLI (in checkout)
    participant G as GitHub API

    A0->>T: execute(checkout, pr, post?)
    T->>H: normalize pr, realpath checkout
    H->>H: preflight: node/npx, env vars, GET /pulls/{n}
    alt post:true and no comment token
        H-->>T: fail fast (AE4)
    end
    T->>H: resolve CLI (KTD4 chain)
    H->>C: spawn: env overlay + --report-dir <fresh temp>
    C-->>H: stream stderr/stdout lines -> add_progress
    C->>C: write code-review.json (atomic)
    H->>H: parse report -> narration block (KTD5)
    opt post:true
        H->>G: list comments (paginated) -> PATCH else POST sticky
    end
    T-->>A0: Response(message=narration, break_loop=False)
```

`argus_flow` follows the same skeleton with `trust_checkout` gate, `url` required (explicit target in v0.1 — never silently inherited from `config.target`), Playwright preflight, `run.json` parse, and `totals.tests == 0` → "no test files matched" narration (AE5).

### Assumptions

- Hosted A0's tool env has node/npm/git/network — verified by R11 smoke, not assumed into the design; the KTD7 probe contract degrades cleanly if absent.
- A0 runs tools via `helpers.tool.Tool` with `self.args`/`add_progress`/`Response(message, break_loop)` — grounded in `python/helpers/tool.py`; exact per-tool wall-clock limit deferred to implementation.
- `code-review` needs no local-diff path for v0.1 — every review targets a real PR reachable by the configured token.

### Sequencing

U1 → U2 → U4 → U3 → U5 → U6 → U7. U4 precedes U3 because the review tool calls the post helper; U5 shares U2's runner; U7 is external verification and must come last.

### Risks & Dependencies

| Risk | Mitigation |
|---|---|
| Hosted A0 tool env lacks node/npm (unverified) | Nothing runs — hard stop condition, HTTP hedge re-evaluation (R12 covers only flow-only gaps like missing Playwright) |
| Hosted A0 tool env lacks Playwright (unverified) | KTD7 probe → friendly preflight error; R12 ships review-verified with flow behind a runtime note |
| Checkout `config.ts` executes inside the A0 host beside `OPENROUTER_API_KEY`/`GITHUB_TOKEN` | `ARGUS_UNTRUSTED=1` unconditional on review (KTD3); README trust warning (R10) |
| Checkout-committed `node_modules/.bin` shim executes beside secrets | Vendored plugin-owned binary is the only untrusted resolution; checkout `.bin`/npx only under `trust_checkout` (KTD4) |
| Hostile `.git` arms `core.hooksPath`/credential helpers | `GIT_CONFIG_NOSYSTEM=1` + `GIT_CONFIG_GLOBAL=/dev/null` in child env (KTD11); README limits flow checkouts to self-cloned repos |
| Ambient host env leaks secrets/control vars (`ARGUS_SANDBOX`, `GH_TOKEN`, `NODE_OPTIONS`) into the child | Allowlist env builder (KTD11) |
| `run` executes checkout test files regardless of trust flags | `argus_flow` requires `trust_checkout` (KTD3); prompt fragment states the warning |
| Tokens exposed via `ps`, A0 arg logs, or error text | Env-only secret transport (KTD11); settings carry env-var names not values (KTD10); never echo token values; `https://<userinfo>@` scrub on streamed lines |
| `npx` interactive prompt hangs the tool | Vendored install avoids npx on the untrusted path; `--yes` + stdin `DEVNULL` mandatory where npx is used (KTD4) |
| Stale `code-review.json` from a crashed prior run misread as current | Fresh per-invocation `--report-dir` (KTD2) |
| 401/403/404/network all collapse into "could not fetch PR diff" | PR preflight `GET /pulls/{n}` disambiguates before spend (KTD9) |
| `run` with zero matched tests exits 0 looking like success | `totals.tests == 0` narrated as "no test files matched" (AE5) |
| Concurrent posts create duplicate stickies / plugin and Argus action overwrite each other | Paginated comment listing; shared sentinel documented in README (KTD1); inherent REST race documented |
| `post:true` burns OpenRouter spend then can't post | Fail-fast token check before spawn (KTD9, AE4) |
| Model output shaped by hostile PR diffs steers a public comment under the token owner's identity | Sanitized summary/cells + fixed "automated review — verify findings" disclaimer (KTD1) |
| Vendored install needs registry reachability at plugin-install time | `argus_version_pin` setting; install() failure → friendly "re-run install when online" probe error (KTD4, KTD7) |
| Aborted/cancelled tool call orphans a spending child | Process-group kill in `finally` on every exit path + `handle_intervention` polling (KTD8) |
| Users assume `budget_usd` caps review spend — it doesn't (untrusted config ignores `codeReviewBudgetUsd`) | Renamed `flow_budget_usd`, flow-scoped (KTD10); README states reviews are uncapped in v0.1 |
| Reviews/flows run for minutes inside an agent tool call | Timeout plugin settings; stderr/stdout → `add_progress` (KTD8); process-group kill on timeout |

**Dependencies:** npm registry (`argus-reviewer-e2e`), api.github.com, the user's hosted A0 instance, `agent0ai/a0-plugins` for distribution. All external; each has a stated degradation path above.

---

## Output Structure

```text
a0-plugin-argus/                  <- standalone repo root (clone into usr/plugins/argus)
├── plugin.yaml                   # runtime manifest (name: argus)
├── LICENSE                       # MIT — required at root for index submission
├── README.md                     # install, settings, trust model, token scopes
├── default_config.yaml           # plugin setting defaults (KTD10)
├── hooks.py                      # install()/uninstall() — runtime probes (KTD7)
├── helpers/
│   └── argus.py                  # shared runner, CLI resolution, parsing, post lane
├── tools/
│   ├── argus_review.py           # Tool subclass (F1, F2)
│   └── argus_flow.py             # Tool subclass (F3)
├── prompts/
│   ├── agent.system.tool.argus_review.md   # agent-facing call contract (R13)
│   └── agent.system.tool.argus_flow.md
└── tests/
    ├── fakebin/                  # fake argus-reviewer executable writing fixture JSON
    └── test_helpers.py           # unit tests for helpers + tool logic
```

## Implementation Units

### U1. Plugin skeleton, manifest, lifecycle probes

**Goal:** A loadable plugin repo scaffold — manifest, license, settings defaults, and an `install()` hook that probes (never enforces) the runtime.

**Requirements:** R1, R2, R10 (settings surface), KTD7, KTD10.

**Dependencies:** none.

**Files:** `plugin.yaml`, `LICENSE`, `default_config.yaml`, `hooks.py`, `README.md` (stub — full content in U6), `.gitignore`.

**Approach:** `plugin.yaml` carries `name: argus`, `title: Argus PR Reviewer`, description, `version: 0.1.0`, `settings_sections: [external]` (credentials-adjacent settings), `per_project_config: false`, `per_agent_config: false`. `default_config.yaml` holds the KTD10 keys. `hooks.py` `install()` runs the KTD7 probe set with ~3s timeouts each, caches results to `helpers/probe-cache.json`, vendors the CLI (`npm install --prefix <plugin-dir> argus-reviewer-e2e[@<argus_version_pin>]` when node/npm are present — KTD4), and always returns success; `uninstall()` removes only plugin-owned artifacts (probe cache, vendored `node_modules`). MIT license text, copyright Luke Kimball. `.gitignore` for `__pycache__`, probe cache, vendored `node_modules`, test artifacts.

**Patterns to follow:** `agent0ai/agent-zero` `skills/a0-create-plugin` manifest contract and `skills/a0-contribute-plugin` repo layout; `python/helpers/tool.py` import conventions (`from helpers.tool import Tool, Response`).

**Test scenarios:**
- `plugin.yaml` parses as YAML; `name` matches `^[a-z0-9_]+$` and equals `argus`.
- `python3 -m compileall` passes on `hooks.py` and all Python files.
- `install()` on a machine without node writes a probe cache marking node absent and returns without raising (simulate by PATH manipulation in test).
- `install()` is rerunnable — second call overwrites cache, no duplicate state.

**Verification:** plugin directory structure loads in a real or mocked A0 plugin-dir scan; probes reflect actual environment.

### U2. Shared runner (`helpers/argus.py`)

**Goal:** One module owning everything both tools need: settings resolution, PR-arg normalization, preflights, CLI resolution, the subprocess runner, and report parsing → narration shape.

**Requirements:** R6, R7, KTD2, KTD4, KTD5, KTD6, KTD8, KTD9, KTD10, KTD11.

**Dependencies:** U1.

**Files:** `helpers/argus.py`, `tests/test_helpers.py`, `tests/fakebin/argus-reviewer` (fake CLI), `tests/fakebin/npx` (resolution-chain stub).

**Approach:**
- `normalize_pr(pr, checkout)` → `(owner, repo, number)` per KTD6; bare `N` derives repo via `git -C <checkout> remote get-url origin`; rejects non-github.com hosts.
- `resolve_settings()` merges `default_config.yaml` with runtime plugin config.
- `preflight_review(...)` → checks node/npx (KTD7 cache), env vars present, `GET /repos/{o}/{r}/pulls/{n}` (disambiguate 404/401/403/network); `post` without comment token fails here.
- `resolve_cli(checkout, trusted)` → KTD4 chain: untrusted → vendored bin only; trusted → checkout `.bin` → `npx --no-install` → vendored.
- `run_argus(argv, cwd, env_overlays, timeout, on_line)` → `asyncio`/`subprocess` with `start_new_session=True`, stdin `DEVNULL`, streams scrubbed lines (KTD11 userinfo patterns) to `on_line` (→ `add_progress`), kills the process group in `finally` on every exit path (KTD8), returns `{code, stdout_tail, stderr_tail, timed_out}` — never raises on spawn failure (ENOENT → readable error result), per the `defaultExec` pattern in `src/detect.ts`.
- `fresh_report_dir()` → `tempfile.mkdtemp` under the checkout or system temp; kept after run (report path is narrated for drill-down).
- `parse_review_report(dir)` / `parse_run_report(dir)` → narration dict per KTD5; absent file → explicit "no report written" result.
- Env builder per KTD11 (allowlist + overlays; `ARGUS_UNTRUSTED=1` on review, trusted overlays on flow per KTD3).

**Test scenarios:**
- `normalize_pr` accepts all four input forms; rejects `gitlab.com/...` and malformed strings with a format-listing error.
- Bare-number PR with no parseable origin remote → targeted error naming the fix.
- `resolve_cli` never emits bare `npx argus-reviewer` and never invokes npx with cwd=checkout on the untrusted path.
- `run_argus` on a fake CLI that sleeps past timeout → `timed_out`, process group dead, error text names the timeout setting; simulated exception/cancellation also kills the group (KTD8).
- `run_argus` on a missing binary → readable "not found" result, no traceback.
- `resolve_cli` on untrusted returns the vendored path even when a checkout `.bin` exists; on trusted prefers checkout `.bin`.
- Env builder is allowlist-only: ambient `ARGUS_SANDBOX`, `GH_TOKEN`, `GITHUB_EVENT_NAME`, `NODE_OPTIONS` never reach the child; `GIT_CONFIG_NOSYSTEM`/`GIT_CONFIG_GLOBAL` are set.
- Fixture provenance: fixture `code-review.json`/`run.json` are captured from real CLI output (`code-review --fixture`, demo `run`) with a version comment, or key-asserted against the TS report interfaces — not hand-authored.
- `parse_review_report` on fixture `code-review.json` (verdict `needs_changes`, findings, `budgetExceeded`) → correct narration fields; `ok:false` does not raise.
- `parse_review_report` on `skipped:true` fixture → skip reason surfaced verbatim.
- Missing report file → "no report written" not a parse crash.
- Env builder never places token values in argv or `self.args`.
- Covers AE1: nonexistent checkout path → readable error.

**Verification:** `python3 -m pytest tests/` (or `unittest`) green against fake binaries; no real CLI needed.

### U3. `argus_review` tool + prompt fragment

**Goal:** The A0-facing review tool wired onto U2, plus its agent-facing prompt.

**Requirements:** R4, R7, R8, R13, AE1–AE4.

**Dependencies:** U2, U4 (post helper).

**Files:** `tools/argus_review.py`, `prompts/agent.system.tool.argus_review.md`.

**Approach:** `class ArgusReview(Tool)` with `async def execute(**kwargs) -> Response`; reads `checkout`/`pr`/`post` from `self.args` (checkout falls back to `default_checkout` setting). Sequences: normalize → preflight (KTD9; AE4 fail-fast) → resolve CLI → `run_argus(['code-review','--report-dir',tmp])` with progress streaming → parse → narration `Response(message=..., break_loop=False)`. On `post:true` success, invoke U4's post lane and append `posted: <commentUrl>` to the message. Prompt fragment declares tool name `argus_review`, JSON args with defaults, narrate-default semantics, and "posts a public comment — only pass post:true when the user asked".

**Test scenarios:**
- Happy path with fake CLI writing `code-review.json` → Response message contains verdict, finding count, cost.
- `skipped:true` report → message narrates the skip reason, no error framing.
- `post:true` + missing comment token env → refusal before the fake CLI is spawned (assert no spawn).
- Fake CLI exits 1 with stderr tail → message includes mapped error text, not a traceback.
- `needs_changes` verdict → normal Response (not an error path).
- Covers AE1, AE2 (no-post → zero GitHub calls), AE4.

**Verification:** unit tests via fake CLI + stubbed post lane; tool class imports cleanly under A0's `helpers.tool` contract (validated in U7 against real A0).

### U4. Post lane (sticky upsert)

**Goal:** `helpers/` posting function implementing the KTD1 sentinel upsert, scoped to sticky-comment only.

**Requirements:** R8, R9, AE2, AE4, KTD1.

**Dependencies:** U2.

**Files:** `helpers/argus.py` (post functions); `tests/test_helpers.py` additions.

**Approach:** `post_sticky(owner, repo, pr, body, token)` → paginated `GET /repos/{o}/{r}/issues/{n}/comments` (all pages), find `<!-- argus-reviewer -->` sentinel → `PATCH /issues/comments/{id}` else `POST`. `render_sticky_body(report)` mirrors `action/sticky-comment.mjs`: sentinel first line, verdict + cost + `budgetExceeded` + triage line, findings table capped at 25 rows, `|`→`\|` and newline→space cell sanitization, 200-char cells, and a fixed "automated review — verify findings before acting" disclaimer (KTD1 — model text is shaped by PR-controlled diffs). Handles: PATCH-404 → retry as POST; 422 → truncate findings further, retry once; 403/404 with scope guidance in error text; rate-limit → surface `Retry-After`, no retry loop. On review crash (no parsed report) → never post. Skipped reviews may post (action renders skipped bodies).

**Test scenarios:**
- No existing sentinel comment → POST issued; body starts with sentinel.
- Existing sentinel on page 2+ of comments → PATCH that comment (regression vs the action's page-1-only read).
- PATCH 404 → POST fallback.
- Body renderer: 30 findings → 25 rows; `|`/newline cells sanitized; `budgetExceeded` line present.
- Token 403 → error text names the needed scope (Issues: read+write / repo scope), never echoes the token.
- `post:false` path → zero HTTP calls (mock-asserted).
- Covers AE2, AE4.

**Verification:** unit tests against a stubbed HTTP layer (injected request function); no live GitHub calls in tests.

### U5. `argus_flow` tool + prompt fragment

**Goal:** The A0-facing flow-replay tool wired onto U2.

**Requirements:** R5, R7, R10, R13, AE3, AE5, KTD3.

**Dependencies:** U2.

**Files:** `tools/argus_flow.py`, `prompts/agent.system.tool.argus_flow.md`.

**Approach:** `class ArgusFlow(Tool)`; args `checkout` (falls back to `default_checkout`, same as `argus_review`), `url` (required — the replay target is explicit in v0.1, never silently inherited from the checkout's `config.target`), `pattern` (optional). `url` is validated to reject embedded userinfo (`https://user:pass@host`) — args are logged by A0 and argv is visible via `ps` (KTD11). Gate: `trust_checkout` setting must be true, else return text explaining the tool executes checkout test code and how to enable it. Preflights: Playwright browser caches (both platform paths) — missing → "run `npx playwright install chromium`" text (sudo caveat noted). Runs `run [pattern] --url <url> --report-dir <fresh>`, streams progress, parses `run.json`: `totals.tests == 0` → "no test files matched" (AE5); per-test failures narrated with `failureMessage`s; `budgetExceeded` surfaced. `flow_budget_usd` setting injects `ARGUS_BUDGET_USD` (honored by `run` even untrusted — moot here since trusted, but consistent). Prompt fragment states the code-execution warning and the `trust_checkout` requirement.

**Test scenarios:**
- `trust_checkout=false` → refusal text, no spawn.
- Missing Playwright cache dirs → install-hint error (PATH/env-simulated).
- Fake CLI writing `run.json` with `totals.tests: 0` → "no test files matched" message (AE5).
- `run.json` with 2 passed / 1 failed → narration lists the failed test and reason; exit-1 handled as data.
- `url` missing → targeted error stating the target must be passed explicitly in v0.1.
- Covers AE3 (missing runtime → plain error), AE5.

**Verification:** unit tests via fake CLI; real replay smoke deferred to U7 (hosted env capability-dependent).

### U6. README and onboarding docs

**Goal:** Complete user-facing documentation satisfying R10 and the success criterion "cold user to first narrated review without support".

**Requirements:** R10, R1.

**Dependencies:** U3, U4, U5 (documents the shipped surface).

**Files:** `README.md`.

**Approach:** Sections: what it does (one paragraph); install (clone to `usr/plugins/argus` / index install — install() vendors the argus CLI); **credentials** — set `GITHUB_TOKEN`/`OPENROUTER_API_KEY` as env vars on the A0 *host* (hosted A0: wherever its env is configured), never as token values in plugin settings; requirements table (node ≥20.19, npx, git, Playwright for flow); settings table (KTD10 keys with defaults); token scopes (fine-grained: Pull requests read + Issues read&write for posting + Contents read for the secrets scan/diff + Checks read for the evidence lane; classic: `repo`/`public_repo`); tool usage examples (review narrated, review+post, flow replay); **`checkout` semantics** — review needs only a writable working dir (a scratch dir works — the diff comes from the API); flow needs a real trusted checkout; **trust model section** — `ARGUS_UNTRUSTED=1` unconditional on review, what config keys are ignored, `trust_checkout` meaning and that it gates flow only, the code-execution warning (checkout config, test files, and a hostile `.git`'s hooks/credential helpers all run inside the A0 host's environment — point flow only at self-cloned repos you'd hand a terminal to); sentinel sharing note; troubleshooting table (skip reasons, "could not fetch PR diff" disambiguation, vendored-install/registry notes, playwright install sudo caveat); v0.1 limits (sticky-only posting, replay-only flow, no local-diff mode, GitHub.com only, **reviews uncapped — `flow_budget_usd` caps flow spend only**, review spend reported after the fact).

**Test scenarios:**
- `Test expectation: none` — docs unit; verify by a cold read-through against the shipped settings/args (consistency check in U7).

**Verification:** every documented setting/arg/env name matches the implementation; trust warning is prominent (R10).

### U7. Hosted verification + index submission

**Goal:** Prove the plugin in the user's real hosted A0 (R11, R12) and file the index PR (R3).

**Requirements:** R3, R11, R12, AE3.

**Dependencies:** U1–U6.

**Files:** `plugins/argus/index.yaml` (in a fork of `agent0ai/a0-plugins`; thumbnail deferred).

**Approach:** Clone the plugin repo into the hosted A0's `usr/plugins/argus` (or install path the hosted app exposes); configure settings (env var names, `trust_checkout`); run `install()` probes and record the capability matrix (node/npm/git/network/Playwright — resolving the unverified assumption). Round-trip: ask A0 to review a real test PR (e.g., an open Argus PR) → verify narration contains verdict + findings + cost; exercise `post:true` → verify exactly one sticky appears; second `post:true` → updated not duplicated. Attempt `argus_flow` replay → if Playwright/runtime absent, ship review-verified per R12 with the runtime requirement documented. Then fork `agent0ai/a0-plugins`, add `plugins/argus/index.yaml` (`title`, `description`, `github` required; `tags` e.g. `code-review`, `testing`, `github`), open the submission PR.

**Test scenarios:**
- Plugin appears in A0's plugin list and tools are callable (load, not just file presence).
- Real conversation: "review PR #N on duketopceo/Argus in checkout X" → narrated verdict + at least one `file:line` finding + cost.
- Missing-token run → actionable error text surfaced in chat (no traceback).
- `post:true` twice → single sticky, updated.
- Flow attempt → either a real replay narration or the documented runtime-requirement path (R12).
- Interrupting a tool call mid-run leaves no orphaned argus/npx/node child process (KTD8).

**Verification:** R11/R12 acceptance met; index PR filed (maintainer merge is external). If the hosted env cannot run the CLI at all → stop condition: report and re-evaluate the HTTP hedge rather than shipping.

---

## Verification Contract

- **Python sanity:** `python3 -m compileall hooks.py helpers/ tools/ tests/` clean.
- **Unit tests:** `python3 -m pytest tests/ -v` (or `unittest discover`) — all green against `tests/fakebin/` fakes; no network, no real CLI.
- **Manifest:** `plugin.yaml` parses; `name: argus` matches `^[a-z0-9_]+$` and the index folder name.
- **Contract lint:** tool classes subclass `helpers.tool.Tool`, implement `async execute(**kwargs) -> Response`, and ship matching `prompts/agent.system.tool.*.md` fragments (R13).
- **Hosted smoke (U7):** the R11/R12 checklist — plugin loads, real PR narrates, post flag writes one sticky, flow either replays or documents its runtime gap.
- **Index:** submission PR conforms to `agent0ai/a0-plugins` validation (one folder, `index.yaml` required fields only); filing a conforming PR is the done bar — external CI/maintainer failures outside the entry's own fields don't block it.

## Definition of Done

**Global**

- All units committed on the plugin repo's feature branch and PR'd; verification contract green.
- R11 met: a real PR review round-trips in hosted A0 with narration.
- Index submission PR filed at `agent0ai/a0-plugins` (filing is the bar; merge is external).
- No token values anywhere in repo, logs, args, or error text; no argus-repo changes required or made.
- Abandoned-approach code (e.g., an unused HTTP-surface spike, dead prompt fragments) removed from the diff.

**Per unit**

- U1: manifest loads; probes run idempotently; `Test expectation: none` where noted.
- U2: all enumerated test scenarios pass against fake binaries; no tracebacks on any failure path.
- U3: review round-trip narrates verdict/findings/cost from a parsed report; AE1/AE2/AE4 covered.
- U4: sticky upsert dedupes across paginated comments; AE2/AE4 covered.
- U5: trust gate holds; AE3/AE5 covered.
- U6: docs match shipped surface; trust warning present.
- U7: R11/R12 checklist executed and results recorded; index PR filed.
