# argus-reviewer quickstart

> Self-hosted, BYOK OpenRouter UI regression and code review for GitHub PRs.

## 1. Install

```bash
npm i -D argus-reviewer-e2e
```

Until the package is on npm, install from the GitHub tag:

```bash
npm i -D github:duketopceo/Argus
```

## 2. Configure

Create `vision-e2e.config.ts` in the repo root:

```ts
import { resolve } from 'node:path'
import { defineConfig } from 'argus-reviewer-e2e'

export default defineConfig({
  model: 'google/gemini-2.5-flash-lite',
  escalation_model: 'anthropic/claude-sonnet-4',
  code_model: 'anthropic/claude-sonnet-4',
  budgetUsd: 1.0,
  target: {
    command: '',
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

## 6. Register a self-hosted runner

On an Ubuntu machine with SSH access:

```bash
git clone https://github.com/duketopceo/Argus
cd Argus/runner
./register-runner.sh duketopceo/YourRepo your-runner-name
```

The runner needs `self-hosted`, `Linux`, `X64`, and `vision-e2e` labels.

## 7. Open a PR

`argus-reviewer` now runs on every PR, posting a sticky comment with:

- vision test results
- code review findings
- OpenRouter spend per model
- links to evidence and workflow logs
