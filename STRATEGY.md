# argus-reviewer strategy

## Target problem

E2E UI tests are expensive to write and brittle to maintain: selectors rot,
flows break on cosmetic changes, and nobody reviews the review. Meanwhile PR
review quality is inconsistent and cost is opaque.

## Approach

Two lanes, one PR surface:

- **Vision lane** — record a flow once in plain English; a vision model
  grounds each step on screenshots. Replay is cache-first (zero model calls
  on an unchanged UI); drift heals re-spend only where the UI changed, and
  show up as reviewable cache diffs.
- **Code lane** — model reads the PR diff (index-informed context, chunked,
  budgeted, multi-stage) and posts inline findings plus a verdict.
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
2. **Execution-backed review**: run the PR's own tests in a sandbox and
   link evidence to findings — the differentiation moat vs. review bots.
3. **Agent Zero depth**: live-verify `delegate`/`heal:'a0'`, scope and
   budget controls; optional autonomous desktop/browser addon, never a
   prerequisite.
4. **Scale & ops** (gated on observed external adoption): runner health
   dashboard (#21), org spend caps (#22), GHE/GitLab (#23).

## Explicitly out of scope

- Managed cloud hosting (self-hosted-first by design)
- Selector-based test authoring (vision-first is the point)
