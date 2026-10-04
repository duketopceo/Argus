# argus-reviewer-e2e quickstart

> Self-hosted, BYOK OpenRouter UI regression and code review for GitHub PRs.

## 1. Install

```bash
npm i -D argus-reviewer-e2e
```

## 2. Configure

Create `argus-reviewer.config.ts` in the repo root:

```ts
import { defineConfig } from 'argus-reviewer-e2e'

export default defineConfig({
  model: 'google/gemini-2.5-flash-lite',
  escalation_model: 'anthropic/claude-sonnet-4',
  code_model: 'deepseek/deepseek-v4-flash',
  budgetUsd: 1.0,
  target: {
    // command: 'npm run dev' if the target needs a local server started
    url: 'https://your-app.example.com',
    readyTimeoutMs: 10_000,
  },
  testsDir: 'e2e',
  cacheDir: '.argus-reviewer-cache',
  reportDir: 'argus-reviewer-report',
})
```

## 3. Record a flow

```bash
npx argus-reviewer record "sign in and open the dashboard" --name dashboard
```

This writes the cache and generates `e2e/dashboard.test.ts`.

## 4. Run the test

```bash
npx argus-reviewer run
```

Results and cost are written to `argus-reviewer-report/`.

## 5. Add the GitHub Action

Create `.github/workflows/argus-reviewer.yml`:

```yaml
name: argus-reviewer
on:
  pull_request:
    types: [opened, synchronize, reopened]
  workflow_dispatch:

permissions:
  contents: read
  issues: write
  pull-requests: write
  checks: write
  statuses: write

jobs:
  review:
    runs-on: self-hosted
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: npm
      - run: npm ci
      - run: npx playwright install chromium
      - uses: duketopceo/Argus/action@main
        with:
          openrouter-api-key: ${{ secrets.OPENROUTER_API_KEY }}
```

Add `OPENROUTER_API_KEY` to the repository secrets.

### Browsers

Chromium is the default. To run under Firefox or WebKit, set `browser` in the
config and install the matching Playwright browser:

```ts
// argus-reviewer.config.ts
export default defineConfig({
  browser: 'firefox',
})
```

```bash
npx playwright install firefox   # or webkit
```

When using the GitHub Action, pass the `browser` input (it installs the named
browser) and set the same value in your config. The coordinate grid and video
recording are browser-agnostic.

### Model speed tiers

Because Argus is BYOK, "review speed" is a model + routing choice, not a
pricing tier. OpenRouter routes each model slug to inference providers —
including **Cerebras** and **Groq**, which serve supported models in seconds
instead of tens of seconds. Two knobs:

```ts
export default defineConfig({
  // Fast — a high-throughput model routed to fast providers. Provider
  // preference is applied to every OpenRouter request Argus makes:
  code_model: 'meta-llama/llama-3.3-70b-instruct',
  provider: { order: ['cerebras', 'groq'], allow_fallbacks: true },
  // Deep — for risky changes, a stronger reasoner (and raise
  // codeReviewBudgetUsd to match):
  //   code_model: 'anthropic/claude-sonnet-4'
})
```

`provider.order` prefers Cerebras/Groq first but still falls back if neither
serves the model; `provider.only` would hard-restrict instead. Provider slugs
are validated against a known list and warn on typos.

Reasoning models (`deepseek/deepseek-v4.1-flash`, `z-ai/glm-5.3`) can take
longer than the default 120 s per request in realtime. Raise it with
`review: { requestTimeoutMs: 600_000 }` or `ARGUS_REQUEST_TIMEOUT_MS=600000`
(integer ms, 1 to 900000; anything else is an error).

The caller environment can also pin the code-review model without touching
the checkout: `ARGUS_CODE_MODEL="owner/model"` wins over `code_model` in
config — including on `pull_request` events, where the PR's config never
executes. This is how the GitHub Action and the Agent Zero plugin choose a
review model per deployment. The verified per-lane model menu lives in
[docs/models.md](models.md).

### Review lenses

`review.profiles` appends named rubric blocks to the review prompt —
`'security'`, `'perf'`, `'debloat'` — tuning recall without changing the
severity gate or posting policy:

```ts
export default defineConfig({
  review: { profiles: ['security', 'perf'] },
})
```

