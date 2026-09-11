# argus-reviewer consumer example

A minimal repo showing how to use `argus-reviewer` to test a static HTML page.

## Install

```bash
npm install
```

## Record a flow

```bash
OPENROUTER_API_KEY=<your-key> npx argus-reviewer record 'click the "Click me" button and assert the marker' --name click
```

## Replay the test

```bash
OPENROUTER_API_KEY=<your-key> npx argus-reviewer run
```

## What is where

- `argus-reviewer.config.ts` — model, target URL, and cache/report paths.
- `fixtures/index.html` — a tiny app for the example.
- `e2e/click.test.ts` — the generated/first test.
- `.argus-reviewer-cache/` — recorded fingerprints (created by `record`).
- `argus-reviewer-report/` — run results and cost.
