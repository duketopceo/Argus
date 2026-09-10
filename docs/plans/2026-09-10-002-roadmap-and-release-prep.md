# argus-reviewer roadmap, milestones, and issue plan

## Product thesis

`argus-reviewer` is a self-hosted, BYOK (bring-your-own-key) AI testing and review system that runs in GitHub Actions.

- **Vision lane:** the AI uses a browser and screenshots to record, replay, heal, and assert on UI flows.
- **Code lane:** the AI reads the PR diff and posts code review findings.
- **Output:** one sticky PR comment with per-model cost, test evidence, code review verdict, and a commit status that gates merge.

## Roadmap phases

| Phase | Goal | When | Success criterion |
| --- | --- | --- | --- |
| **P0 — Dogfood release** | `argus-reviewer` runs on its own PRs and ships as a usable package. | Now | Merge `feat/openrouter-trace-cost` and `feat/argus-reviewer-smoke-test` to `main`. |
| **P1 — Package and onboarding** | Other repos can install and run `argus-reviewer` in a few commands. | +2 weeks | `npm i -D argus-reviewer-e2e` works, a sample consumer repo is green. |
| **P2 — Vision hardening** | Recording is reliable, healing is useful, and the model terminates cleanly. | +4 weeks | 3 real repos have recorded flows passing on every PR. |
| **P3 — Code review v1** | Code lane produces actionable, non-noisy review comments. | +6 weeks | Inline comments on diff lines, severity filter, token budget. |
| **P4 — Scale and enterprise** | Fleet of runners, cost dashboards, multi-tenant. | +12 weeks | Org-level runner management and cost alerts. |

## Milestones

### M0 — Dogfood release (P0)

- Clean up the package for release.
- Merge the two open feature branches.
- Stabilize the self-hosted runner action on `duketopceo/Argus`.

### M1 — NPM and consumer onboarding (P1)

- Publish `argus-reviewer-e2e` to npm.
- Create a `quickstart.md` and a sample consumer repo.
- Add CI for `argus-reviewer` itself (typecheck, build, focused tests).

### M2 — Vision reliability (P2)

- Tune record prompt termination to avoid the 10-step cap.
- Improve selectorless healing and assertion accuracy.
- Add multi-browser support (Firefox, WebKit) behind config.

### M3 — Code review v1 (P3)

- Post inline comments on PR diff lines.
- Add code review token budget and file chunking.
- Add noise filter / severity threshold.

### M4 — Scale (P4)

- Runner fleet dashboard.
- Per-org cost alerts and spend caps.
- Optional cloud-hosted coordination.

## Issues by milestone

### M0 — Dogfood release

1. **#4** Merge `feat/openrouter-trace-cost` and close/merge `feat/argus-reviewer-smoke-test`
2. **#5** Audit `package.json` `files` and clean internal dev docs from the npm tarball
3. **#6** Fix or silence code-review findings before `main` becomes required
4. **#7** Add a top-level `CHANGELOG.md` and `STRATEGY.md`
5. **#8** Rename remaining `vision-e2e` strings to `argus-reviewer` while keeping backward-compatible config names

### M1 — NPM and consumer onboarding

6. **#9** Publish `argus-reviewer-e2e@0.1.0` to npm
7. **#10** Create `examples/consumer-repo` with `vision-e2e.config.ts` and a sample test
8. **#11** Write quickstart: install, record, run, add action, register runner
9. **#12** Add a GitHub Action CI workflow for the package

### M2 — Vision reliability

10. **#13** Tune `record` termination prompt to avoid step-cap failures
11. **#14** Add automatic fallback from `grounding_model` to `escalation_model`
12. **#15** Investigate and fix browser timeout / cleanup failures in full test suite
13. **#16** Support `firefox` and `webkit` via `config.browser`

### M3 — Code review v1

14. **#17** Post inline review comments on changed lines
15. **#18** Add `code_review.budgetUsd` and file-chunking for large PRs
16. **#19** Add severity filter (skip `info` by default)
17. **#20** Add multi-stage review (security → correctness → tests → naming)

### M4 — Scale

18. **#21** Build a runner health dashboard
19. **#22** Add org-level spend alerts and budget caps
20. **#23** Support GitHub Enterprise Server and GitLab

## Release package cleanup

`npm pack` currently includes only `dist/` and `action/` because `package.json` has:

```json
"files": ["dist", "action"]
```

The following are **not** in the tarball:

- `docs/` (plans, README references)
- `tests/` and `e2e/` (dev tests)
- `runner/` (self-hosted runner scripts)
- `src/` (TypeScript source, compiled to `dist/`)

The following are **always** included by npm and should stay clean:

- `README.md`
- `LICENSE`
- `package.json`

Internal-only files like `AGENTS.md` should **not** be added to the repo root or `files` list. If an `AGENTS.md` or `.cursor/rules/` exist for local agent instructions, keep them out of `files` and out of the published package. The current repo has no `AGENTS.md` and `package.json` already prevents dev docs from shipping.

## Suggested next actions

1. Resolve PR #2 and PR #3, then merge to `main`.
2. Create the GitHub milestones and issues listed above.
3. Pick the first M0 issue and start `/ce-work`.
