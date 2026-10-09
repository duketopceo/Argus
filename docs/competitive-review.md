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

- [ ] U4(a) positioning check — verify against `droppedUnanchored` counts in eval runs (already partially present; extend to downgrade+count)
- [ ] U4(b) reflection pass — measure precision delta on `eval-corpus.aacr.json` before adopting
- [ ] U4(c) deterministic bundling — measure recall lift on multi-file PRs
- [ ] Walkthrough paragraph in sticky head — measure against comment-count goals (must not add noise)
- [ ] `emit path instructions`-style config mining — blocked on U6 feedback data
- [ ] Confidence floor on blocking severities — dogfood data (2026-10-08): AACR labeled blocking precision 0.86 raw, 1.00 at p>=0.5 keeping 5/6 TPs; `adjudicate.ts` annotates `p` but never gates. Gate: measure precision/recall delta on the corpus at several floors; pick the floor that hits ~1.00 precision without gutting recall, demote below-floor bug/risk to the fold instead of inline + verdict-driving
- [ ] Clean-PR silence eval — no corpus row currently measures "PR with zero real issues emits zero blocking findings" (dogfood measured ~0.06 blocking precision on a 121-file diff). Gate: AACR incorrect-labeled rows + synthetic clean diffs; target P(blocking | clean) ~= 0, sliced by diff size since that's the confound
- [ ] Repo-index staleness surfacing — Greptile gap item: index is opt-in and goes stale silently. Gate: none needed for surfacing (warning, not mechanism); adoption criterion is the stale-index warning rendering in the sticky without noise

## Skips, recorded

- CodeRabbit knowledge-base/chat surface — out of scope for a review tool; revisit only with demand.
- Greptile-style always-on full-repo index — our index is opt-in and staleness is the real gap, not coverage.
- Per-seat pricing theater — the spend ledger is the honest version of their "reviewed files" counter; no adoption needed.

## Sweep log

- 2026-10-07 — initial table (CodeRabbit docs + live rate-limit incident, alibaba/open-code-review README + AACR-Bench, PR-Agent, TestDriver pricing). Corpus audit + AACR subset stood up the same day.
