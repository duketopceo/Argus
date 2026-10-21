# Argus Roadmap

**Post-launch phase plan:** [`docs/plans/2026-09-14-006-feat-post-launch-roadmap-plan.md`](docs/plans/2026-09-14-006-feat-post-launch-roadmap-plan.md)

## Unit overlay: difficulty, feasibility, simpler alternative (2026-10-10)

Overlay on the live roadmap plan's units (U-IDs are that plan's). Statuses in
the table are current as of the 2026-10-10 overlay date above; the 2026-10-04
competitive plan (U1-U16), the 2026-10-06 LOC audit and the 2026-10-08
install-pathway plan carry their own unit lists and are summarised at the end
(their status snapshots are historical, of their own dates). Judgements are
mine, from reading the plans and code, not measured.

| Unit | Status | Difficulty | Feasibility (what could block it) | Simpler alternative |
|---|---|---|---|---|
| U1-U4 Proof, demo, OIDC release, clean-install smoke | shipped | easy | none left | None; keep. |
| U5-U6 Evidence linkage, sandbox probes | shipped | medium: probes must stay env-sanitised | Sandbox escape risk stays the standing concern | Probes already reuse CI results; do not add a second runner. |
| U7 Live A0 verification | blocked | hard: needs a live Agent Zero host round trip | Blocked on #53 and the upstream marketplace listing (agent0ai/a0-plugins#572) | Keep the `inconclusive` seam as the shipped answer; skip live verification until upstream lands. |
| U8 A0 scope and cost controls | shipped (seam) | medium | Depends on U7 for real data | Reuse the review lane budget in `src/vision/` instead of a separate A0 meter. |
| U9 Runner health dashboard | open | medium: new data source (`gh` runner API) | Runner API needs org admin scope; local-only view is always possible | Show runner state from `live.ndjson` only and add a Spend-style panel in `electron/ui/views/`; skip the GitHub API. |
| U10 Org spend alerts and caps | open | medium | Needs persistent cross-run storage; no server by design | Per-repo cap in `argus-reviewer.config.ts` plus a CI step that sums prior run manifests; no org service. |
| U11 GHE and GitLab | open | hard: comment/status surface is GitHub-shaped in `action/sticky-comment.cjs` | GitLab API differences; no test tenant | GHE only (same API). Drop GitLab until asked. |

Cross-cutting simplifications worth doing before new units:

- `src/cli.ts` (about 4.9k lines, `cmdCodeReview` about 1.1k inline) is the
  biggest cost per unit; split per command before U9-U11 (LOC audit plan).
- `action/sticky-comment.cjs` and `src/report/comment.ts` render the same
  comment twice; `tests/unit/comment-golden.test.ts` pins their output parity.
  A single bundled renderer would delete the duplicate and that golden gate —
  while `check:parity` (the committed `action/parity.cjs` freshness check)
  stays for as long as the bundle is committed.
- Hand-maintained surfaces: the desk (`electron/ui/`), the HTML report
  (`src/report/html.ts`) and the TUI (`scripts/watch.mjs`) each re-implement
  the tally meter and glyph rows. Token CSS is shared; markup is not.

Other plans: competitive U1 heal write-back and U5 `@argus fix` are
medium-hard (they write to the user's repo; need a push-permission story).
U12 MCP server and U13 session replay are the first candidates to cut: large
surface for unproven demand. Install-pathway U5/U6 (Worker deployment, App
registration) are blocked on the owner's Cloudflare and GitHub App accounts.


Newer plans: [`docs/plans/2026-10-04-0003-feat-competitive-roadmap-plan.md`](docs/plans/2026-10-04-0003-feat-competitive-roadmap-plan.md), [`docs/plans/2026-10-07-1900-feat-review-polish-scale-plan.md`](docs/plans/2026-10-07-1900-feat-review-polish-scale-plan.md), [`docs/plans/2026-10-08-001-feat-install-pathway-coverage-rollout-plan.md`](docs/plans/2026-10-08-001-feat-install-pathway-coverage-rollout-plan.md). Competitive evidence: [`docs/competitive-review.md`](docs/competitive-review.md).

Status snapshot (2026-10-11, v0.5.0 released 2026-10-07):

- **P1 Proof & adoption — shipped.** Demo assets, npm OIDC trusted publishing, clean-install smoke in CI.
- **P2 Execution-backed review — shipped.** Probe lane ("reproduced, not suspected"), sandbox regression probes feed the verdict.
- **P3 A0 depth — partly shipped.** [a0-plugin-argus](https://github.com/duketopceo/a0-plugin-argus) live; upstream marketplace listing still pending agent0ai/a0-plugins#572. The `verify --a0` seam shipped with #102 and reports `inconclusive` by design; the live host round-trip (#53) was closed as proven on 2026-10-01 via #109.
- **P4 Scale — open.** Issues #21–#23.
- **Since v0.3.1:** v0.4.x (GitHub App onboarding, `init --pr`) and v0.5.0 (nit consolidation, deterministic rules lane, `scan`, eval corpus, incremental review, `@argus fix`). See [`CHANGELOG.md`](CHANGELOG.md) for unreleased work.

Working rule: each phase gets its own detailed plan under `docs/plans/` when picked up;
this file stays a pointer plus status so agents can orient in one read.
