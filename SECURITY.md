# Security Policy

## Supported Versions

The project is pre-1.0. Only the latest published release on npm
(`argus-reviewer-e2e`) receives security fixes.

## Reporting a Vulnerability

Please do not open a public issue for security reports.

Report vulnerabilities via [GitHub private vulnerability reporting](https://github.com/duketopceo/Argus/security/advisories/new).
You should receive an acknowledgement within a few days.

## Notes for users

- argus-reviewer sends page screenshots to the vision model provider you
  configure (e.g. OpenRouter). Do not run it against pages containing secrets
  or personal data you are not willing to share with that provider.
- Values in `secrets` are interpolated into test steps and sent to the target
  app — keep them out of committed config and out of test files.
- `delegate`, `heal: 'a0'`, and `verify --a0` hand control to your own Agent
  Zero instance; review that instance's trust settings separately.
- `verify --app` executes the configured `target.command` and drives your app
  with a real browser — run it only against targets you are willing to have
  an agent click through.

## GitHub App and Worker boundary (planned)

Argus is bring-your-own-key and runs in your own GitHub Actions. A GitHub App
and webhook Worker for one-click onboarding are planned and not yet available
(`docs/onboarding.md`). When they exist, this boundary holds by design:

- The App and its Worker never hold, see, proxy or log a customer
  `OPENROUTER_API_KEY`, and never set repository secrets.
- They never check out or execute customer code.
- They never run reviews. Reviews run in the customer's GitHub Actions with
  the customer's key.
- Their job is limited to opening an onboarding pull request and, in an
  optional later phase, issuing short-lived tokens for a bot identity and
  check runs. Neither changes fork pull request trust (`src/trust.ts`): fork
  and `pull_request_target` runs never receive write credentials.

## GitHub Action boundary

- The action's default path installs the CLI package from the pinned action ref
  with lifecycle scripts disabled. It does not run consumer lifecycle scripts
  or start an application target.
- Browser, application, and consumer dependency installation are explicit
  opt-ins. The action rejects those lanes for fork pull requests and
  `pull_request_target`; do not work around that check by granting write
  credentials to an untrusted workflow.
- The repository's review workflow uses the published action reference and a
  separately pinned CLI package. Local action changes are checked by a
  no-secret action-contract job rather than being executed with provider or
  GitHub write credentials.
- Action inputs are parsed into an argv array. Working-directory and config
  paths are constrained to the configured workspace after resolving symlinks.
  The trusted report-dir output path rejects control characters but may be
  absolute. The PR comment step loads a checked-in CommonJS module directly;
  it does not dynamically evaluate action source.

## Sandbox probe lane (`sandbox.enabled` / action `sandbox` input)

When enabled, `code-review` executes **PR-contributed code** — model-authored
test probes against the PR's source — on your runner. The boundary:

- Docker container: `--network none`, read-only root fs, `nobody` (65534),
  `--cap-drop ALL`, `no-new-privileges`, memory/CPU/PID caps, hard wall-clock
  timeout enforced by `docker rm -f`.
- No secrets inside: no `GITHUB_TOKEN`, `OPENROUTER_API_KEY`, or ambient env —
  only a literal allowlist (`PATH`, `HOME`, npm cache). `.git` is masked
  (tmpfs for a directory checkout, a `/dev/null` bind for a worktree pointer
  file) so a persisted checkout credential is unreadable; workspace-root
  `.env`, `.npmrc`, `.netrc`, and `.git-credentials` are masked the same way.
  Pair with `persist-credentials: false` on `actions/checkout` so the token
  is never stored.
- Only `<reportDir>/probes-out` is writable; report JSON stays read-only inside
  the container. The base control run executes in a merge-base worktree with
  the head's `node_modules` bind-mounted read-only.
- Fork PRs run probes only for MEMBER/OWNER/COLLABORATOR authors or a
  maintainer `argus-probe` label applied after the current head was pushed.
  Because the config file ships in the PR's own tree, **fork PRs always run
  on the built-in sandbox defaults** — config-supplied `image`, resource
  limits, and `allowForks` are ignored for forks. The lane is force-disabled
  in code on `pull_request_target` events.
- `sandbox.image` is trusted configuration — a custom image extends the
  trusted computing base. Images are pulled from the registry every run
  (`--pull always`) so a locally poisoned tag is not trusted.

## Checkout trust and config loading

`argus-reviewer.config.ts` is executable code — loading it transpiles and
imports it on the host beside `OPENROUTER_API_KEY`/`GITHUB_TOKEN`. Trust is
resolved **before** config load (`src/trust.ts`), and `loadConfig` requires
a trust value at every call site.

- **Fork PRs are always untrusted** — on `pull_request`,
  `pull_request_target`, and `issue_comment` events alike, and regardless
  of `author_association` (a MEMBER can author a hostile fork tree).
  `pull_request*` events read fork status from `GITHUB_EVENT_PATH` (no
  token needed); `issue_comment` resolves `issue.number` via the API.
- **Unlisted CI event names fail closed** — `workflow_run`,
  `workflow_dispatch`, `push`, etc. resolve untrusted because
  privileged-CI-over-fork-checkout patterns land there. Maintainers opt
  out explicitly with `ARGUS_TRUSTED=1`.
- **Local runs default trusted** — no CI event context means the user
  checked out the tree themselves. `ARGUS_UNTRUSTED=1` opts into the
  untrusted path (e.g. reviewing a cloned untrusted repo); it always wins
  over `ARGUS_TRUSTED`.
- **Untrusted checkouts load JSON config only**, reduced to an allowlist
  of policy-free fields (`logLevel`, `sourceGlobs`). `.ts` configs are
  never transpiled or imported — including one shadowing a committed
  `.json`. Everything else is ignored: exec-bearing fields
  (`target.*`, `pageSetup`, `testsDir`, `sandbox.*`, `explore.*`),
  review policy (`severity`, `review.*`, model/budget/provider fields),
  credentials (`secrets`), network endpoints (`openrouter.*`, `a0` —
  `openrouter.headers` can override `Authorization`), and write
  locations (`cacheDir`, `indexPath`, `reportDir`). The review policy
  over hostile code must not be authored by that code.
- The composite action's staged `config:` input is inert on fork PRs by
  design.
- `node:vm` is deliberately **not** used as a boundary — Node's own docs
  warn it cannot run untrusted code safely.

## Executable verify lanes (`--app`, `--a0`)

Both lanes are explicit opt-ins that execute real work, and both are gated
on the same trust resolution as config loading:

- `verify --app` is `blocked` outright on untrusted checkouts — the lane
  never starts `target.command`, opens a browser, or reads an expected-state
  contract from a PR-controlled tree. On trusted checkouts it starts the
  configured target (or connects to `target.url`), runs a **directed** task,
  and reports `passed`/`failed`/`blocked`/`unavailable`/`inconclusive` — a
  run with no task is `blocked` before any provider call is made.
- `verify --a0` delegates the task to a configured Agent Zero host. The
  child process receives an allowlisted environment — provider keys,
  `GITHUB_TOKEN`, `ARGUS_*`, and npm auth variables are not inherited —
  and is bounded to one task and a per-task timeout. `A0_USERNAME`/
  `A0_PASSWORD` pass the allowlist only because the `a0` CLI itself
  consumes them for login-gated hosts. A remote A0 host is refused when
  the application target is loopback. The live round-trip is verified
  (#53), but a completed delegation still reports `inconclusive` — never
  `passed` — because the agent's answer is self-reported evidence.
- On `pull_request_target`, fork `pull_request`, and `issue_comment` events
  the action's runtime-lane gate refuses app/a0 inputs before the CLI runs.

**Residual surface (documented, not yet closed):**

- `run`/`record`/`delegate` on untrusted trees still execute
  PR-controlled _test files_ (the run lane scans `tests/` by default) —
  and `td.type(name, {secret:true})` falls back to `env[name]`, so env
  secrets can be typed into PR-chosen origins. Fork-PR workflows must
  not expose env secrets to those lanes; config stripping alone does
  not sandbox test execution.
- The action's optional `install-consumer-dependencies` path still runs the
  consumer's dependency lifecycle scripts on the host. It is disabled by
  default and must remain limited to trusted, non-fork runtime workflows;
  config stripping alone does not sandbox dependency installation.
