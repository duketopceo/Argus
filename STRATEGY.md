# argus-reviewer strategy

## Target problem

E2E UI tests are expensive to write and brittle to maintain: selectors rot,
flows break on cosmetic changes, and nobody reviews the review. Meanwhile PR
review quality is inconsistent and cost is opaque.

## Approach

Four lanes, one manifest (`verify` writes `run-manifest.json`; the PR
comment, TUI, and Electron dashboard all render it):

- **Review lane** (default) — model reads the PR diff (index-informed
  context, chunked, budgeted, multi-stage) and posts inline findings plus a
  verdict.
- **Flow lane** (`--flow`) — record a flow once in plain English; a vision
  model grounds each step on screenshots. Replay is cache-first (zero model
  calls on an unchanged UI); drift heals re-spend only where the UI changed,
  and show up as reviewable cache diffs.
- **App lane** (`--app`) — a directed task against the live app with an
  expected-state check: real execution, not just read diffs.
- **A0 lane** (`--a0`) — opt-in, budgeted escalation to a self-hosted Agent
  Zero host over a sanitized child env; reports `inconclusive`, never
  `passed`, until live round-trips are proven (#53).
- **Output** — one sticky PR comment with per-model dollar cost, test
  evidence, review verdict, and a commit status that gates merge.

## Users

- Self-hosted teams who want AI testing/review without a SaaS dependency or
  per-seat pricing — BYOK via OpenRouter, runs on your own runners.
- This repo first: dogfooding on our own PRs is the quality bar.

## Key metrics

- Replay cost per run (target: ~$0 on cache hit)
- Heal rate per run (journal-tracked; spikes signal UI drift or weak fingerprints)
- Review findings posted vs. resolved (signal-to-noise)
- Dollar spend per PR (OpenRouter `trace` attribution)

## Tracks of work

Post-launch roadmap (plan: `docs/plans/2026-09-14-006-feat-post-launch-roadmap-plan.md`):

1. **Proof & adoption**: demo assets on the README, OIDC trusted-publishing
   releases, clean-install consumer smoke CI. The product works; now it has
   to be seen working.
2. **Execution-backed review**: staged moat — first link existing-CI
   evidence to findings ("not exercised" stays full severity), then author
   probes that execute suspected-defect paths in a sandbox. Reproduced
   findings, not suspected ones, are the differentiation vs. review bots.
3. **Agent Zero depth**: the `verify --a0` seam (scoped, budgeted,
   env-sanitized) ships with the insight-first follow-through; live-verify
   `delegate`/`heal:'a0'`/`--a0` remains blocked on a reachable host (#53);
   optional autonomous desktop/browser addon, never a prerequisite.
4. **Scale & ops** (gated on observed external adoption): runner health
   dashboard (#21), org spend caps (#22), GHE/GitLab (#23).

## Explicitly out of scope

- Managed cloud hosting (self-hosted-first by design)
- Selector-based test authoring (vision-first is the point)
