# Competitive intake

The "keep bringing them in and testing them" loop: each sweep records a
competitor feature, the mechanism behind it, our closest equivalent, and an
adopt / adapt / skip verdict with the reason. Adoption is gated on the
eval harness (`scripts/review-eval.mjs`) — a candidate ships only when it
moves a measured number on the corpus, not because a competitor has it.

Emission variance is the confound: the live model emits different finding
counts on identical code (measured 3 vs 57 on one corpus item). A
single-run delta under ~0.5 precision is noise — adopt/reject needs ≥2
runs agreeing, or a provably-safe predicate where measurement isn't
required.

Cadence: monthly, or on a relevant release note. Sources: public docs,
release notes, the competitor's own repos. We adopt mechanisms, never copy
comment formats, branding, or code.

## Delta table

| Competitor | Feature / mechanism | Our equivalent | Verdict |
|---|---|---|---|
| CodeRabbit | Default ignored-paths table (~40 globs: `dist/`, lockfiles, generated, vendored) | `review.exclude` defaults (shipped) | **adopted** — our pin bug hid it; eval corpus shows `gen-path` comments at 0 post-fix |
| CodeRabbit | `path_instructions` per-glob | `review.instructions[]` | parity — already shipped |
| CodeRabbit | `@coderabbitai emit path instructions` — mines its own reviews into suggested config | nothing | **candidate** — U5 loop; needs acted-on vs dismissed data (U6 feedback tallies) first |
| CodeRabbit | Review profiles (CHILL/ASSERTIVE severity floors) | `review.severityGate` + `findingThreshold` | parity — shipped, underused |
| CodeRabbit | Walkthrough + changes-table sticky | lane table + findings line | partial — our sticky is evidence-first; a one-paragraph plain-language walkthrough is a **candidate** for the head |
| CodeRabbit | Per-seat + per-file overage pricing | spend ledger per review | differentiation — volume is a cost axis; nit consolidation is the defense |
| Alibaba OCR | Deterministic file selection + related-file bundling | none — each file reviewed solo | **candidate** — U4(c); deterministic adjacency rules only |
| Alibaba OCR | External positioning module (line numbers verified outside the model) | `diffLineRanges` anchor check exists | **adopt** — U4(a): verify every finding's line lands in a hunk pre-post; drop/downgrade + count |
| Alibaba OCR | Batched reflection pass on findings | none | **eval-gated** — U4(b); only if it lifts AACR precision without gutting recall |
| Alibaba OCR | Precision > recall posture, ~1/9 token discipline | stated posture (R2) | adopted as doctrine; spend ledger already measures it |
| Alibaba OCR | AACR-Bench (2,145 labeled comments) | `scripts/eval-corpus.aacr.json` | **adopted** — label=1 rows are our ground truth |
| PR-Agent (Qodo) | Command grammar `/review /improve /describe` on PR comments | `@argus review|fix` mention lane | parity — shipped; `/describe` equivalent (PR summary generation) is a **candidate** |
| PR-Agent | Open-source, provider-agnostic | our whole posture | aligned |
| Greptile | Full-repo graph context for every review | `argus-reviewer index` + repo index | parity direction; their always-on indexing is smoother — index freshness staleness is a known gap |
| cubic.dev | Inline + summary, quiet defaults | — | intake only |
| Copilot review | Native GH surface, zero config | action install | different league of distribution, not mechanism |
| TestDriver | Vision agent runs the app in sandboxes, generates committed tests | flow lane replay, `code-review --generate-tests` | closest on "runs code"; ours is review-evidence-first, theirs is test-generation-first |
| Cursor Bugbot | Auto-review in Cursor PRs | — | intake only; watch signal-to-noise reports |

## Pending evaluations

Every gate below inherits the variance rider above: a single run's delta
is a hypothesis, not evidence.

