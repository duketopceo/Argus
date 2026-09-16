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

**Accepted gaps:**

- The action's `npm ci` runs the PR's dependency lifecycle scripts
  (postinstall etc.) on the host *before* any sandboxing — that is a
  pre-existing property of running a project's own test suite in CI and is
  out of the probe lane's boundary. Do not enable probes (or this action at
  all) on workflows that hand secrets to untrusted PR code.
- `argus-reviewer.config.ts` is executed on the host when the config loads —
  a PR can modify its own config file. Keep `OPENROUTER_API_KEY` scoped to a
  spend-limited OpenRouter key and treat review findings from hostile PRs as
  untrusted; the probe sandbox does not cover config load or `npm ci`.
