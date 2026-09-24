---
title: 'Insight-first open-source reviewer - Plan'
type: feat
date: 2026-09-23
topic: insight-first-open-source-reviewer
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-brainstorm
execution: code
---

# Insight-first open-source reviewer - Plan

## Goal Capsule

- **Objective:** Give public and private engineering teams an open-source, self-hosted way to receive cheap, evidence-backed PR review with control over models, cost, data, and escalation.
- **Means:** Start with a GitHub-first code-review experience, a curated model default, and a local operator dashboard; make browser testing and Agent Zero deeper, budgeted opt-in lanes.
- **Product authority:** User-directed product thesis — control and insight at low per-usage cost, with heavier agentic work only when the team deliberately chooses it.
- **Execution profile:** Software work for both public and private repositories, with the public path optimized for immediate adoption.
- **Open blockers:** None. Cost calibration and the minimum private-team control set are planning decisions, not unresolved product direction.

## Product Contract

### Summary

Argus becomes the open-source alternative to hosted AI reviewers: install it through GitHub, add a BYOK provider key, and receive a useful code review on the next PR without hand-written model configuration. The default review is inexpensive and understandable; the GitHub experience and local dashboard expose evidence, confidence, model, cost, and run history, while heavier agentic testing is explicit and budgeted.

### Problem Frame

CodeRabbit and TestDriverAI have made AI-assisted review and application testing feel easy enough to buy. Their hosted products trade openness, control, and predictable ownership for convenience, per-seat pricing, and usage limits. Teams that want the same PR-native experience without surrendering their source, spend, or model choices are forced into brittle home-grown scripts or brittle browser tests.

Argus already has a differentiated foundation: vision-first flow testing, cache-first replay, BYOK OpenRouter calls, a code-review lane, evidence linkage, and a self-hosted action. The product gap is not another isolated model integration. It is the first-run and review experience around those capabilities. A new user needs a clear path from GitHub to a trustworthy review, a small set of good model choices, and a way to understand what happened and what it cost.

### Key Decisions

- **Insight-first reviewer** (session-settled: user-directed — chosen over a self-hosted control plane and agentic-QA-first product shapes; adoption and predictable cost come first).
- **Public default, private controls** (session-settled: user-directed — public repositories get the shortest path; private teams retain policy and budget control).
- **GitHub-first onboarding** (session-settled: user-directed — installation and the next PR review are the primary first-run experience).
- **Code review by default; deep agentic work by choice** (session-settled: user-directed — browser testing and Agent Zero are valuable but must not surprise teams with setup or spend).
- **One recommended model with optional overrides** (session-settled: user-directed — normal users should not need to understand provider catalogs).
- **GitHub-native review plus a local operator dashboard** (session-settled: user-directed — developers stay in the PR while operators get history, cost, live progress, and tuning).

### Requirements

#### Adoption and ownership

- R1. A public repository can reach its first code review through the GitHub-first path without hand-written model selection, an application target, or Docker setup.
- R2. A private or self-hosted team can use the same core review experience while retaining control over model choice, spend, trust boundaries, and retention of its own artifacts.
- R3. The first-run experience tells the user what will run, what data is sent to the model provider, what the default spend posture is, and how to change or stop it.
- R4. The product remains self-hosted and BYOK-first; a managed Argus hosting service is not required for the core promise.

#### Review value and insight

- R5. Every actionable finding communicates its location, severity, rationale, evidence or confidence, reviewing model, and cost contribution.
- R6. The review summary separates actionable findings from low-confidence observations and gives the user a clear verdict rather than an undifferentiated stream of suggestions.
- R7. A developer can understand the review in GitHub without leaving the pull request; an operator can inspect run history, live progress, cost, and model selection in the local dashboard.
- R8. The local dashboard is a first-class local product surface, not a hidden diagnostic view, and answers “what ran, why did it find that, which model was used, and what did it cost?” without requiring the user to read raw artifacts first.

#### Models, cost, and escalation

- R9. New users can accept one curated default model and complete a review without choosing a provider or model slug.
- R10. Users who want control can override the default for review, vision, or escalation without losing the standard review experience.
- R11. The product shows the actual cost of each review and keeps ordinary review spend separate from heavier agentic lanes.
- R12. Browser testing, actual application-flow execution, exploratory QA, and Agent Zero work are opt-in, clearly labeled as deeper or more expensive work, and cannot silently escalate spend.
- R13. A team can set a spend boundary or stop condition before enabling a deep lane, and the resulting behavior is visible in the review surface.

