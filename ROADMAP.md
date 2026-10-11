# Argus Roadmap

## Unit overlay: difficulty, feasibility, simpler alternative (2026-10-10)

Overlay on the live roadmap plan's units (U-IDs are that plan's). Status is as
of the snapshot below; the 2026-10-04 competitive plan (U1-U16), the 2026-10-06
LOC audit and the 2026-10-08 install-pathway plan carry their own unit lists
and are summarised at the end. Judgements are mine, from reading the plans and
code, not measured.

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
  comment twice; the parity gate (`check:parity`) exists only because of it.
  A single bundled renderer would delete the duplicate and the gate.
- Hand-maintained surfaces: the desk (`electron/ui/`), the HTML report
  (`src/report/html.ts`) and the TUI (`scripts/watch.mjs`) each re-implement
  the tally meter and glyph rows. Token CSS is shared; markup is not.

Other plans: competitive U1 heal write-back and U5 `@argus fix` are
medium-hard (they write to the user's repo; need a push-permission story).
U12 MCP server and U13 session replay are the first candidates to cut: large
surface for unproven demand. Install-pathway U5/U6 (Worker deployment, App
registration) are blocked on the owner's Cloudflare and GitHub App accounts.


**Live roadmap:** [`docs/plans/2026-09-14-006-feat-post-launch-roadmap-plan.md`](docs/plans/2026-09-14-006-feat-post-launch-roadmap-plan.md)

Status snapshot (2026-09-30, v0.3.1):

- **P1 Proof & adoption — shipped.** Demo assets, npm OIDC trusted publishing, clean-install smoke in CI.
- **P2 Execution-backed review — shipped.** Probe lane ("reproduced, not suspected"), sandbox regression probes feed the verdict.
- **P3 A0 depth — in progress.** [a0-plugin-argus](https://github.com/duketopceo/a0-plugin-argus) live; upstream marketplace listing pending agent0ai/a0-plugins#572. The `verify --a0` escalation seam ships with the insight-first follow-through PR (#102) — scoped, budgeted, env-sanitized, honestly `inconclusive`; live host round-trip remains blocked on #53.
- **P4 Scale — open.** Issues #21–#23.
- **In flight:** insight-first follow-through (#102) — `verify --app` task lane, A0 seam, manifest-first surfaces (comment/TUI/Electron), onboarding rework. Exploratory act policy shipped (#99). Researched: ARTEMIS mobile lane.

Working rule: each phase gets its own detailed plan under `docs/plans/` when picked up;
this file stays a pointer plus status so agents can orient in one read.
