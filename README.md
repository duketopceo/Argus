# vision-e2e

Open-source, self-hosted vision-model E2E testing. Bring your own `OPENROUTER_API_KEY`: record a flow once, fingerprint-cache every step, replay near-free, heal on UI drift, and get results as a check + comment on the GitHub PR.

- Vision-first: a model looks at a screenshot and decides where to click — no selectors to write or maintain.
- Cache-first: replay costs zero vision calls on an unchanged UI; heals re-spend only on drift and show up as reviewable cache diffs.
- Cost-explicit: every call is metered from OpenRouter's per-call cost and rolled into a per-run dollar figure on the PR.

Status: early development. See `docs/` and the GitHub Action under `action/`.