#### Trust and quality

- R14. Public and private execution paths make their trust posture clear, and unsafe or unavailable setup fails visibly rather than producing a confident-looking empty review.
- R15. Findings and execution evidence are tied to the intended pull-request change, so a merge checkout or unrelated branch state cannot be mistaken for proof about the PR head.
- R16. The default review path is reliable enough to dogfood on Argus’s own pull requests; failures and degraded modes are visible rather than hidden behind a pass.
- R17. A team can inspect the underlying evidence for a finding without exposing secrets or relying on an opaque vendor dashboard.
- R18. A team can run a real application flow against a configured target, then explicitly escalate unresolved runtime work to Agent Zero when a remote host is available.

### Actors

- A1. Public maintainer: Wants a low-friction review for an open repository and accepts sensible defaults.
- A2. Private-team owner: Wants self-hosting, provider choice, spend boundaries, and control over repository data.
- A3. Reviewer or operator: Uses the PR output or local dashboard to decide what to trust, rerun, or tune.
- A4. Deep-lane operator: Deliberately enables browser testing, exploratory QA, or Agent Zero when the extra evidence justifies its cost.

### Key Flows

- F1. Public first review
  - **Trigger:** A maintainer installs the GitHub integration and adds the provider key.
  - **Actors:** A1, A3.
  - **Steps:** The next pull request receives the default review; the maintainer reads the summary and evidence in GitHub.
  - **Outcome:** A useful review exists without hand-written model configuration or application setup.
  - **Covers:** R1, R3, R5, R6, R9, R14.

- F2. Private team control
  - **Trigger:** A private-team owner enables the same review with self-hosted credentials.
  - **Actors:** A2, A3.
  - **Steps:** The team retains the default review, then changes model, budget, or trust settings only where needed.
  - **Outcome:** The team gets the shared experience without surrendering ownership or cost visibility.
  - **Covers:** R2, R4, R10, R11, R13, R17.

- F3. Operator inspection
  - **Trigger:** A reviewer wants to understand a completed or running review.
  - **Actors:** A3.
  - **Steps:** The operator checks GitHub for the decision and local dashboard for history, evidence, model, and cost.
  - **Outcome:** The operator can decide whether to trust, rerun, or adjust the review.
  - **Covers:** R5, R7, R8, R11, R16.

- F4. Deliberate deep QA
  - **Trigger:** An operator chooses a deep lane because a suspected defect needs runtime evidence.
  - **Actors:** A4, A3.
  - **Steps:** The operator sees the expected scope and spend, enables the lane, and reviews its evidence separately from ordinary review cost.
  - **Outcome:** The team gains deeper evidence without surprise escalation.
  - **Covers:** R12, R13, R15.

- F5. Application execution and remote escalation
  - **Trigger:** A team has a reachable application target and wants runtime evidence beyond a recorded local flow.
  - **Actors:** A3, A4.
  - **Steps:** The product loads the target, executes the configured flow, records the result and cost, and offers Agent Zero as an explicit escalation when local evidence is insufficient.
  - **Outcome:** The team can distinguish a real application failure from a stale expectation without making Agent Zero a prerequisite.
  - **Covers:** R12, R13, R15, R18.

### Acceptance Examples

- AE1. A public repository with no application URL and no Docker runner receives a code review on its first pull request after adding the provider key. The review names the default model, shows its cost, and links actionable findings. **Covers:** R1, R5, R9, R11.
- AE2. A public maintainer opens the review summary and can understand each finding’s evidence, confidence, and suggested action without opening raw JSON or a provider dashboard. **Covers:** R6, R7, R17.
- AE3. A private-team owner changes the model and budget while keeping the GitHub-first review path, then sees the change reflected in the next run’s cost and report. **Covers:** R2, R10, R11.
- AE4. An operator enables an Agent Zero or browser-testing lane without setting a spend boundary. The product does not start unbounded work; it asks for an explicit decision or stops with a visible reason. **Covers:** R12, R13.
- AE5. A review is triggered from a pull request whose checkout differs from the intended PR head. The resulting evidence is marked inconclusive or attached to the correct head rather than reported as proof about the wrong code. **Covers:** R14, R15, R16.
- AE6. A provider or configuration failure occurs. The review surface names the failure and next action; it does not present an empty or fabricated pass. **Covers:** R14, R16.
- AE7. A reachable application target is configured for a deep run. Local execution produces a durable result and cost record; if the operator selects Agent Zero, the remote connection is checked before delegation and unavailable or over-budget work stops visibly. **Covers:** R12, R13, R18.

