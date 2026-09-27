---
title: "feat: CodeRabbit-style review surface — suggestion blocks, gated REQUEST_CHANGES, A0 parity"
date: 2026-09-27
type: feat
status: draft
---

# feat: CodeRabbit-style review surface

## Summary

Make Argus findings land like CodeRabbit's: one batched PR review with per-line comments that carry committable ```` ```suggestion ```` blocks, the review event escalating to `REQUEST_CHANGES` only for proven blockers (sandbox-reproduced, Jev high-confidence, or secrets-adjudicated), stale bot reviews dismissed on repost, a scannability pass on the sticky summary, and the same review surface in the Agent Zero plugin — thin, because all render policy is serialized into `code-review.json` and posters only dedup and POST.

**Target repos:** `Argus` (this repo) and `a0-plugin-argus` (sibling repo; paths under `**Target repo: a0-plugin-argus**` in U6 are relative to that repo's root).

---

## Problem Frame

Argus already posts a sticky comment, a commit status, and one batched `COMMENT` review of bug/risk findings (`action/sticky-comment.cjs:425-499`). What's missing vs. the CodeRabbit bar:

- Findings carry `message` but no fix patch — nothing is one-click committable.
- The review is always advisory (`event: 'COMMENT'`); nothing behaves like a reviewer — and once `REQUEST_CHANGES` exists, the poster must also *dismiss* its stale reviews or a fixed PR stays blocked forever.
- nit/q severities are table-only; the thread misses the CodeRabbit density.
- The A0-plugin lane (what actually reviews kurultai/dayflow/Pace-Server PRs) posts sticky-only.

Settled in brainstorm: all severities go inline; `REQUEST_CHANGES` only for *proven* blockers, never APPROVE; plugin parity included.

---

## Requirements

- R1. Findings may carry model-emitted `suggestion` (replacement lines) plus optional `startLine`; inline comments render it as a GitHub ```` ```suggestion ```` block. Replaced span bounded: `line - startLine ≤ 25`; suggestion body ≤ 2000 chars; both enforced at parse.
- R2. All severities (`bug`, `risk`, `nit`, `q`) post inline; severity-sorted (bug>risk>nit>q) before the `maxComments` cap so nits can't crowd out bugs.
- R3. `code-review.json` carries `reviewEvent` computed deterministically post-pipeline: `'request_changes'` iff ≥1 blocker-severity finding is proven — `evidence.status === 'reproduced'`, or `p ≥ threshold`, or a secrets-lane finding Jev-adjudicated live — and `review.requestChanges !== false`; else `'comment'`. Report splits the counts honestly: `provenBlockers` (reproduced) vs `highConfidenceBlockers` (p/secrets-adjudicated). Posters read the field, never recompute.
- R4. Graceful degradation on post: `REQUEST_CHANGES` failure (own-PR, 403/422) → retry once as `COMMENT` with a downgrade note **in the review body**; 422 on comments → drop comments whose lines aren't in the PR diff and retry once. Never a per-comment posting loop; at most three `createReview` calls per run.
- R5. Sanitization is single-sourced in the CLI: `suggestion` gets fence-escape (fence = longest backtick/tilde run + 1) and caps; `message`/`evidence.detail` get newline-collapse, code-fence neutralization, `@`-mention escaping, and length bound — the message is equally model-controlled and can smuggle a fake ```` ```suggestion ```` block past every suggestion-side guard.
- R6. Sticky top block under the sentinel: verdict icon + one-line summary + counts line distinguishing `⛔ n reproduced` from `◎ n high-confidence` — never lumping p-only findings under "proven" (STRATEGY.md's moat is *reproduced* findings; the copy must be literally true).
- R7. A0 plugin posts the same batched review — but as a thin consumer of the serialized `reviewComments[]` (dedup + diff-validate + POST + event + dismiss-stale), not a re-implementation of render policy. Requires `pull-requests: write` — documented scope bump.
- R8. Inline eligibility: real repo path, `line > 0`, and **pre-validated against the live PR diff** (`pulls.listFiles` hunks, RIGHT-side lines only) before posting — fixes the `{file:'-', line:0}` secrets-overflow hazard and makes out-of-diff 422s rare rather than routine.
- R9. Freshness gate: posters verify `codeReview.headBinding.intendedSha === pr.head.sha` before posting a review; mismatch → sticky-only + warning. A planted or stale `code-review.json` in the workspace must not produce committable suggestions or `REQUEST_CHANGES`.
- R10. Dedup key = `path:line:bodyFirstLine:hash8(suggestion)` — a re-run with a *corrected* suggestion re-posts rather than leaving stale one-click-committable code.
- R11. `review.requestChanges` config key (default `true`) — the advisory-only escape hatch; serialized into the gate at compute time.

---

## Key Technical Decisions

- **KTD1 — Suggestion lives on the finding; regenerated patches are dropped.** `CODE_REVIEW_SCHEMA` gains optional `suggestion` + `startLine`. Prompt contract: replacement lines for the commented range only, no diff markers, no fences, RIGHT-side lines only. Post-synthesis, `suggestion`/`startLine` are re-attached to surviving findings by `file`+`line`+normalized-`message` match; synthesized findings with no pre-image have both fields **dropped** — synthesis output is ungrounded model text and is never trusted as committable code.
- **KTD2 — The gate is pure, serialized, and honest about proof.** `computeReviewEvent(linkedFindings, blockSeverities, allowRequestChanges)` is an exported pure function tested against a p/evidence/severity matrix. It runs at report assembly on `linkedFindings` (which carries both `p` and `evidence` post-probe). Secrets union (`cli.ts:1547`) happens after adjudication, so the secrets lane's adjudicated verdict is carried onto the finding as `p` at union time — a Jev-confirmed live secret counts as proven. Unadjudicated blockers (Jev absent/failed/overflow) never escalate — degrade-open by design, stated in docs. `0.7` is a named constant aligned with adjudication semantics at implementation (it is P(true-positive), a different axis from `findingThreshold`'s P(false-positive) — do not reuse that knob).
- **KTD3 — The CLI pre-renders `reviewComments[]`; posters are dumb.** `code-review.json` gains `reviewComments[]`: `{path, line, start_line?, side, body, dedupKey}` — already eligibility-filtered (R8's static parts), severity-sorted, capped at `maxComments` (overflow count serialized), message-sanitized, suggestion-fenced, with `dedupKey` per R10. Both posters shrink to: fetch `listReviewComments` + `listFiles`, dedup on `dedupKey`, drop comments whose anchor isn't a RIGHT-side diff line (R8's live-diff part lives in the poster because the diff is authoritative only at post time), `createReview`, handle event downgrade. One implementation of hostile-input handling; the Python lane cannot drift.
- **KTD4 — Retry ladder is bounded and ordered.** Attempts, in order: (1) post as `reviewEvent`; on 403/422-event failure (2) retry `COMMENT` with downgrade note in body; on 422-comment failure after diff pre-validation (3) drop all comments failing diff membership, retry once. Then warn and stop. The sticky's "+N not posted" note reflects dropped comments.
- **KTD5 — Stale `REQUEST_CHANGES` is dismissed.** Before posting, list the PR's reviews, find prior `CHANGES_REQUESTED`/`PENDING` reviews authored by the token user, and `dismissReview` them — a fixed PR must not stay gated by an obsolete bot review (CodeRabbit-equivalent behavior). Applies to action and plugin alike.
- **KTD6 — Report authenticity is checked at post time.** `headBinding.intendedSha` already lands in the report; the poster refuses the review surface when it doesn't match `pr.head.sha` (sticky still posts — it renders status text, not committable code). The robust fix (report dir outside the checkout) is noted as follow-up; the SHA check kills stale-report replay cheaply today.
- **KTD7 — `review.requestChanges` config ships in v1.** One resolver + one serialized field — the trust-safety story for first-impression adopters: a false-positive escalation is a config flip, not a churn event.

---

## Scope Boundaries

- No APPROVE events — the bot never self-approves; clean PR gets `COMMENT` + passing status.
- Bounded retry ladder only (KTD4) — no per-comment `createReviewComment` fallback loop.
- Sticky scannability is a top-block addition, not a renderer rewrite.
- No GitLab/GHE work.

### Deferred to Follow-Up Work

- Check Runs per lane (`checks: write` already granted).
- Probe-*verified* suggestions (sandbox applies the patch and re-tests) — the differentiated version; v1 suggestions are unverified-by-design, disclaimer is the mitigation.
- Report dir outside the checkout (`RUNNER_TEMP`/mkdtemp) — the robust version of KTD6.
- Applying `suggestion` to the vision-lane output.

---

## Implementation Units

### U1. Finding schema gains `suggestion`/`startLine`, bounds enforced

**Goal:** The code-review model can emit a committable patch per finding, carried intact through the pipeline.
**Requirements:** R1, R5 (parse bounds), KTD1
**Files:** `src/cli.ts` (`CODE_REVIEW_SCHEMA` ~:826-853, `buildCodeReviewMessages` ~:1010-1037, synthesis carry-forward ~:1039-1066, `parseCodeReview` ~:1085-1129, `CodeReviewReport` finding type ~:866-875), `tests/unit/review-policy.test.ts`, `tests/unit/fixture.test.ts`
**Approach:** Optional schema fields — `required` untouched. Prompt: `suggestion` = replacement lines for the commented range only, RIGHT-side lines only, omit when no clean patch exists. `parseCodeReview` bounds: non-string/>2000-char suggestion → drop; `startLine` must be integer ≥1 and `line - startLine ≤ 25`, else both dropped. Synthesis carry-forward: match surviving findings to pre-synthesis originals on `file`+`line`+normalized `message`; matched → restore original `suggestion`/`startLine` verbatim; **no pre-image → drop the synthesized copy** (KTD1 resolution).
**Test scenarios:**
- Schema output with `suggestion`+`startLine` round-trips into `code-review.json` (fixture + StubClient).
- Rejects: non-string suggestion, >2000 chars, `startLine` negative, `line - startLine > 25` (both fields dropped, finding kept).
- Synthesis: deduplicated subset regains original suggestion verbatim; **synthesized-only finding loses its emitted suggestion**.
- Field fully optional — findings without it unchanged.
**Verification:** unit tests green; `code-review --fixture` report carries the field.

### U2. Report contract: gate fields + pre-rendered `reviewComments[]`

**Goal:** `code-review.json` becomes the single source of truth for both posters.
**Requirements:** R2, R3, R5, R8 (static eligibility), R10, R11, KTD2, KTD3
**Dependencies:** U1
**Files:** `src/cli.ts` (new `computeReviewEvent` + `renderReviewComments` helpers — extract as pure functions; report assembly ~:1636-1656; secrets union ~:1547), `src/review/secrets.ts` (carry adjudicated `pLive`→`p` at union), `src/config.ts` (`review.requestChanges` resolver, `review.*` is not on `UNTRUSTED_CONFIG_KEYS` — fork configs can't touch it), `tests/unit/review-policy.test.ts`
**Approach:**
- `computeReviewEvent(linkedFindings, blockSeverities, allowRequestChanges)`: proven = `evidence.status==='reproduced'` OR `p >= P_THRESHOLD` (named constant, chosen against adjudicate.ts semantics). Returns `{reviewEvent, provenBlockers, highConfidenceBlockers}` — `provenBlockers` counts reproduced only; `highConfidenceBlockers` counts p/secrets-adjudicated; `reviewEvent` fires on the union when `allowRequestChanges`.
- `renderReviewComments(findings, maxComments)`: eligibility (`file` real ≠ `'-'`, `line` int >0), stable severity sort, cap with serialized overflow count, sanitized body (newline-collapse, fence-neutralize, `@`-escape, length bound), suggestion fence (longest-run+1, `suggestion` fence type), disclaimer line on suggestion-bearing comments, `dedupKey` per R10.
- Secrets lane: at union, an adjudicated secrets finding carries its `pLive` onto `p`.
- Report gains `reviewEvent`, `provenBlockers`, `highConfidenceBlockers`, `reviewComments[]`, `commentsOverflow`.
**Test scenarios:**
- Gate matrix: `p:0.9`+bug → request_changes; `p:0.4` → comment; reproduced w/o p → request_changes; off-gate severity w/ p:1.0 → comment; `requestChanges:false` → always comment; unadjudicated bug (no p) → comment; secrets finding with carried `p:0.9` → request_changes.
- Render: >cap mixed severities keep all bugs inline (severity sort); `file:'-'`/line 0 excluded; suggestion containing ```` ```` ```` line → 5-backtick fence; message with ``` + `@user` + newlines → neutralized single-paragraph body.
- `dedupKey` differs when only `suggestion` changes.
**Verification:** pure-function unit tests cover the matrix; report schema assertions updated.

### U3. Action poster — dedup, diff-validate, event, downgrade, dismiss, freshness

**Goal:** `action/sticky-comment.cjs` posts a CodeRabbit-grade review from serialized comments.
**Requirements:** R3, R4, R8, R9, R10, KTD3-KTD6
**Dependencies:** U2
**Files:** `action/sticky-comment.cjs` (`planInlineComments`/`postInlineComments` rewritten ~:425-499, `main()` ordering ~:501-598), `tests/unit/action-contract.test.ts` (new mocked-runtime tests via `run(runtime)` seam)
**Approach:**
- Freshness: `codeReview.headBinding?.intendedSha !== pr.head.sha` → skip review posting entirely, warn, sticky still posts.
- Dedup: paginated `listReviewComments`, scoped to head SHA, key on `dedupKey` (R10).
- Diff validation: paginated `pulls.listFiles`, parse hunks, drop comments whose anchor isn't a RIGHT-side diff line; drops counted into the sticky overflow note.
- Post: one `createReview` `{commit_id, event, body, comments}`; body carries verdict line + downgrade note on retry.
- Retry ladder per KTD4; dismissal of prior bot `CHANGES_REQUESTED` reviews per KTD5 **before** posting.
- `planInlineComments` deletes its eligibility/body-build code — replaced by consuming `reviewComments[]`.
**Test scenarios:**
- Mocked github runtime: single `createReview` with serialized comments; `event:'REQUEST_CHANGES'` when report says so.
- headBinding mismatch → no review call, warning logged.
- Own-PR failure → COMMENT retry with note in body.
- Prior `CHANGES_REQUESTED` by same bot → `dismissReview` called before new post.
- Off-diff comment dropped pre-post; 422 → drop-and-retry once.
- Old-format report (no `reviewComments`) → poster falls back to sticky+status only, no crash.
**Verification:** new unit tests + existing contract suite green.

### U4. Sticky top block — scannable summary

**Goal:** First screen answers "verdict, what kinds, what needs me."
**Requirements:** R6
**Dependencies:** U2 (counts fields)
**Files:** `action/sticky-comment.cjs` (`renderBody`, `pushCodeReviewDetails` ~:248-363), `tests/unit/action-contract.test.ts`
**Approach:** Fixed block under sentinel: verdict icon + one-line summary + counts — `🐛 n · ⚠️ n · 💡 n · ❓ n — 🔧 n suggestions · ⛔ n reproduced · ◎ n high-confidence`. `⛔` counts reproduced only (R6 honesty); `◎` omitted at 0. Existing `<details>` below unchanged; overflow note reflects post-validation drops.
**Test scenarios:** counts line precedes first `<details>`; zero-finding render; reproduced vs p-only counted separately.
**Verification:** renderer tests assert content and order.

### U5. Config knob + docs

**Goal:** `review.requestChanges` documented; shipped behavior matches docs.
**Requirements:** R11; docs for R3-R6, R9
**Dependencies:** U2
**Files:** `src/config.ts` (resolver, done in U2 — this unit is docs), `docs/quickstart.md` (review-policy block ~:205-249), `README.md` ("What lands on your PR")
**Approach:** quickstart: review-surface paragraph — all-severity inline comments, committable suggestions, the proven→request-changes rule with the three legs defined and the `requestChanges: false` escape hatch, downgrade/freshness behavior, and the stated dependency: without Jev or the probe lane, escalation can't fire (unadjudicated = advisory). README gains suggestion-block + request-changes + stale-dismissal bullets.
**Test expectation:** none — docs-only.
**Verification:** no drift between docs and shipped behavior.

### U6. A0 plugin parity — thin review poster

**Goal:** `a0-plugin-argus` posts the serialized review; pin bumps to the release carrying U1/U2.
**Requirements:** R3, R4, R7, R8, R9, R10, KTD3-KTD6
**Dependencies:** U2, U3; **release ordering** — the `argus_version_pin` bump lands in this PR but only takes effect once an Argus release with U1/U2 is published; missing `reviewComments`/`reviewEvent` must degrade to sticky-only/`COMMENT`.
**Target repo: a0-plugin-argus**
**Files:** `helpers/argus.py` (`preflight_pr` returns payload incl. `head.sha`; new `list_review_comments` + `list_pr_files` paginators; `post_review`; `_raise_post_error` scope text), `tools/argus_review.py` (call `post_review` after `post_sticky` when `post`), `default_config.yaml` (pin bump), `tests/test_post.py`, `tests/test_tools.py`, `docs/ONBOARDING.md`, `README.md`
**Approach:** `post_review(report, pr, token)`: freshness check (R9), paginated dedup on `dedupKey`, `list_pr_files` diff-membership filter, one `POST /pulls/{n}/reviews` with `event` from `reviewEvent`, downgrade ladder per KTD4, dismiss stale own reviews per KTD5. No render logic — consumes `reviewComments[]` verbatim; absent/empty → skip. Scope note: `pull-requests: write` (classic `repo` covers); ONBOARDING + error text updated to say the token can post blocking reviews. Pin bump rides with its test-assertion updates per repo rule ("bump deliberately, with the test change").
**Test scenarios:**
- `FakeGH`: one POST with serialized comments + event; dedup skips head-SHA matches; off-diff anchors dropped.
- `request_changes` → event; failure → COMMENT downgrade; stale own review → dismiss called.
- Report missing `reviewComments` → no POST, sticky still posts (old-pin compat).
- Missing `head.sha` → skip review, sticky posts.
**Verification:** `pytest` green; offline-only per AGENTS.md.

### U7. Deploy + live verification + demo capture

**Goal:** New surface verified on a real PR; the screenshot-able artifact captured for track 1.
**Requirements:** all
**Dependencies:** U3, U4, U6 + published Argus release
**Files:** watcher/plugin configs on server-001 (no repo files)
**Approach:** Pull plugin main on server-001, restart A0, next qualifying PR head triggers review. Inspect on kurultai/Pace-Server: inline comments + apply affordance + honest counts + event matches report. **Capture the demo asset** — screenshot/clip of suggestion block + gated REQUEST_CHANGES + sticky top block → land in README (STRATEGY.md track 1: "seen working").
**Test expectation:** none — live verification.
**Verification:** real PR shows the new review shape; no new error classes in watch.log.

---

## High-Level Technical Design

```mermaid
flowchart LR
    subgraph CLI[code-review pipeline — all render policy]
        A[chunks → findings w/ suggestion] --> B[synthesis → carry-forward by match; no pre-image → drop]
        B --> C[Jev → p · secrets → pLive→p · probes → evidence.status]
        C --> D[computeReviewEvent + renderReviewComments — sanitized, sorted, capped, keyed]
        D --> G[code-review.json: reviewEvent, counts, reviewComments[]]
    end
    subgraph POST[dumb posters]
        G --> H[action: freshness → dismiss stale → dedup → diff-validate → createReview + retry ladder]
        G --> I[plugin: same shape via _gh]
        H --> J[sticky + status]
        I --> K[sticky]
    end
```

Gate expression (serialized, never re-derived):

```text
proven   = f.evidence.status == 'reproduced'
confidnt = f.p >= P_THRESHOLD            # includes secrets-adjudicated pLive→p
reviewEvent = (any blocker-severity f where proven or confidnt)
              and allowRequestChanges ? 'request_changes' : 'comment'
```

---

## Risks & Dependencies

- **Plausible-but-wrong committable suggestions** — unverified by design in v1; bounded (2k chars, ≤25-line span, disclaimer). Same exposure class as CodeRabbit; the differentiated fix (probe-verified suggestions) is deferred.
- **Hostile-input surface is real** — mitigations: single-sourced sanitization (R5), span cap (R1), freshness gate (R9), no-pre-image drop (KTD1). Residual: a hostile PR can at most steer comments/review-events on *its own* PR.
- **Stale-request dismissal** — new in v1 (KTD5); without it the headline feature becomes a merge footgun.
- **Own-PR / fork-PR / read-only token cases** — `REQUEST_CHANGES` structurally unreachable when the token authored the PR or on fork `pull_request` events; downgrade ladder covers both; forks get sticky-only (status quo).
- **Escalation depends on the lanes that ran** — no Jev (model off, outage, `MAX_CANDIDATES` overflow) + no probes → every blocker is unadjudicated → `COMMENT`. Degrade-open by design; docs state it plainly.
- **`p` calibration unmeasured** — if real true-positives cluster below the threshold, `REQUEST_CHANGES` rarely fires; dogfood data tunes the constant.
- **Plugin scope bump** — `pull-requests: write` widens the token's blast radius; documented in ONBOARDING.
- **Cross-repo sequencing** — U6's PR lands after an Argus release carries U1/U2; until the pin bumps, missing fields degrade to sticky-only/`COMMENT` (tested).

## Sources & Research

- Grounding: `docs/plans/2026-09-17-001-feat-trust-jev-demo-tranche-plan.md` (review-bot hygiene), `docs/plans/2026-09-18-2143-feat-a0-plugin-v01-plan.md` (posting hardening; sticky-only KTD this plan reverses), `docs/brainstorms/2026-09-23-insight-first-open-source-review-requirements.md` (CodeRabbit positioning), STRATEGY.md (reproduced-not-suspected moat)
- GitHub REST: `POST /pulls/{n}/reviews` — batched `comments[]` with `line`/`side`/`start_line`/`start_side`; `REQUEST_CHANGES` requires `body`; `dismissReview` for stale reviews
- Review findings consolidated: coherence/feasibility/security/adversarial/product/scope doc-review pass (6 personas) — KTD1↔U1 contradiction resolved (drop no-pre-image), stale-dismissal added, message sanitization added, report-freshness gate added, span cap added, honest proven/confidence split, pre-rendered comments adopted
