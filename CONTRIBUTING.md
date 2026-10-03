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

Node `>=22.12` for development (CI tests on 22 and 24; the dev toolchain —
electron@44 — requires it). The published package itself supports
Node `>=20.19.0` per `package.json` engines.

Docker is optional — only needed to exercise the sandbox
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

## Visual evidence (QA captures)

UI, CLI and comment changes attach screenshots to the PR. Two scripts
produce them without any model call:

```bash
# Web: 1440 and 390 px, light and dark, plus a keyboard (Tab order and
# focus indicator) report. `dashboard` serves electron/ with a stubbed
# bridge and captures its filled and empty states; any other target is a
# URL or a local HTML file.
env -u OPENROUTER_API_KEY node scripts/qa/capture-web.mjs --target dashboard --unit U13
env -u OPENROUTER_API_KEY node scripts/qa/capture-web.mjs --target dashboard --unit U13 \
  --width 1440 --theme dark --filter grayscale      # or --filter deuteranopia

# Terminal: the command run at 80 and 120 columns (needs vhs, ttyd, ffmpeg).
env -u OPENROUTER_API_KEY node scripts/qa/capture-term.mjs --unit U11 -- node dist/cli.js --help
```

Output lands in `argus-reviewer-report/qa/<unit>/`, which is gitignored:
attach the files to the PR, do not commit them. Both scripts refuse to run
while `OPENROUTER_API_KEY` is set, so a capture can never spend model
credit. Exit codes: `0` done, `1` keyboard check failed (captures still
written), `2` bad arguments or capture error, `3` refused because the key
is set. The dashboard seed data lives in `scripts/qa/dashboard-fixture.mjs`
and is shared with `npm run smoke:dashboard`.

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
