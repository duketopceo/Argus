# Contributing

Thanks for helping make Argus better. This file covers the dev setup, the
verification commands CI runs, and the conventions we ask PRs to follow.

## Setup

```bash
git clone https://github.com/duketopceo/Argus.git
cd Argus
npm ci
npx playwright install chromium   # required for driver tests
```

Node `>=20.19.0`. Docker is optional — only needed to exercise the sandbox
probe lane locally (`sandbox.enabled` in `argus-reviewer.config.ts`).

## Verify before pushing

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm run build       # tsc -p tsconfig.build.json
npm test            # vitest run — 200+ unit tests
```

CI runs the same four steps on every PR plus a clean-install consumer
smoke (`scripts/consumer-smoke.mjs`) when `src/`, `action/`, or
`package.json` change.

## Conventions

- **Commits/PRs:** conventional-style subjects (`feat:`, `fix:`, `docs:`,
  `chore:`). All changes land through pull requests — no direct pushes to
  `main`.
- **`dist/` is committed.** Consumers installing from git get the built
  output, so run `npm run build` and commit `dist/` changes alongside
  `src/` changes. The npm package builds itself via `prepare`.
- **Config shape changes** belong in `src/config.ts` with validation +
  a unit test; user-facing surfaces also need `docs/quickstart.md`,
  `action/action.yml`, or `SECURITY.md` updates as applicable.
- **Security posture:** treat PR-controlled code, config, test files, and
  generated probes as hostile. Fail closed on parse/path/trust errors;
  `node:vm` is not an isolation boundary. See `SECURITY.md` before
  touching the sandbox or config loader.

## Reporting bugs / requesting features

Use the issue templates — include `argus-reviewer` version, Node version,
runner type (GitHub-hosted vs self-hosted), and a redacted config. For
security issues, **do not open a public issue** — use
[private vulnerability reporting](https://github.com/duketopceo/Argus/security/advisories/new)
per `SECURITY.md`.

## License

MIT — by contributing you agree your contributions are licensed the same
way.
