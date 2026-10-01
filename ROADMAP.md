# Argus Roadmap

**Live roadmap:** [`docs/plans/2026-09-14-006-feat-post-launch-roadmap-plan.md`](docs/plans/2026-09-14-006-feat-post-launch-roadmap-plan.md)

Status snapshot (2026-09-30, v0.3.1):

- **P1 Proof & adoption — shipped.** Demo assets, npm OIDC trusted publishing, clean-install smoke in CI.
- **P2 Execution-backed review — shipped.** Probe lane ("reproduced, not suspected"), sandbox regression probes feed the verdict.
- **P3 A0 depth — in progress.** [a0-plugin-argus](https://github.com/duketopceo/a0-plugin-argus) live; upstream marketplace listing pending agent0ai/a0-plugins#572. The `verify --a0` escalation seam ships with the insight-first follow-through PR (#102) — scoped, budgeted, env-sanitized, honestly `inconclusive`; live host round-trip remains blocked on #53.
- **P4 Scale — open.** Issues #21–#23.
- **In flight:** insight-first follow-through (#102) — `verify --app` task lane, A0 seam, manifest-first surfaces (comment/TUI/Electron), onboarding rework. Exploratory act policy shipped (#99). Researched: ARTEMIS mobile lane.

Working rule: each phase gets its own detailed plan under `docs/plans/` when picked up;
this file stays a pointer plus status so agents can orient in one read.
