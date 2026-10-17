# Argus Roadmap

**Post-launch phase plan:** [`docs/plans/2026-09-14-006-feat-post-launch-roadmap-plan.md`](docs/plans/2026-09-14-006-feat-post-launch-roadmap-plan.md)

Newer plans: [`docs/plans/2026-10-04-0003-feat-competitive-roadmap-plan.md`](docs/plans/2026-10-04-0003-feat-competitive-roadmap-plan.md), [`docs/plans/2026-10-07-1900-feat-review-polish-scale-plan.md`](docs/plans/2026-10-07-1900-feat-review-polish-scale-plan.md), [`docs/plans/2026-10-08-001-feat-install-pathway-coverage-rollout-plan.md`](docs/plans/2026-10-08-001-feat-install-pathway-coverage-rollout-plan.md). Competitive evidence: [`docs/competitive-review.md`](docs/competitive-review.md).

Status snapshot (2026-10-11, v0.5.0 released 2026-10-07):

- **P1 Proof & adoption — shipped.** Demo assets, npm OIDC trusted publishing, clean-install smoke in CI.
- **P2 Execution-backed review — shipped.** Probe lane ("reproduced, not suspected"), sandbox regression probes feed the verdict.
- **P3 A0 depth — partly shipped.** [a0-plugin-argus](https://github.com/duketopceo/a0-plugin-argus) live; upstream marketplace listing still pending agent0ai/a0-plugins#572. The `verify --a0` seam shipped with #102 and reports `inconclusive` by design; the live host round-trip (#53) was closed as proven on 2026-10-01 via #109.
- **P4 Scale — open.** Issues #21–#23.
- **Since v0.3.1:** v0.4.x (GitHub App onboarding, `init --pr`) and v0.5.0 (nit consolidation, deterministic rules lane, `scan`, eval corpus, incremental review, `@argus fix`). See [`CHANGELOG.md`](CHANGELOG.md) for unreleased work.

Working rule: each phase gets its own detailed plan under `docs/plans/` when picked up;
this file stays a pointer plus status so agents can orient in one read.
