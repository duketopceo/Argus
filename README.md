# argus-reviewer

<p align="center">
  <img src="docs/assets/social.png" alt="Argus — vision-model E2E testing" width="640" />
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/argus-reviewer-e2e"><img src="https://img.shields.io/npm/v/argus-reviewer-e2e" alt="npm version" /></a>
  <a href="https://github.com/duketopceo/Argus/actions/workflows/ci.yml"><img src="https://github.com/duketopceo/Argus/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license" /></a>
  <a href="https://github.com/duketopceo/Argus/security/policy"><img src="https://img.shields.io/badge/security-policy-orange" alt="security policy" /></a>
</p>

Open-source, self-hosted vision-model E2E testing — the hundred-eyed watcher for your UI. Bring your own `OPENROUTER_API_KEY`: record a flow once, fingerprint-cache every step, replay near-free, heal on UI drift, and get results as a check + comment on the GitHub PR.

- **Vision-first**: a model looks at a screenshot and decides where to click — no selectors to write or maintain.
- **Cache-first**: replay costs zero vision calls on an unchanged UI; heals re-spend only on drift and show up as reviewable cache diffs.
- **Cost-explicit**: every call is metered from OpenRouter's per-call cost and rolled into a per-run dollar figure on the PR.
- **Grounding specialist**: a `grounding_model` (e.g. a ui-tars-class model) can drive element location with its native coordinate output, verified against the DOM before any click executes.
- **Execution-backed review**: `code-review` findings carry CI evidence, and with the opt-in sandbox lane (`sandbox: { enabled: true }`) Argus authors a test probe for unexercised findings and runs it in a hardened, network-less Docker container — a finding that fails on head and passes on base is stamped **reproduced**, not just suspected.

```bash
npm i -D argus-reviewer-e2e        # or github:duketopceo/argus-reviewer
npx argus-reviewer record "log in and open settings" --url https://localhost:3000
npx argus-reviewer run             # replays + asserts, zero-cost on cache hit
```

<p align="center">
  <img src="docs/assets/demo.gif" alt="argus-reviewer run — live vision call, PASS, $0.0005 spend" width="900" />
</p>

*Real `run` output: one vision assert, `PASS`, and the exact dollar figure on the run report.*

Configuration lives in `argus-reviewer.config.ts` (a legacy `vision-e2e.config.*` is still accepted) — see `src/config.ts` for the full shape: `model`, `grounding_model`, `escalation_model`, `provider` routing rules, `budgetUsd`, `target`, `pageSetup`, `secrets`.

### OpenRouter cost attribution

Add an `openrouter` block to tag every request. `trace` is sent in the request body and is the right hook for cost allocation by repo/PR/run. `headers` are sent verbatim with every OpenRouter request (useful for `HTTP-Referer` or `X-Title`).

```ts
export default {
  openrouter: {
    trace: { repo: 'duketopceo/myapp', pr: '42', run: 'argus-reviewer' },
    headers: { 'HTTP-Referer': 'https://github.com/duketopceo/myapp' },
  },
}
```

The GitHub Action automatically sets `ARGUS_REVIEWER_TRACE` with the repository, PR number, commit, and run id, so every PR review is attributed in OpenRouter without extra config. You can also set `ARGUS_REVIEWER_TRACE` yourself (JSON object) to add more fields.

Status: early development. See `action/` for the composite GitHub Action,
`runner/` for self-hosted runner registration, `docs/quickstart.md` for
setup, `SECURITY.md` for the threat model, and `CONTRIBUTING.md` to hack
on it.

## File structure

```text
argus-reviewer/
├── action/                  # GitHub Actions composite action + sticky PR comment
│   ├── action.yml
│   └── sticky-comment.mjs
├── runner/                  # Self-hosted runner registration docs + script
│   ├── README.md
│   └── register-runner.sh
├── electron/                # Local observability dashboard (`npm run app`)
├── src/
│   ├── api.ts               # Test-facing `test`/`td` API + generated test file renderer
│   ├── cli.ts               # record · run · code-review · delegate · cache · index · init
│   ├── config.ts            # `argus-reviewer.config.*` loader (legacy `vision-e2e.config.*` accepted)
│   ├── cache/
│   │   ├── fingerprint.ts   # Per-step screenshot/a11y fingerprint + resolve
│   │   └── store.ts         # Flow cache read/write
│   ├── driver/
│   │   ├── browser.ts       # Playwright browser launch (chromium/firefox/webkit) + observation capture
│   │   └── target.ts        # Optional local dev-server target process
│   ├── engine/
│   │   ├── actions.ts       # Low-level page actions (click, type, scroll, …)
│   │   ├── loop.ts          # Vision model record/replay + healing loop
│   │   └── prompts.ts       # OpenRouter action/assertion prompts + JSON schemas
│   ├── evidence/
│   │   ├── ci.ts            # PR metadata + CI check-run context for findings
│   │   ├── gate.ts          # Fork-PR trust gate (argus-probe label bound to head SHA)
│   │   └── link.ts          # Finding → evidence linkage + comment-safe sanitization
│   ├── executor/
│   │   ├── a0.ts            # `a0 headless -p` delegation to a user's Agent Zero instance
│   │   └── sandbox.ts       # Hardened Docker runner for generated probes
│   ├── index/               # Repo index, diff context, cache invalidation
│   ├── journal/             # Per-run structured journal entries
│   ├── probe/
│   │   ├── author.ts        # Model-authored regression probe generation + validation
│   │   ├── harness.ts       # vitest/jest/node:test detection + TAP classification
│   │   └── queue.ts         # Head-vs-merge-base probe orchestration
│   ├── report/
│   │   ├── comment.ts       # Markdown PR comment + commit-status rendering
│   │   ├── junit.ts         # JUnit XML output
│   │   └── run.ts           # JSON run report consumed by the action
│   └── vision/
│       ├── cost.ts          # OpenRouter cost parsing per call
│       ├── ledger.ts        # Per-run USD budget tracking
│       └── openrouter.ts    # OpenRouter chat-completion client + schema parsing
└── tests/                   # Unit tests + small Playwright fixture page
```

License: MIT.
