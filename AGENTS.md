# Argus (`argus-reviewer-e2e`) — agent notes

`CONTRIBUTING.md` already documents setup, the four verification commands, and
PR conventions. **Read it first.** This file only records the things an agent
gets wrong.

## Setup and verify

```bash
npm ci
npx playwright install chromium   # required for driver tests only

npm run typecheck   # tsc --noEmit
npm run lint        # eslint .
npm run build       # tsc -p tsconfig.build.json
npm test            # vitest run
```

Those four steps, in that order, are exactly what `.github/workflows/ci.yml`
runs on Node 22 and 24. `consumer-smoke.yml` additionally runs on PRs touching
`src/`, `action/`, `package.json`, `package-lock.json`, or
`scripts/consumer-smoke.mjs`.

## Node version floors are not the same number

- `package.json` `engines.node` is `>=20.19.0` — that is the **consumer**
  floor for the published package.
- **Development needs Node 22.** `electron@44` requires `>=22.12`, so the dev
  toolchain floor is 22 while the published floor stays 20.19. CI's matrix is
  `['22','24']`. Do not "fix" `engines` to 22 — consumers who never install
  devDependencies would be broken.

## Things that are true and look wrong

- **`dist/` is committed on purpose.** Consumers installing from git get
  built output. Run `npm run build` and commit `dist/` alongside `src/`. The
  npm package builds itself through `prepare`.
- **Tests are `tests/**/*.test.ts` only** (`vitest.config.ts`), with
  `tests/setup-env.ts` as the setup file and a 60s timeout. Unit tests need
  no browser; driver/e2e tests need Playwright chromium. A test placed
  outside `tests/` silently does not run.
- **The review workflow runs on a self-hosted runner**, not a GitHub-hosted
  label. `argus-reviewer.yml` targets `self-hosted, linux, x64, argus-reviewer`
  via `runner/register-runner.sh`. If no such runner is registered, that
  workflow queues and never completes — that is a capacity problem, not a
  broken workflow.
- **Release is tag-driven and gated twice.** `release.yml` fires on `v*`,
  asserts the tag equals `package.json` version, runs the full test suite plus
  a clean-install consumer smoke, and publishes to the `npm` environment,
  which is expected to carry a required-reviewer rule. The publish step
  publishes the exact tarball the smoke step verified.

## Security invariants — read `SECURITY.md` before touching trust

`src/trust.ts` resolves the trust lane in this order:

1. `ARGUS_UNTRUSTED=1` always wins.
2. `ARGUS_TRUSTED=1` overrides the event-based fork check.
3. Otherwise the event decides.

`ci.yml` sets `ARGUS_TRUSTED` **only** for non-`pull_request` events, because
the override beats the fork check and would otherwise run a fork PR's code in
a trusted lane. `release.yml` scopes its override to tag refs. Any change here
is a security change, not a config tidy.

Other standing rules from `SECURITY.md`: treat PR-controlled code, config,
test files, and generated probes as hostile; fail closed on parse, path, and
trust errors; `node:vm` is **not** an isolation boundary.