### Success Criteria

- A new public repository can reach a first review without hand-written model slugs, a target URL, or Docker setup.
- The default review is visibly cheaper than the opt-in deep lanes, and actual per-run cost is available to the user.
- A reviewer can answer what ran, why a finding exists, which model produced it, and what it cost from the normal product surfaces.
- Deep agentic work never begins without an explicit user decision and a visible spend boundary.
- Argus’s own pull requests demonstrate the complete default experience, including a clean install path and a trustworthy review surface.

### Scope Boundaries

#### Deferred to follow-up work

- A full hosted team control plane with organization analytics, centralized policy management, and multi-repository administration.
- Full feature parity with CodeRabbit’s broader workflow actions or TestDriverAI’s hosted desktop and device coverage.
- An arbitrary model/provider marketplace as the primary onboarding experience.
- Automatic Agent Zero or exploratory execution on every pull request.
- Mobile and desktop testing parity as a default product promise.
- Team-wide hosted review history beyond the self-hosted local dashboard.

#### Outside this product’s identity

- Managed cloud hosting as a requirement for ordinary use.
- Per-seat SaaS billing as the default business model.
- Selector-based test authoring as the primary testing experience.
- A hosted dashboard that becomes the only way to understand a review.

### Dependencies and Assumptions

- Argus remains BYOK-first and assumes access to a supported model provider and a GitHub repository context.
- The GitHub integration remains the primary distribution surface for the first-run experience.
- The local dashboard is a first-class local operator deliverable, not a required hosted service.
- Existing vision testing, review evidence, sandbox probes, and Agent Zero capabilities remain available as the basis for deeper opt-in lanes.
- Application flows require a reachable target and a browser-capable runner; remote Agent Zero additionally requires a reachable `a0` host and is never a default dependency.
- The current repository audit findings are release prerequisites for making this product promise credible; they are not separate product positioning.

### Outstanding Questions

#### Resolve Before Planning

- None. The product direction is sufficiently settled to plan.

#### Deferred to Planning

- What cost envelope and budget defaults demonstrate “cheap” for an ordinary review across representative repositories.
- Which private-team controls are required in the first release versus documented as advanced configuration.
- How the dashboard presents run retention and history without turning into a hosted analytics product.
- Which deep-lane triggers and warnings provide useful guidance without encouraging surprise spend.
- How the curated model catalog is verified and refreshed as provider catalogs change.

### Sources and Research

- `STRATEGY.md:3-55` — self-hosted/BYOK users, two-lane product shape, cost and adoption metrics, and explicit non-goals.
- `docs/plans/2026-09-16-001-feat-full-reviewer-roadmap-plan.md:12-23` — existing “full-feature reviewer” framing, super-easy onboarding, tested-model list, and TestDriverAI comparison.
- `docs/plans/2026-09-16-001-feat-full-reviewer-roadmap-plan.md:49-70` — existing requirements for trust, review lenses, model choice, regression tests, exploration, and mention-driven review.
- `docs/plans/2026-09-16-001-feat-full-reviewer-roadmap-plan.md:392-432` — existing scope boundaries and risk posture.
- `docs/quickstart.md:3-84` — current install, configuration, record, run, and GitHub Action setup surface.
- `action/action.yml:1-169` — current GitHub inputs, review/run lanes, and sticky PR output.
- `scripts/watch.mjs:1-180` and `electron/main.mjs:1-147` — existing local operator surfaces and live-run observability.
- `https://www.coderabbit.ai/pricing` — CodeRabbit’s current paid per-developer model and feature tiers.
- `https://docs.coderabbit.ai/management/plans` — CodeRabbit’s current OSS/free access, review limits, and paid feature boundaries.
- `https://testdriver.ai/pricing/` — TestDriver’s current per-seat and hosted/self-hosted pricing surfaces.
- `https://testdriver.ai/` — TestDriver’s current promise of running the app, generating tests, self-healing, and PR-native evidence.
- `https://docs.testdriver.ai/v7/quickstart` — TestDriver’s current low-setup GitHub/MCP onboarding shape.
