# argus-reviewer quickstart

> Self-hosted, BYOK OpenRouter UI regression and code review for GitHub PRs.

## 1. Install

```bash
npm i -D argus-reviewer-e2e
```

Until the package is on npm, install from the GitHub repo:

```bash
npm i -D duketopceo/Argus
```

## 2. Configure

Create `argus-reviewer.config.ts` in the repo root:

```ts
import { defineConfig } from 'argus-reviewer-e2e'

export default defineConfig({
  model: 'google/gemini-2.5-flash-lite',
  escalation_model: 'anthropic/claude-sonnet-4',
  code_model: 'deepseek/deepseek-v4.1-flash',
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
          node-version: '20'
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
are validated against a known list and warn on typos. Spend is still yours:
the `run.json` ledger records the per-run dollar figure regardless of which
provider served the call.

### Agent Zero delegation (optional)

If you run an [Agent Zero](https://agent-zero.ai) instance — the launcher, a
Docker container, or a remote host — Argus can hand it autonomous tasks. `init`
detects it automatically (via the `a0` CLI, `AGENT_ZERO_HOST`,
`~/.agent-zero/.env`, or a local probe) and writes `heal: 'a0'` into the
generated config. Zero extra config is needed when the `a0` CLI already knows
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
+ a test check failed on this head), `not exercised` (no test file reaches the
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
    // Jev adjudication cutoff for the secrets lane: candidates scored
    // below this probability are suppressed (still audited, masked).
    secretsThreshold: 0.3,
  },
  // Jev decision model for secrets adjudication. '' disables
  // adjudication — regex-only findings, still fully reported.
  decisionModel: 'typesafe/jev-1.13-20260917',
})
```

Each finding carries a `category` (`correctness`, `security`,
`performance`, `usability`, `convention`, `other`) shown in the sticky
table and inline comments. All findings land in `code-review.json`
regardless of the comment cap.

### Local demo (`npm run demo`)

To see the whole pipeline without a PR: `npm run demo` materializes
`fixtures/demo-pr` (a real seeded bug + a doc-shaped key + a live-format
key) into a temp repo and runs `code-review --fixture` against it — the
real chunking, model review, secrets scan, and Jev adjudication, zero
GitHub API calls. Run `npm run watch` in a second terminal to stream the
stage lines live. Requires `OPENROUTER_API_KEY` (BYOK, real model calls).

### Sandbox probes (opt-in, requires Docker)

With `sandbox: { enabled: true }` in config (or the action's `sandbox: 'true'`
input), Argus goes one step further for `not_exercised` findings at blocking
severities: it authors a test that asserts the *correct* behavior and runs it
in a hardened Docker container against the PR head **and** the merge base. Only
a probe that fails on head and passes on base upgrades the finding to
`reproduced` 🧪 — a probe that fails on both is a probe bug, not proof.

The container runs with no network, a read-only filesystem, `nobody` UID, all
capabilities dropped, no ambient env or secrets, `.git` masked, and a hard
timeout. Fork PRs are gated: probes run only for MEMBER/OWNER/COLLABORATOR
authors or when a maintainer applies the `argus-probe` label *after* the head
was pushed (label approvals don't carry across `synchronize` pushes — add
`labeled` to your workflow's `pull_request.types`). `pull_request_target` is
not supported. Without Docker or a vitest/jest/`node --test` harness the lane
degrades cleanly. Probe outcomes are informational — they never change the
verdict or exit code.

v1 covers Node harnesses (vitest, jest, `node --test`) on the PR's own
checkout — probes exercise whatever commit `actions/checkout` fetched
(typically the merge ref).
