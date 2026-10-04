---
title: "feat: GitHub App onboarding for Argus"
type: feat
status: draft
date: 2026-10-04
depth: standard
mode: pipeline (non-interactive)
---

# feat: GitHub App onboarding for Argus

## Status as of 2026-10-04 (evening)

Verified against `gh pr list -R duketopceo/Argus` and `git ls-tree origin/main` (main at `b9c19a4`). The plan itself is on main (#115). v0.4.0 is released and v0.4.1 (scaffold pin correctness, #129 and #130) is on main. The v0.4.0 tag move (`c91fbd5` to `1f6bdc3`) awaits the user. The GitHub App install docs and opt-in approval wiring in the `init` scaffold (#116) are a separate, smaller path from this plan.

**Done on main:** none of U1 to U9 (no `src/onboarding/` or `app/worker/` on main; U1 to U5 exist only on open PR branches).

**In review (all open):** U1 + U2 in #125 (base #124 branch); U3 in #126 (base #125 branch); U4 + U5 in #131 (base main, not a draft, changes requested). The repo requires 1 review to merge.

**Todo:** U6 (needs #125's scaffold module on main first), U7, and optional U8, U9.

**Reviewer work outside this plan's units (open):** #121 chunked review and batch mode (base main) -> #124 bake-off defaults (base #121) -> #125 -> #126 -> #127 $1 default budget cap (base #126 branch); #123 bake-off evals (base main, independent). Stack: #121 -> #124 -> #125 -> #126 -> #127.

**Merged since the morning status:** #122 (OCR static-lane plan, docs only), #128 (previous plan status), #129 and #130 (v0.4.1).

**Blocked on the user:** the pipeline-mode open questions below (notably the Q5 gate for any hosted key) before Phase 3; the v0.4.0 tag move. No Phase 1 blocker beyond review.

**Recommended merge order:** #123, then #121, #124, #125, #126 in that order (retarget each to main after its parent merges), with #131 after #125 lands if U6 builds on it. Cut a release after #126 so the onboarding path is installable, then measure demand before starting U6.

## Verdict

**A GitHub App is a good idea, but only as the second step and only as a thin, key-free onboarding and identity layer.** Ship `argus-reviewer init --pr` first (zero hosting, solves most of the onboarding pain). Add the App second for one-click install, a bot identity, Checks API check runs and an automatic onboarding PR. Reject any design where the App's infrastructure runs reviews, holds an OpenRouter key, or checks out customer code: that would turn Argus into the SaaS middleman its README says it is not.

Tradeoffs in one table:

| | CLI `init --pr` only | Hybrid (CLI + App + Worker) | App-hosted review (rejected) |
|---|---|---|---|
| Hosting / cost | none | one Worker, free tier is enough | compute plus key custody, real bill |
| Onboarding friction | run one command, add one secret | click install, add one secret | click install |
| Bot identity, check runs | no | yes | yes |
| BYOK / self-hosted promise | intact | intact (App never sees the key) | broken |
| New attack surface | none | webhook Worker and App private key | customer code and keys on our infra |
| Works for fork PR checks | no | partly (see KTD6) | yes, at high security cost |

## Problem frame

Today onboarding is `npm i -D argus-reviewer-e2e`, `npx argus-reviewer init` (writes `argus-reviewer.config.ts`, `tests/argus/smoke.test.ts`, `.github/workflows/argus-reviewer.yml`, `.github/workflows/argus-mention.yml`, then prints a checklist; see `cmdInit` in `src/cli.ts`). The user must be in a local checkout, have Node, commit and push the files by hand, and remember to add `OPENROUTER_API_KEY` as a repo secret. There is no way to onboard a repo or an org without touching each checkout, no bot identity (comments come from `github-actions[bot]`), and no check run (the Ocellus plan, `docs/plans/2026-10-02-2316-feat-ocellus-redesign-plan.md` on `origin/feat/ocellus-integration`, "Considered and not built: the Checks API ... needs `checks: write`, which fork tokens lack ... Revisit if Argus moves to a GitHub App").

The user asked whether a GitHub App is how this is done. Short answer: an App is how install-to-repo flows are done on GitHub, but Argus's differentiator is that compute and keys stay in the customer's Actions, so the App should only onboard and identify, not compute.

## Research summary (verified 2026-10-03)

- **GitHub Apps vs OAuth Apps.** GitHub states Apps are preferred: fine-grained permissions, per-repo selection, short-lived tokens (installation tokens expire after one hour); OAuth tokens are long-lived by default and `repo` scope is broad. Rate limits scale with repo and user count for Apps. https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/differences-between-github-apps-and-oauth-apps
- **Check runs need an App.** "Write permission for the REST API to interact with checks is only available to GitHub Apps. OAuth apps and authenticated users can view check runs ... but they are not able to create them." Needs `checks: write`. https://docs.github.com/en/rest/checks/runs . Nuance: a workflow's own `GITHUB_TOKEN` with `checks: write` can create check runs attributed to the `github-actions` app on same-repo PRs; the gap is fork PRs.
- **Fork PR tokens.** Fork `pull_request` runs get a read-only `GITHUB_TOKEN` and no secrets. https://docs.github.com/en/actions/security-for-github-actions/security-guides/automatic-token-authentication (this is why Ocellus deferred checks).
- **Actions-only is a valid third option** (what Argus is today): no install step beyond the workflow file; but no bot identity, no check runs on forks, no org-wide rollout.
- **Workflow file writes need the `workflows` permission**, beyond Contents. "If your app specifically needs to access or edit Actions files in the `.github/workflows` directory, request the 'Workflows' repository permission." https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app . Branch and PR creation use `POST /git/refs`, `PUT /contents/{path}`, `POST /pulls` (Contents write + Pull requests write). https://docs.github.com/en/rest/overview/permissions-required-for-github-apps
- **Webhook security.** Validate `X-Hub-Signature-256` as HMAC-SHA256 of the raw body, compare in constant time, treat body as UTF-8. https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
- **App manifest flow** lets a user (or us) register an App from JSON; GitHub returns `pem`, `webhook_secret`, `id`; the code must be converted within one hour. Useful for a "register your own copy of the App" path for orgs that refuse a third-party App. https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest
- **Marketplace.** Free apps need only the universal requirements (contact and support, docs, privacy policy link, pricing plan specified, functionality beyond authentication, plan-change webhook events, public listing, branding). Paid listings need a verified publisher org and 100+ installs. https://docs.github.com/en/apps/github-marketplace/creating-apps-for-github-marketplace/requirements-for-listing-an-app
- **Renovate** installs as an App on all or selected repos, then opens a "Configure Renovate" onboarding PR with a `renovate.json`; it changes nothing further until that PR merges. Skips repos with no relevant files and forks. https://docs.renovatebot.com/getting-started/installing-onboarding/ . This is the model to copy.
- **CodeRabbit** onboards as sign-in with the Git platform then "add repositories"; the hosted service runs reviews, so there is no key-handling story to copy. https://docs.coderabbit.ai/getting-started/quickstart . Dependabot is a built-in GitHub feature enabled by a committed `dependabot.yml`, the Actions-only analog. Sourcery was not re-verified in this pass (open question Q6).
- **Cloudflare Workers free plan:** 100,000 requests/day, 10 ms CPU per request, 50 subrequests per request, 64 env vars of 5 KB. https://developers.cloudflare.com/workers/platform/limits/ . A webhook receiver that verifies HMAC and makes at most five API calls per install fits; JWT signing (RS256) with WebCrypto is a few ms, but must be measured (Q3).

## Requirements

- R1. A user can onboard a repo with one command and no local checkout of Argus internals (`init --pr`).
- R2. A user or org admin can install the App on selected repos and receive an onboarding PR automatically.
- R3. The App and its Worker never hold, see, proxy or log a customer `OPENROUTER_API_KEY`, and never execute customer code.
- R4. Review compute remains in the customer's GitHub Actions. The action and `src/trust.ts` behavior for fork PRs is unchanged.
- R5. The onboarding PR is reviewable, adds nothing that runs until merged, and carries a secrets checklist.
- R6. Optional bot identity and Checks API check runs, without weakening the fork-PR trust lane.
- R7. Free tier hosting only; the Worker holds no customer data beyond installation IDs it can rederive.
- R8. Orgs that will not install a third-party App can self-register the same App (manifest flow) or stay on `init --pr`.

## Key technical decisions

- **KTD1. Hybrid, CLI first.** `init --pr` has the best value per risk and is the only piece needed to validate demand. The App is built after it, and each phase ships independently.
- **KTD2. Share one scaffold generator.** `init` and the Worker both render the same workflow, config and checklist from one pure module (`src/onboarding/scaffold.ts`) so the CLI and App PRs cannot drift. The Worker bundles the compiled module; the Worker does not import `loadConfig` or anything that executes config.
- **KTD3. The Worker is a webhook receiver and PR opener only.** Events: `installation` (created), `installation_repositories` (added), and optionally `pull_request` is NOT subscribed. It verifies the signature, mints a short-lived installation token, and opens one onboarding PR per repo. No queue, no database in v1: idempotency comes from checking whether the branch `argus/onboarding` or an open onboarding PR already exists (the GitHub API is the state). KV only if rate limiting is needed (Q3).
- **KTD4. Permissions are split by phase.** Phase 2 App: `metadata: read`, `contents: write`, `pull_requests: write`, `workflows: write` (needed solely because the onboarding PR touches `.github/workflows/`). Checks and identity (Phase 3) are a second App registration, or a permission upgrade that GitHub asks every installer to re-approve. Recommend a separate "Argus Checks" App so the onboarding App can hold `workflows: write` and the check App never does. See Q2.
- **KTD5. The App never receives secrets and never sets them.** Writing a repo secret needs `secrets: write` plus libsodium sealing of a value we would have to see. Rejected. The onboarding PR contains a checklist and a deep link to `https://github.com/<owner>/<repo>/settings/secrets/actions/new?name=OPENROUTER_API_KEY`. Optionally `init --pr` runs `gh secret set OPENROUTER_API_KEY` locally from the user's own environment (key never leaves their machine toward us).
- **KTD6. Checks and bot identity go through a token broker, not through our compute.** The customer's workflow requests a GitHub Actions OIDC token (`id-token: write`); the Worker verifies it against GitHub's JWKS, checks `repository`, `event_name`, `ref` claims against the App installation, and returns a one-hour installation token scoped down to `checks: write` and `pull_requests: write` on that single repo. Fork PRs cannot request OIDC tokens, so the broker is unreachable for them and the trust lane is unchanged: fork runs keep commenting through the existing path and still get no check run. This preserves BYOK because the broker sees only repo identity. It is also the highest-risk component (holds the private key and mints tokens); gate it behind Phase 3 and a separate threat review. Alternative considered: the customer registers their own App via manifest flow and puts its key in their secrets (zero hosted key; more friction). Both are offered; hosted broker is optional (KTD8).
- **KTD7. Approval identity is out of scope.** The existing `approval-token` input (docs/approval-token.md) already accepts an App installation token. The broker must never mint a token with `pull_requests: write` that is usable for `APPROVE` unless the workflow also supplies `approval-evidence` and `approval-check`; simplest rule: the broker scope in v1 omits nothing GitHub lets us omit (review submission is covered by `pull_requests: write`), so the action's evidence rules, not the broker, are the control. Flagged as Q4.
- **KTD8. Self-hosted mode is first-class.** Publish the Worker source under `app/` (or its own package) with a manifest-flow script so any org can run its own copy with its own App and key. The hosted instance is a convenience, not a requirement.
- **KTD9. Marketplace is deferred.** Free listing is possible but adds privacy-policy, support and branding obligations; do it after install count justifies it. Paid listing is out (needs 100 installs plus billing, contradicts "no per-seat pricing").

## Open questions (pipeline mode, not blocking Phase 1)

- Q1. Brand and owner of the hosted App: a `duketopceo`-owned App or a new org (needed later for verified publisher)?
- Q2. One App with upgrade-on-demand permissions, or two Apps (onboarding vs checks)? Recommendation: two.
- Q3. Does RS256 JWT signing plus 3 to 5 API calls stay under the free-plan 10 ms CPU limit? Measure in U6; if not, the Workers paid plan is $5/month, still tiny.
- Q4. Should the broker be allowed to mint tokens usable for approvals at all? Default: no approval path in v1.
- Q5. Is the maintainer willing to be on the hook for a hosted private key (rotation, incident response)? If not, ship only self-hosted mode (KTD8).
- Q6. Verify how Sourcery onboards (not fetched in this pass).
- Q7. Pinned action SHA in the generated workflow: the scaffold pins `duketopceo/Argus/action@<sha>`; who bumps it in already-onboarded repos? Suggest Dependabot config in the onboarding PR.

## Scope boundaries

In: scaffold module, `init --pr`, Worker webhook and PR opener, manifest-flow self-registration, token broker (optional, last), docs, tests.
Out: hosted review compute, secret storage or injection, customer-code checkout on our infra, Marketplace listing, paid plans, enterprise GitHub Server support, changing `src/trust.ts` semantics.
Deferred: per-repo dashboards, install analytics (no telemetry by promise).

## Implementation units

Each unit is one PR. Units U1 to U3 are Phase 1 (no hosting); U4 to U7 are Phase 2; U8 to U9 are Phase 3.

### Phase 1: CLI

- U1. **Extract the scaffold generator** [status: in review (PR #125, base #124 branch)]
  - Goal: move `INIT_WORKFLOW`, `INIT_MENTION_WORKFLOW`, config and smoke test templates out of `src/cli.ts` into `src/onboarding/scaffold.ts` as a pure function returning `{path, content}[]` plus a checklist. Behavior of `init` unchanged.
  - Files: `src/onboarding/scaffold.ts` (new), `src/cli.ts`, `dist/` rebuild, `tests/unit/onboarding-scaffold.test.ts`
  - Tests: golden output equals current `init` output; workflow keeps `persist-credentials: false`, pinned action SHA, minimal `permissions`; no `pull_request_target`.
- U2. **`init --pr`** [status: in review (PR #125, base #124 branch)]
  - Goal: `argus-reviewer init --pr [--repo owner/name] [--branch argus/onboarding]` creates the branch, commits scaffold files via the Git Data/Contents API (or local `git` + `gh pr create`), opens a PR whose body has the secrets checklist, what-is-sent-to-provider statement, default budget, and how to stop. Refuses to overwrite existing files; idempotent if the branch or PR exists. Never reads or transmits `OPENROUTER_API_KEY`.
  - Files: `src/cli.ts`, `src/onboarding/pr.ts`, `tests/unit/init-pr.test.ts` (injected `exec`/fetch via `CliDeps`)
  - Dependencies: U1.
- U3. **Docs and README onboarding path** [status: in review (PR #126, base #125 branch)]
  - Goal: README "Get started" leads with `npx argus-reviewer init --pr`; add `docs/onboarding.md` describing the three paths (CLI, App, self-hosted App) and the secret checklist. Add a SECURITY.md paragraph stating the App/Worker boundary (R3).
  - Dependencies: U2.

### Phase 2: App and webhook Worker

- U4. **Worker skeleton, signature verification, replay guard** [status: in review (PR #131, base main)]
  - Goal: `app/worker/` (own `package.json`, excluded from the published tarball and root lint/tsconfig as `launch/` is in Ocellus) with `POST /webhook`: raw-body HMAC-SHA256 constant-time verify, `X-GitHub-Delivery` dedupe window (best effort), body size cap, 401 on any failure, no body logging.
  - Tests: GitHub's published test vector (secret `It's a Secret to Everybody`, payload `Hello, World!`, signature `sha256=757107ea...3e17`), tampered body, missing header, wrong content type, oversize body.
- U5. **App auth: JWT and installation token** [status: in review (PR #131, base main)]
  - Goal: RS256 JWT with WebCrypto (`iat` backdated 60 s, `exp` under 10 min), exchange for an installation token restricted to the single repo and the minimal permission set; token never persisted or logged. Private key lives only in a Worker secret.
  - Tests: JWT claims, key import from PKCS8, token request body restricts `repositories` and `permissions`, redaction of tokens in error paths.
- U6. **Onboarding PR on install** [status: todo (needs #125 scaffold module merged)]
  - Goal: handle `installation.created` and `installation_repositories.added`; per repo skip archived, forked, and repos with `.github/workflows/argus-reviewer.yml`; create branch, commit scaffold (shared module, U1), open the PR. Uses the Contents/Git Data API only. Measure CPU time and subrequests against free limits.
  - Tests: mocked GitHub API; idempotency (branch exists, PR exists); fork/archived skip; fan-out cap of N repos per delivery with remainder noted in logs (50-subrequest limit).
  - Dependencies: U4, U5.
- U7. **Manifest-flow self-registration and deploy docs** [status: todo]
  - Goal: `app/register/` script and `docs/self-host-app.md` so an org registers its own App, deploys the Worker with `wrangler`, and sets secrets (`APP_ID`, `PRIVATE_KEY`, `WEBHOOK_SECRET`). Includes key rotation steps.

### Phase 3: Identity and checks (optional, own threat review)

- U8. **Token broker endpoint (OIDC)** [status: todo (optional)]
  - Goal: `POST /token` verifies the GitHub Actions OIDC JWT (signature via GitHub JWKS, `iss`, `aud`, `exp`, `repository`, `event_name` not `pull_request` from fork, installation exists), returns an installation token limited to `checks: write` + `pull_requests: write` for that one repo. Rate limit per repo.
  - Tests: expired, wrong audience, repo not installed, fork-origin claims, replay.
- U9. **Action: optional check run and App identity** [status: todo (optional)]
  - Goal: new optional action input (`check-run: true`, `app-token-url`) that requests a broker token and publishes a check run summarizing the manifest verdict; falls back silently to current commit-status path when the token is unavailable (fork PRs, broker down). No change to `src/trust.ts`.
  - Tests: `tests/unit/action-contract.test.ts` extended: input absent means identical behavior; fork events never call the broker; failure is non-fatal.
  - Dependencies: U8.

## Security section

### Threat model: webhook Worker

| Threat | Mitigation |
|---|---|
| Forged webhook (anyone can POST) | HMAC-SHA256 on raw body, constant-time compare, reject before parsing JSON; 401 with no detail |
| Replay of a genuine delivery | Dedupe on `X-GitHub-Delivery`; all handlers idempotent (branch and PR existence checks) |
| Abuse as an open PR spammer (installing on many repos) | Only act on `installation*` events; cap repos per delivery; skip forks, archived, already-onboarded repos; per-installation daily cap |
| Compromised repo content in payloads (repo names, branch names, PR titles) | Treat all payload strings as data; never interpolate into commands, URLs without encoding, or markdown without escaping; the scaffold has no payload-derived content except `owner/repo` validated against `^[A-Za-z0-9_.-]+$` |
| Payload or API response leaks tokens into logs | No body logging; redact `Authorization` and `ghs_` tokens; Workers logs off for the webhook route by default |
| DoS / free-tier exhaustion (100k req/day) | Early 401 is cheap; Cloudflare WAF rate rules; worst case degrades to CLI path (no one is blocked) |
| Supply chain in Worker deps | Zero runtime deps beyond platform WebCrypto and `fetch`; pinned lockfile; Worker not in the npm tarball |
| Worker reads customer code or keys | Not requested: no `contents: read` on arbitrary repos beyond what branch creation needs; no `secrets` permission; no `actions` permission; no checkout of code |

### Threat model: App private key

- Compromise lets an attacker mint installation tokens for every installation with `contents: write`, `pull_requests: write`, `workflows: write`: they could push workflow changes to a branch and open PRs (not merge to protected default branches; branch protection and required review still apply). This is the worst case and is why `workflows: write` stays in an App with no other privileges and why Phase 3 uses a separate App (KTD4).
- Storage: Worker secret only (never in the repo, never in a Docs/chat artifact); local copy in omaseal, not on disk. Generate a fresh key per environment; the dev App is a separate registration.
- Rotation: GitHub supports multiple private keys per App, so rotate by adding key B, deploying, deleting key A; document in U7. Rotate on any suspected exposure and on a schedule (annual).
- Blast radius controls: installation-token requests always pass `repositories` (one repo) and the minimal `permissions`; tokens expire in an hour and are not stored; the App is not subscribed to `pull_request`, `push`, or `issue_comment` so it never handles PR-controlled content.
- Detection: GitHub audit log of App activity; alert on onboarding PRs opened beyond expected rate (Worker analytics).

### Trust-lane invariants (must not weaken)

- `src/trust.ts` is read-only for this program. No unit touches it; U9 adds a test that fork and `pull_request_target` events never reach the broker.
- The generated workflow uses `pull_request` (never `pull_request_target`), `persist-credentials: false`, and least-privilege `permissions`, consistent with SECURITY.md "GitHub Action boundary". `argus-mention.yml` stays base-ref checkout.
- The App must not grant write tokens to untrusted workflows. The broker refuses fork-origin OIDC contexts (and fork runs have no `id-token`), matching SECURITY.md: "do not work around that check by granting write credentials to an untrusted workflow".
- Secrets: R3 and KTD5. The onboarding PR and Worker code are audited by a test that greps the Worker bundle for `OPENROUTER` and `secrets` API usage.

## Test strategy

- Unit (vitest, `tests/**/*.test.ts` only, per AGENTS.md): scaffold goldens, `init --pr` with injected exec/fetch, Worker handlers as pure functions over `Request`/`Response` with a fake GitHub API, JWT/JWKS verification with locally generated keys, GitHub's documented HMAC test vector.
- Contract: action contract tests for new optional inputs (absent means unchanged), `check:dist` rebuilds for any `src/` change.
- Security tests: tampered signature, replay, oversize body, forged OIDC claims, fork-origin claims, token redaction in logs, bundle contains no key-handling code.
- Integration (manual, one-time, documented): install the dev App on a scratch repo, verify the onboarding PR opens, merge it, confirm the workflow runs with the customer-set secret. Use `wrangler dev` plus a tunnel for local webhooks; never against `~/Documents/github/personal/Argus`.
- Free-tier budget: a CPU-time test or `wrangler` measurement recorded in the U6 PR.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Hosted key makes us a target | Self-hosted mode first-class (KTD8); separate checks App; Q5 gate |
| App Marketplace/Install trust friction for orgs | `init --pr` always available; manifest flow for self-registration |
| Onboarding PR noise on many repos | Renovate-style: only on explicit install, one PR per repo, skips forks and archived |
| Scaffold drift between CLI and Worker | Single module (KTD2) plus golden test |
| Pinned action SHA gets stale in onboarded repos | Q7: ship a Dependabot config in the onboarding PR |

## Sequencing

U1, U2, U3 (ship, release, measure demand) then U4, U5, U6, U7 (App) then U8, U9 only if check runs or bot identity are wanted after the first installs. Each phase can stop without leaving the product in a half state.
