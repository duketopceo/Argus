---
title: "feat: Argus mobile lane — ARTEMIS research and roadmap proposal"
type: feat
date: 2026-09-21
origin: docs/plans/2026-09-14-006-feat-post-launch-roadmap-plan.md
status: research / proposal (no code in this PR)
---

# feat: Argus mobile lane — ARTEMIS research and roadmap proposal

## Summary

Argus today has two lanes against one PR surface: a **vision lane** (record a
flow in plain English, vision model grounds each step, replay is cache-first and
heals only where the UI drifted) and a **code lane** (diff-aware findings plus a
merge-gating verdict). Both lanes are **web-shaped**.

`google/artemis` is Google's open-source Android automation agent and looks like
the missing second surface: natural-language instructions → reliable Android
automation, log capture, MCP server, 99%+ claimed on AndroidWorld. This document
records the research, states the case for an **Argus mobile lane** built on
ARTEMIS rather than on a homegrown driver, and proposes a staged roadmap. It
ships no code: the deliverable is a decision-ready plan.

## What ARTEMIS is (verified 2026-09-21)

| Property | Value |
| --- | --- |
| Repo | `github.com/google/artemis` (Apache-2.0) |
| Owner | Google — Pixel Test Engineering team |
| Provenance | Includes source from Minitap, Inc. (`minitap-ai/mobile-use`) |
| Traction | 8.6k stars, 829 forks, 119 commits, active through 2026-09-12 |
| Claim | 99%+ success on the AndroidWorld benchmark |
| Surfaces | Python package (`packages/artemis-client`), `mcp_server/`, `apps/`, playground |
| Integrations | Antigravity, Codex, Claude Code (IDE-chat dispatch) |
| Core ideas | Two-gate checker settlement, execution incidents, action bursts, structured LLM reliability, verification-first execution |
| Roadmap | Android Studio plugin; **iOS expansion**; **on-device lightweight VLMs**; **real-time duplex voice** |

Two of those roadmap items are worth naming explicitly because Argus already
holds opinions about them:

- **Verification-first execution** ("two-gate checker settlement") is the same
  posture as Argus's evidence ladder (`not_exercised` → probe → `reproduced`).
  ARTEMIS verifies on the device; Argus verifies in CI/code. Same standard,
  different surface.
- **On-device lightweight VLMs** matches Argus's cost discipline (replay must be
  ~free on an unchanged UI). A local perception model is the mobile analogue of
  the replay cache.

## Why this belongs in Argus

1. **The product claim generalizes.** Argus's promise is "your E2E surface is
   expensive and brittle; we make it cheap, reviewable, and honest." That claim
   is surface-agnostic. Leaving mobile out means every mobile-heavy team is
   half-served — and mobile E2E is *more* brittle than web E2E, not less.
2. **Don't build the driver.** ARTEMIS is Apache-2.0, Google-maintained, already
   has the device-perception and action-execution hard parts (accessibility
   tree + UIAutomator fallback, managed accessibility helper), and is
   MCP-shaped — which is the integration seam Argus's agentic lanes already
   speak. Writing an Android driver is months of work to reach parity with a
   repo we can vendor or call.
3. **Evidence story is reusable.** Findings that are *reproduced on a real
   device* beat findings that are *argued from a diff*. That is the existing
   execution-backed moat; mobile just gives it another courtroom.
4. **Portfolio and positioning.** "Web + mobile E2E from one reviewer, BYOK,
   self-hosted" is a materially stronger position than "another PR bot."

## Proposed shape (not committed scope)

The mobile lane reuses the existing two-lane contract:

- **Record** a mobile flow in plain English ("open the app, create an account,
  change the setting, verify it stuck") — ARTEMIS turns it into actions.
- **Replay** cache-first, exactly as the vision lane does: an unchanged app
  version costs no model calls; drift heals only where the tree changed.
- **Evidence** lands in the same sticky PR comment: per-model dollars, test
  evidence, verdict, commit status — no second reporting surface.
- **Backend seam:** prefer ARTEMIS's **MCP server** as the execution backend
  behind an Argus interface, so Argus owns policy (trust, budgets, evidence)
  and ARTEMIS owns device mechanics. Vendor only if the MCP seam proves too
  coarse.

## Staged roadmap

- **M0 — Research (done, this PR).** Repo verified, seams identified, prior art
  read. No dependency added.
- **M1 — Spike, gated on demand.** Stand up ARTEMIS against a local Android
  emulator; run one recorded flow; answer the open questions below. Timeboxed;
  throwaway branch; success criterion is "one flow, evidence in a comment."
- **M2 — Backend adapter.** ARTEMIS's MCP server behind the Argus execution
  interface; cache/fingerprint semantics defined for app UI trees (not DOM).
- **M3 — Docs + onboarding.** A tested-model list and a quickstart exactly like
  the web lane's, plus an honest "what mobile covers / does not cover" page.
- **Explicitly gated:** cancel M2+ if no team asks for mobile. Argus's stated
  discipline is "scale & ops gated on observed external adoption" — mobile gets
  the same treatment.

## Open questions (M1 must answer)

1. **Determinism.** Can ARTEMIS flows replay without model calls on an
   unchanged build, the way Argus's web replay does? If not, mobile replay will
   be materially more expensive than web replay and must be priced differently.
2. **Emulator vs. real device in CI.** GitHub Actions runners have no Android
   device; emulator boot cost, KVM availability on hosted runners, and
   headless reliability are all unsettled.
3. **Fingerprints.** What is the stable identity of a mobile step? The web lane
   fingerprints DOM structure; the mobile equivalent (accessibility tree
   shape? resource ids? bounds?) needs defining before a cache is meaningful.
4. **License/vendoring hygiene.** ARTEMIS is Apache-2.0 and includes Minitap
   code — attributions and third-party notices must be carried if we vendor.
5. **iOS.** iOS is roadmap-only upstream and Argus's own need may be
   iOS-first. Decide whether the mobile lane is Android-only at launch and say
   so in the docs, rather than promising parity.

## Relationship to existing tracks

- **Does not touch** the execution-backed review moat, review packs, A0 depth,
  trust hardening, or the ops track. This is an additive lane proposal.
- **Shares** the vision lane's economics and the code lane's reporting surface.
- **Feeds** the same key metric ideas: cost per run, heal rate, findings posted
  vs. resolved.

## Out of scope (this PR)

- No dependency, no submodule, no vendored ARTEMIS code.
- No changes to the vision lane, code lane, or release pipeline.
- No iOS commitment.

## References

- `github.com/google/artemis` — README, roadmap, LICENSE (Apache-2.0)
- `minitap-ai/mobile-use` — upstream component
- `docs/plans/2026-09-14-006-feat-post-launch-roadmap-plan.md` — parent roadmap
- `STRATEGY.md` — target problem, users, key metrics (unchanged by this PR)