- [x] U4(a) positioning check — measured → **rejected**: `droppedUnanchored` fired twice across all 20 committed eval reports (1 finding each on pr126, pr173); `validation.dropped` twice more. The `filterToDiffLines` anchor check already catches the rare bad position; a downgrade+count mechanism has ~2-finding headroom over the whole corpus. Existing check suffices.
- [ ] U4(b) reflection pass — measure precision delta on `eval-corpus.aacr.json` before adopting
- [ ] U4(c) deterministic bundling — measure recall lift on multi-file PRs
- [ ] Walkthrough paragraph in sticky head — measure against comment-count goals (must not add noise)
- [ ] `emit path instructions`-style config mining — blocked on U6 feedback data
- [x] Meta-diff cross-reference suppression — measured FP class on `clean-175-release-prep` (5 blockers p .66–.78 claiming changelog-referenced files absent from diff; silent on re-run, stochastic). Gate passed: post-line run zeroed the class (5 blockers → 4 p≈.15 jargon nits), clean corpus 4/5 silent with zero effective blockers, AACR label hits 7→5 with +2 gained on es-123744 — within demonstrated run-to-run variance.
- [x] Confidence floor on blocking severities — shipped as `review.confidenceFloor` (default 0.7 = the existing request-changes TP gate). Sweep on the 10-entry AACR corpus (findings carry adjudicated `p`): blocking precision 0.86 raw → 1.00 at any floor in [0.5, 0.7] (5/5 TP, 0 FP), label-hits 10→9. Below-floor bug/risk still post with `p` shown — they stop driving `verdict`/`ok`, matching what `reviewEvent` already did. Reproduced evidence and unadjudicated findings (rules lane, outage) always gate.
- [x] Clean-PR silence eval — shipped as `clean: true` corpus rows (scripts/eval-corpus.clean.json, 3 verified-clean Argus PRs: dependabot bump, action pin, release prep). Metrics: `blockingFindings`/`flooredBlockers`/`blockingVerdict` + a stalled-aware "clean rows: N silent" summary. First runs (deepseek-v4-flash): every completed review silent — 0 blocking findings, 0 blocking verdicts, 1 nit posted on the workflow-bump row. Provider timeouts (~1/3 of runs) are stalls, excluded from the silence count. Large-diff rows added 2026-10-10: a 54-file tsc-verified mechanical rename (synthetic, `eval-fixtures/large-clean`) stayed blocking-silent across 2 runs — 0 blockers, only p~0.3 "verify move" nits (correct uncertainty shape); a 28-file docs+renders wisp PR stalled twice (provider timeout). The dogfood ~0.06 precision does not reproduce on a genuinely-clean large diff. New measured FP class: **changelog cross-reference hallucination** — release-prep run v2 produced 5 blocking findings (p .66–.78) claiming changelog-referenced files "not in this diff"; run v3 was fully silent. Nondeterministic, stochastic trigger — queued as prompt/rule candidate below.
- [x] Repo-index staleness surfacing — shipped as `indexStaleness` on code-review.json. Exact check, not age heuristic: a reviewed file whose on-disk sha256 drifts from its index entry's `contentHash` counts stale (unreadable counts as stale; absent-from-index counts as `missing`, rendered nowhere — new files are coverage, not staleness). Renders `Repo index stale: N of M` in the sticky Diagnostics fold only when drift exists — zero noise on a fresh index.

## Skips, recorded

- CodeRabbit knowledge-base/chat surface — out of scope for a review tool; revisit only with demand.
- Greptile-style always-on full-repo index — our index is opt-in and staleness is the real gap, not coverage.
- Per-seat pricing theater — the spend ledger is the honest version of their "reviewed files" counter; no adoption needed.

## Sweep log

- 2026-10-07 — initial table (CodeRabbit docs + live rate-limit incident, alibaba/open-code-review README + AACR-Bench, PR-Agent, TestDriver pricing). Corpus audit + AACR subset stood up the same day.
