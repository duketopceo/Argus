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
- `delegate` and `heal: 'a0'` hand control to your own Agent Zero instance;
  review that instance's trust settings separately.

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

**Residual surface (documented, not yet closed):**

- `run`/`record`/`delegate` on untrusted trees still execute
  PR-controlled *test files* (the run lane scans `tests/` by default) —
  and `td.type(name, {secret:true})` falls back to `env[name]`, so env
  secrets can be typed into PR-chosen origins. Fork-PR workflows must
  not expose env secrets to those lanes; config stripping alone does
  not sandbox test execution.
- The action's `npm ci` runs the PR's dependency lifecycle scripts
  (postinstall etc.) on the host *before* any sandboxing — a
  pre-existing property of running a project's own suite in CI. Do not
  run this action with secrets on workflows that check out untrusted PR
  code.
