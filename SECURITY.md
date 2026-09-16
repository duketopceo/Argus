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
  only a literal allowlist (`PATH`, `HOME`, npm cache). `.git` is masked with a
  tmpfs so a persisted checkout credential is unreadable; pair with
  `persist-credentials: false` on `actions/checkout` so it is never stored.
- Only `<reportDir>/probes-out` is writable; report JSON stays read-only inside
  the container.
- Fork PRs run probes only for MEMBER/OWNER/COLLABORATOR authors, a maintainer
  `argus-probe` label applied after the current head was pushed, or explicit
  `sandbox.allowForks`. `pull_request_target` workflows are unsupported.
- `sandbox.image` is trusted configuration — a custom image extends the
  trusted computing base. Images are pulled from the registry every run
  (`--pull always`) so a locally poisoned tag is not trusted.

**Accepted gap:** the action's `npm ci` runs the PR's dependency lifecycle
scripts (postinstall etc.) on the host *before* any sandboxing — that is a
pre-existing property of running a project's own test suite in CI and is out
of the probe lane's boundary. Do not enable probes (or this action at all) on
workflows that hand secrets to untrusted PR code.
