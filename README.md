# Argus

Open-source, self-hosted vision-model E2E testing — the hundred-eyed watcher for your UI. Bring your own `OPENROUTER_API_KEY`: record a flow once, fingerprint-cache every step, replay near-free, heal on UI drift, and get results as a check + comment on the GitHub PR.

- **Vision-first**: a model looks at a screenshot and decides where to click — no selectors to write or maintain.
- **Cache-first**: replay costs zero vision calls on an unchanged UI; heals re-spend only on drift and show up as reviewable cache diffs.
- **Cost-explicit**: every call is metered from OpenRouter's per-call cost and rolled into a per-run dollar figure on the PR.
- **Grounding specialist**: a `grounding_model` (e.g. a ui-tars-class model) can drive element location with its native coordinate output, verified against the DOM before any click executes.

```bash
npm i -D argus-e2e        # or github:duketopceo/Argus
npx argus record "log in and open settings" --url https://localhost:3000
npx argus run             # replays + asserts, zero-cost on cache hit
```

Configuration lives in `vision-e2e.config.ts` (filename kept for compatibility) — see `src/config.ts` for the full shape: `model`, `grounding_model`, `escalation_model`, `provider` routing rules, `budgetUsd`, `target`, `pageSetup`, `secrets`.

Status: early development. See `action/` for the composite GitHub Action and `runner/` for self-hosted runner registration.

License: MIT.
