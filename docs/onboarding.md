# Onboarding

Argus runs in your GitHub Actions with your own OpenRouter key. Onboarding a repository means adding two workflow files, a config and a smoke test, then adding one secret. There are three paths.

| Path | Status | What you do |
|---|---|---|
| CLI `init --pr` | Available now | Run one command, add one secret, merge the PR |
| GitHub App (hosted) | Built; pending public registration | Install the App on selected repos; it opens the same onboarding PR |
| Self-hosted App | Available now | Register and run your own copy of the App — [`self-host-app.md`](self-host-app.md) |

Plain `argus-reviewer init` (writes the files into your working tree) remains the manual path.

## Path 1: CLI `init --pr` (available now)

Run from a checkout of the repository you want to onboard. You need `git` and the GitHub CLI, authenticated (`gh auth login`).

```bash
npx argus-reviewer init --pr
```

Options:

- `--repo <owner/name>`: confirms the target. It must match the checkout's `origin`; it cannot redirect the push.
- `--branch <name>`: branch to use. Default `argus/onboarding`.
- `--force` cannot be combined with `--pr`.

What it does:

1. Reads the `origin` remote to find the repository, and asks `gh` whether an open PR from the branch already exists. If one does, it prints that PR and stops.
2. Refuses to overwrite files. If any file it would add already exists, it lists them and stops. An existing `argus-reviewer.config.*` or `vision-e2e.config.*` is kept and left out of the PR.
3. Commits the scaffold on a new branch from `origin/<default branch>` inside a temporary git worktree (your checkout is not touched), pushes it, and opens the PR with `gh pr create`.

Files added: `argus-reviewer.config.ts`, `tests/argus/smoke.test.ts`, `.github/workflows/argus-reviewer.yml`, `.github/workflows/argus-mention.yml`.

The generated workflows use `pull_request` (never `pull_request_target`), `persist-credentials: false`, a pinned action SHA and explicit least-privilege `permissions`. The mention workflow checks out the base ref, not the PR head.

The command never reads, prints or transmits `OPENROUTER_API_KEY`. The PR only names the secret and links to the page where you add it.

## Path 2: GitHub App (hosted — pending registration)

The App is a thin onboarding and identity layer: you install it on selected repositories and it opens the same onboarding PR that `init --pr` does, generated from the same scaffold module so the two cannot drift. This is Phase 2 of the onboarding plan (`docs/plans/2026-10-04-0002-feat-github-app-onboarding-plan.md`). The App and its webhook Worker are built and the Worker is deployed; the public App registration is pending — the install link lands when it is listed. Until then, use Path 1 or self-host (Path 3).

Known v1 limits: `repository_selection: all` delivers no repo list (the install is a no-op — pick *selected repositories*); more than ~3–4 fresh repos in one delivery are `deferred` with no retry queue — re-add them or run `init --pr` there.

The boundary is fixed and stated in [`SECURITY.md`](../SECURITY.md): the App and its webhook Worker never hold an OpenRouter key, never check out or run customer code, and never run reviews. Reviews keep running in your Actions with your key. A later, optional phase may add a bot identity and check runs; the fork pull request trust rules would not change.

## Path 3: self-hosted App (available now)

For organizations that will not install a third-party App: `app/register/manifest.mjs` generates a one-page form that registers the same App under your own account, and `app/worker/` deploys as its webhook Worker on your own Cloudflare account. Full walkthrough: [`self-host-app.md`](self-host-app.md).

## Secrets checklist

- [ ] `OPENROUTER_API_KEY` as a repository secret (Settings, Secrets and variables, Actions). Direct link: `https://github.com/<owner>/<repo>/settings/secrets/actions/new?name=OPENROUTER_API_KEY`, or `gh secret set OPENROUTER_API_KEY --repo <owner>/<repo>` from your own terminal.
- [ ] Optional, only if you want Argus to submit real approving or change-requesting reviews: a GitHub App token and the `approval-evidence` and `approval-check` inputs. See [`approval-token.md`](approval-token.md) and [`github-app.md`](github-app.md).
- [ ] Optional, for flow heal write-back PRs and generated-spec PRs: flip `contents: read` to `write` in the workflow's job permissions, set the `heal-writeback: 'pr'` action input and/or `review.generateTests.enabled: true` in the trusted config. See "Flow heal write-back" and the `@argus generate` section in [`quickstart.md`](quickstart.md).
- [ ] Do not commit keys to the config or test files. Values in `secrets` are interpolated into test steps and sent to the target app.

## What is sent to the model provider

From the checklist `init` prints and puts in the PR body (`scaffoldChecklist` in `src/onboarding/scaffold.ts`): PR diffs, page screenshots and DOM snapshots, and review prompts, sent through your OpenRouter key. Do not run it against pages containing secrets or personal data you are not willing to share with the provider you configure ([`SECURITY.md`](../SECURITY.md)). There is no hosted Argus service and no telemetry in this path.

## Defaults

Verified against `src/config.ts` and `src/onboarding/scaffold.ts`.

| Setting | Default |
|---|---|
| Budget | The scaffolded `argus-reviewer.config.ts` sets `budgetUsd: 1`, a $1 per-run cap. Replays served from the cache cost $0. The same $1 cap is now the built-in default, so a config without `budgetUsd` is capped too. The action input `budget-usd` (env `ARGUS_BUDGET_USD`) overrides it; raise it with a larger number, or set `0` to run uncapped (Argus logs a warning). |
| Review model (realtime) | `code_model: 'deepseek/deepseek-v4-flash'` |
| Batch model | `review.batchModel`, default `deepseek/deepseek-v4.1-flash:batch` (or `<code_model>:batch` when that model is known to have a batch endpoint) |
| Review mode | `review.mode`: `realtime` (default) or `batch`. Also `--mode` and `ARGUS_REVIEW_MODE`. |
| Per-request timeout | `review.requestTimeoutMs`, default 120000 ms, maximum 900000 (`ARGUS_REQUEST_TIMEOUT_MS`) |

To change any of these, edit `argus-reviewer.config.ts`. See the Configuration section of the [README](../README.md) for the full text on batch mode and timeouts.

## Stop or uninstall

- Remove `.github/workflows/argus-reviewer.yml` and `.github/workflows/argus-mention.yml`, or
- delete the `OPENROUTER_API_KEY` repository secret (reviews stop, nothing else changes).
- Optionally delete `argus-reviewer.config.ts` and `tests/argus/`.

If you have not merged the onboarding PR, close it and delete the branch; nothing has run.

## Troubleshooting

- **`could not query pull requests with gh`**: `gh` is not installed or not authenticated. Install the GitHub CLI and run `gh auth login`.
- **`this checkout has no GitHub remote named origin`**: add one, for example `git remote add origin https://github.com/<owner>/<name>.git`.
- **`--repo ... does not match this checkout's origin`**: run the command from a checkout of that repository, or drop `--repo`.
- **`refusing to overwrite existing files`**: one or more scaffold files already exist. Move or delete them, or run plain `argus-reviewer init`, which keeps your versions unless you pass `--force`.
- **Branch already exists**: if an open PR exists for the branch, the command prints it and stops. If only the branch exists on the remote, it reuses the branch and opens the PR. If it exists only locally, it pushes it and opens the PR. Use `--branch <name>` to pick a different one.
- **`could not determine the default branch`**: run `git remote set-head origin --auto`.
- **`could not create the onboarding branch from origin/<base>`**: run `git fetch origin` and retry.
- **Reviews do not start after merging**: confirm the `OPENROUTER_API_KEY` secret exists on the repository and that Actions are enabled.