or per deployment: `ARGUS_REVIEW_PROFILES="security,perf"` (action input
`review-profiles`). The `security` lens runs alongside the always-on
deterministic secrets scan — the rubric steers the model toward
exploitability; the regex lane catches secret-shaped literals even when the
model doesn't.

Spend is still yours:
the `run.json` ledger records the per-run dollar figure regardless of which
provider served the call.

### Large PRs

A diff over about 6k tokens is split into chunks, grouped by directory, and
each chunk is one model call; a single file larger than that is split at hunk
boundaries. Findings from all chunks are merged (and synthesized when there is
more than one). The summary says `Reviewed all N chunks (X of Y files)`, and
`code-review.json` carries the same numbers in `scope.chunksTotal`,
`scope.chunksReviewed` and `scope.unreviewedFiles`.

Spend is metered per chunk. Before each chunk after the first, the run checks
the budget (`codeReviewBudgetUsd` or `ARGUS_BUDGET_USD`) against the mean chunk
cost so far; if the next chunk is not expected to fit, it stops without
spending and the summary reads `Reviewed 3 of 7 chunks (...); N file(s) were
not reviewed`.

### Batch mode

```ts
review: { mode: 'batch', batchTimeoutMs: 480_000 }   // default mode: 'realtime'
```

`mode: 'batch'` submits every chunk in one request to OpenRouter's async Batch
API (`POST /api/v1/batches`, then `GET /api/v1/batches/:id` until
`completed`, `failed`, `expired` or `cancelled`) and maps each result back by
`custom_id`. Override per run with `argus-reviewer code-review --mode batch` or
`ARGUS_REVIEW_MODE=batch` (the operator lever for fork PRs, whose config never
loads). The batch model is `review.batchModel` (`--batch-model`,
`ARGUS_BATCH_MODEL`), default `deepseek/deepseek-v4.1-flash:batch`: the
realtime default `deepseek/deepseek-v4-flash` has no batch endpoint, so batch
uses its own slug (or `<code_model>:batch` when that model is known to have
one). The model is sent as its base slug; a `:batch` suffix is stripped.
Batch is the recommended mode for large PRs: in the bake-off 62% of its
findings were judged valid against 27% for the cheaper realtime default.

Batches finish in minutes (a real probe took about six). Polling stops at
`batchTimeoutMs` (default 8 minutes) so the run stays inside the workflow's
15-minute job timeout with room for the fallback: if the batch fails, expires,
times out, or an individual request errors, those chunks run realtime. Cost is
read from each batch response's usage and recorded in the same ledger as
realtime calls. The final synthesis call (multi-chunk PRs) always runs realtime.
`code-review.json` carries `batch: { used, chunks, retriedRealtime?, fellBack? }`.

Budget caveat: a batch is submitted whole, so `codeReviewBudgetUsd` cannot stop
it mid-way the way it stops realtime chunks; the spend is metered once the
results arrive.

### Agent Zero delegation (optional)

If you run an [Agent Zero](https://agent-zero.ai) instance — the launcher, a
Docker container, or a remote host — Argus can hand it autonomous tasks. `init`
detects it automatically (via the `a0` CLI, `AGENT_ZERO_HOST`,
`~/.agent-zero/.env`, or a local probe) and writes a **commented suggestion**
into the generated config — A0 lanes are always opt-in, never enabled by
scaffolding. Zero extra config is needed when the `a0` CLI already knows
your instance.

```ts
// argus-reviewer.config.ts — or let `init` fill this in
export default defineConfig({
  a0: { url: 'https://your-a0.example.com' },
  heal: 'a0',
})
```

Two things this unlocks:

- `argus-reviewer delegate "click through the signup flow" --url http://localhost:3000`
  sends the whole task to the instance — it clicks through on its own
  browser/desktop and streams back the result.
- `heal: 'a0'` gives every failed test an autonomous second opinion: after a
  local replay/heal failure, the instance clicks through the app itself and
  reports whether the app is broken or the expectation is stale. The diagnosis
  lands in `run.json` as `a0Diagnosis`.

Delegation is a full-cost, non-deterministic agent run — it complements the
~$0 fingerprint replay, it does not replace it. Least-privilege scoping
(browser-only vs full `computer_use`) is configured on the instance's gateway,
not in this config. `heal: 'a0'` is capped at 15 minutes total per run so a
failing suite cannot block CI indefinitely.

## The `verify` lanes — review · flow · app · a0

`argus-reviewer verify` is the product surface: it runs the selected lanes and
writes `run-manifest.json` into `reportDir`, the evidence contract the PR
sticky comment renders. (A terminal view and a desktop dashboard also read
it, but they are contributor tools that run only from a clone of this repo;
the npm package does not ship them.) Every lane reports an honest status
(`passed`/`failed`/`skipped`/`blocked`/`unavailable`/`inconclusive`), usage,
budget, and head binding; a lane that could not run says so rather than
silently no-opping.

| Lane | How to select | Notes |
|---|---|---|
| `review` | selected by default | Diff review — the code-review-only path `init` scaffolds |
| `flow` | `--flow` or action input `run: 'true'` | Cache-first replay of recorded journeys |
| `app` | `--app --task "..."` or action inputs `app`/`app-task` | Directed task + expected-state check |
| `a0` | `--a0` or action input `a0: 'true'` | Delegation to your A0 host — always `inconclusive`/`unavailable`, never `passed` |

### `verify --app` — directed task lane

```bash
npx argus-reviewer verify --app \
  --url http://localhost:3000 \
  --task "sign in and open the dashboard" \
  --expect-text "Welcome back"        # or --expect-url '/dashboard' --expect-selector '#nav'
```

The lane starts `target.command` if the app is not already running, drives a
real browser through the task, and checks the expected state. It is `blocked`
on untrusted checkouts and when no task is configured (no provider call is
made). Action inputs: `app`, `app-task`, `app-url`, `app-expect-text`,
`app-expect-url`, `app-expect-selector`. Budget: `app.budgetUsd` +
`app.timeoutMs` in config.

### `verify --a0` — escalation seam

```bash
npx argus-reviewer verify --a0 --task "find the checkout bug"
```

Delegates the task to your configured Agent Zero host inside a sanitized,
allowlisted child environment (provider keys, `GITHUB_TOKEN`, `ARGUS_*`, and
npm auth never reach the child), bounded to `a0.maxTasks` (default 1) and
`a0.timeoutMs` (default 10 min). A remote A0 host is refused against loopback
targets. **The lane reports `inconclusive` even on agent-reported success** —
the round-trip is verified (#53), but the agent's answer is self-reported
evidence, not a verdict — and `unavailable` when the host or CLI is missing.
Hosts without usage reporting are `unmetered` rather than fabricated dollars.

Login-gated instances authenticate headless via `A0_USERNAME`/`A0_PASSWORD`
(the `a0` CLI consumes them; they pass the allowlist only when you export
them). Interactively, `a0 --connect` with remember-host stores a session
instead. `heal: 'a0'` reuses the same host and caps delegations per run at
`a0.maxTasks` (default 5) inside a shared 15-minute wall-clock budget.

### Manifest history

Each `verify` run also archives to `<reportDir>/manifests/<runId>.json`,
bounded by `reportRetention` (default 20, `0` disables). The contributor
terminal view and dashboard render current and archived runs and keep
showing the last valid manifest if a run is interrupted mid-write.

### Terminal output, errors and exit codes

`run` and `verify` end with a summary block: the overall status, one row per
lane with its spend, and the total spend against the budget. Output is
styled in a terminal and plain when piped. `NO_COLOR=1` or `--no-color`
turns color off and wins over `FORCE_COLOR=1`, which turns it on for
non-terminal output such as GitHub Actions logs. `--json`, `--no-color` and
`--debug` work with every command.

Every error prints three lines: the failed glyph with a summary, the cause,
and the next command on its own line. With `--json`, the error is one JSON
object on stdout instead, so a pipe captures it; the exit code is unchanged:

```json
{"error":{"code":"OPENROUTER_RATE_LIMITED","summary":"code-review: OpenRouter rate limit reached","cause":"...","fix":"sleep 20 && argus-reviewer code-review","retryAfterSeconds":20,"httpStatus":429}}
```

`code` is stable and comes from this closed set:

| Code | Meaning |
|---|---|
| `OPENROUTER_KEY_MISSING` | `OPENROUTER_API_KEY` is not set |
| `OPENROUTER_KEY_REJECTED` | OpenRouter did not accept the key (401/403) |
| `OPENROUTER_OUT_OF_CREDIT` | the key has no credit left (402) |
| `OPENROUTER_RATE_LIMITED` | rate limited (429); `retryAfterSeconds` when the reset is known |
| `PROVIDER_UNAVAILABLE` | OpenRouter or the upstream model provider is down (5xx) |
| `CONFIG_INVALID` | the config file could not be loaded or failed validation |
| `MANIFEST_UNREADABLE` | a run manifest could not be read |
| `A0_UNREACHABLE` | the Agent Zero CLI or host cannot be reached |
| `USAGE` | a bad command, flag or argument |
| `COMMAND_FAILED` | the command failed for another reason; re-run with `--debug` |
| `INTERNAL` | an unexpected error, an Argus bug; the JSON carries an `issue` link |

Numeric exit codes did not change: 0 is success, 1 is a failed verdict or a
failed run, and 2 is a usage error the command checks itself. The `code`
field tells an infrastructure failure from a verdict failure without
breaking scripts that test the exit code.

## 6. Register a self-hosted runner

On an Ubuntu machine with SSH access:

```bash
git clone https://github.com/duketopceo/Argus
cd Argus/runner
./register-runner.sh duketopceo/YourRepo your-runner-name
```

The runner is registered with the labels `self-hosted`, `Linux`, and `X64`.

## 7. Open a PR

`argus-reviewer` now runs on every PR, posting a sticky comment with:

- vision test results
- code review findings
- OpenRouter spend per model
- links to evidence and workflow logs

Code review is **index-informed**: when `argus.index.json` exists (the action's
`index` input defaults to `'true'` and writes it), each changed file's diff is
sent with a bounded `> context:` block — the file's purpose plus its top
importers/imports — so the reviewer model can weigh caller blast radius, not
just the patch. Index metadata is sanitized before reaching the prompt and
framed as unverified; no extra config or model calls are needed.

Findings are also **evidence-linked**: Argus reads the PR's check-runs and tags
each finding with whether the repo's own CI exercised the implicated path —
`exercised` (test-reachable + test checks passed), `corroborated` (test-reachable

- a test check failed on this head), `not exercised` (no test file reaches the
  path — severity is never downgraded), or `inconclusive` (no CI/index data).

### Review policy

The `review` config block tunes the GitHub-facing posture:

```ts
export default defineConfig({
  review: {
    // Cap on inline comments posted per run. Overflow stays in
    // code-review.json and is summarized count-only in the sticky.
    // The action's `max-comments` input overrides this.
    maxComments: 20,
    // Check-failure threshold: 'bug' fails on bugs only, 'risk' fails
    // on bug|risk findings. Unset → the top-level `severity` list is
    // authoritative (defaults to ['bug']).
    severityGate: 'risk',
    // Confidence-model cutoff for the secrets lane: candidates scored
    // below this probability are suppressed (still audited, masked).
    secretsThreshold: 0.3,
    // Pre-review triage: 'annotate' (default) records confidence-model risk/area
    // signals only; 'route' may also swap in `lowRiskModel` on a clear
    // low-risk signal; 'off' skips the lane. Coverage never shrinks —
    // triage picks effort shape, not whether review happens.
    triage: 'annotate',
    // Cheap code model used only when triage is 'route' AND the confidence model reads
    // the diff as low risk (risk<=2 + deep-review<0.5, backed by real
    // diff evidence). Unset → the configured model always reviews.
    lowRiskModel: 'deepseek/deepseek-v4.1-flash',
    // Required P(false positive) before a nit/q may be suppressed by
    // confidence-model adjudication: suppress when
    // p < 1 - findingThreshold.
    // Default 1.0 = annotate-only (every finding keeps its `p`, none
    // are dropped). NOTE: polarity is the inverse of secretsThreshold —
    // lower values here suppress MORE, not fewer.
    findingThreshold: 1.0,
    // Let proven blockers escalate the PR review to REQUEST_CHANGES.
    // "Proven" means sandbox-reproduced, adjudicated by the
    // confidence model above the true-positive threshold, or a
    // secrets-lane finding confirmed live. Set false for a permanently advisory (COMMENT-only)
    // posture — e.g. while evaluating the tool.
    requestChanges: true,
    // Changed paths kept out of the review input (glob list). Default
    // shown; a configured list REPLACES it, [] excludes nothing. Excluded
    // counts are reported in the sticky Diagnostics fold. Not read from
    // untrusted (fork) checkouts, so a PR cannot widen it.
    exclude: [
      'dist/**', 'fixtures/**', 'tests/goldens/**',
      '**/package-lock.json', '**/yarn.lock', '**/pnpm-lock.yaml', '**/go.sum', // and other lockfiles
      '**/*.generated.*', 'assets/brand/export/**',
    ],
  },
  // Confidence model for all decision lanes (triage, finding
  // adjudication, secrets). '' disables every confidence-model call,
  // so lanes degrade open: no triage record, no p scores, regex-only secrets findings.
  decisionModel: 'typesafe/jev-1.13-20260917',
})
```

Each finding carries a `category` (`correctness`, `security`,
`performance`, `usability`, `convention`, `other`) shown in the sticky
table and inline comments. All findings land in `code-review.json`
regardless of the comment cap.

Before the verdict is derived, two deterministic filters remove model
noise: findings whose cited line falls outside the file's diff hunks, and
nit/q findings asking to revert text the diff itself added.
Verdict-driving findings — `bug`, `risk`, the `security` category, or any
configured blocking severity — are exempt, so a misnumbered cite on a real
defect still gates. Drops are audited, not silent: `code-review.json`
carries `droppedUnanchored`, `droppedReverted`, and a capped
`droppedFindings[]` list (`file`/`line`/`severity`/`category`/`message`/
`reason`). `verdict`, `ok`, and `reviewEvent` all derive from the
post-filter set; when the model's own synthesis verdict disagrees it is
preserved separately as `modelVerdict`.

What posts to the PR: one batched review containing inline comments on
all severities (severity-sorted, capped by `maxComments`), each carrying
a committable ```` ```suggestion ```` block when the model proposed a clean
patch — sanitized, span-bounded, and fenced safely before rendering. The
review event is `REQUEST_CHANGES` only when a blocker-severity finding is
proven (reproduced by a sandbox probe, adjudicated by the confidence model above threshold,
or a secrets-lane hit confirmed live); everything else posts as `COMMENT`.
A stale request-changes review from Argus is dismissed automatically on
the next run once the blockers clear. If GitHub rejects the event (the
token authored the PR, or the token is read-only on a fork), the review
retries once as `COMMENT` with a note in the review body. Comments whose
anchors fall outside the PR diff are dropped before posting and counted
in the sticky's overflow note.

Two consequences worth knowing: without a decision model *and* without
the probe lane, no finding can be proven, so the event is always
`COMMENT` (degrade-open by design); and the poster verifies the report's
head binding matches the PR head before posting, so a stale or planted
`code-review.json` can never produce comments or a blocking review.

### Local demo (`npm run demo`, contributors)

From a clone of this repo, `npm run demo` shows the whole pipeline without a
PR. It materializes `fixtures/demo-pr` (a real seeded bug, a doc-shaped key
and a live-format key) into a temp repo and runs `code-review --fixture`
against it: the real chunking, model review, secrets scan and
confidence-model adjudication, with zero GitHub API calls. Run
`npm run watch` in a second terminal to stream the stage lines live. Requires `OPENROUTER_API_KEY` (BYOK, real model calls).

### README casts (`npm run demo:record`, contributors)

The terminal casts in the README are VHS tapes in `assets/demo/`. After
`npm run build`, `npm run demo:record` replays each one in a clean
environment (a temp `HOME`, a minimal `PATH`, no API key; it refuses to start
if `OPENROUTER_API_KEY` is set) and writes `docs/assets/demo/<tape>.gif`. The
`run` and `verify` casts replay `fixtures/demo-cache/checkout.flow.json`, a
flow cache seeded with zero model calls, so they cost $0. Pass `--seed` to
re-seed it if the replay stops matching (for example after a font or
browser change). Requires `vhs`, `ttyd`, `ffmpeg`, `gifski` and
`woff2_decompress`.

### Sandbox probes (opt-in, requires Docker)

With `sandbox: { enabled: true }` in config (or the action's `sandbox: 'true'`
input), Argus goes one step further for `not_exercised` findings at blocking
severities: it authors a test that asserts the _correct_ behavior and runs it
in a hardened Docker container against the PR head **and** the merge base. Only
a probe that fails on head and passes on base upgrades the finding to
`reproduced` 🧪 — a probe that fails on both is a probe bug, not proof.

The container runs with no network, a read-only filesystem, `nobody` UID, all
capabilities dropped, no ambient env or secrets, `.git` masked, and a hard
timeout. Fork PRs are gated: probes run only for MEMBER/OWNER/COLLABORATOR
authors or when a maintainer applies the `argus-probe` label _after_ the head
was pushed (label approvals don't carry across `synchronize` pushes — add
`labeled` to your workflow's `pull_request.types`). `pull_request_target` is
not supported. Without Docker or a vitest/jest/`node --test` harness the lane
degrades cleanly. Probe outcomes are informational — they never change the
verdict or exit code.

v1 covers Node harnesses (vitest, jest, `node --test`) on the PR's own
checkout — probes exercise whatever commit `actions/checkout` fetched
(typically the merge ref).

### Exploratory lane (opt-in)

With `explore: { enabled: true }` in config, `argus-reviewer run` does two
things. During the test loop it records page-level anomalies while your
tests drive the app: `console.error` messages, uncaught page errors, and
failed **same-origin** requests (third-party noise like blocked trackers
is dropped). After the test loop finishes, a bounded **act pass** probes
the app on its own — the model is shown the page (screenshot + a11y tree)
and proposes one action at a time from a fixed vocabulary: `click`,
`type`, `pressKeys`, `scroll`, `wait`, `navigate`, `done`. It needs no
recorded tests, so apps with zero `tests/` files still get probed.

The act pass is structurally bounded — model output is a proposal, never
an instruction:

- `explore.maxSteps` (default 20) caps acts per run; `explore.budgetUsd`
  caps explore model spend (falls back to the run `budgetUsd`).
- `navigate` is confined to the target's origin — cross-origin and
  non-`http(s)` proposals are refused and journaled, so the agent cannot
  be steered off the app under test.
- Typed input is truncated (500 chars), `pressKeys` is filtered to a small
  allowlist (Enter/Tab/arrows etc.), scroll and wait are clamped, and the
  loop stops on `done`, the step/budget caps, an unchanging page, or an
  error.
- **Point it at disposable targets only.** The prompt instructs
  non-destructive probing, but clicks and form submits on a live app have
  real side effects — explore against preview/staging deploys, not
  production.

Everything the lane sees lands as `🟡 observed` findings in the
**Exploratory** section of the PR comment and under `explore.captures` /
`tests[].captures` in `run.json`, alongside the pass's step count, pages
visited, stop reason, and vision spend. Captures are evidence, not
adjudication — they never change a verdict or the exit code, and an
unreachable target degrades to an explicit `explore.skipped` reason
instead of a failure. On untrusted/fork checkouts the whole `explore`
block is stripped by the config allowlist, so a hostile PR cannot turn it
on.

### `@argus` mention commands (opt-in)

`argus-reviewer init` also scaffolds `.github/workflows/argus-mention.yml`,
an `issue_comment` workflow that answers PR comments starting with
`@argus`:

- `@argus review` — re-run code review on the latest head; the sticky
  comment updates in place
- `@argus record "<flow>"` — record a test flow against the base-checkout
  app; the generated test + flow cache upload as a workflow artifact
- `@argus persist` — commit a reproduced probe to `argus/probe-regression-pr-<n>`
  and open a regression-test PR against the base branch. The probe source
  travels with the sticky comment (copy-pasteable details block + a
  machine-readable payload), so persist works even though the probe file is
  deleted after review. Idempotent — re-running reuses the branch and open
  PR; a moved PR head is refused until `@argus review` re-runs
- `@argus help` — the command menu

Security posture: `issue_comment` runs carry secrets and a write-capable
`GITHUB_TOKEN`, so the workflow **never checks out the PR head** — it runs
on the base ref and reviews the diff over the GitHub API. Only comments by
MEMBER/OWNER/COLLABORATOR are answered; everything else is ignored
silently. On fork-head PRs, commands additionally need the `argus-probe`
label covering the current head SHA, and `record`/`persist` are refused
outright.
