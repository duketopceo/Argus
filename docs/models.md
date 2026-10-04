# Verified model menu

Every lane's model is a plain OpenRouter slug — BYOK means any slug OpenRouter
serves works. This table is the short list Argus has actually run end-to-end
(dogfooded on this repo's own PRs and live deploys), plus the cost tier each
slug sits in. Exact per-token prices move — check the slug's page on
OpenRouter before raising budgets.

The weekly `model-catalog` workflow re-checks every slug on this page against
the OpenRouter `/models` catalog so a renamed or retired model can't rot
silently.

| Lane | Config field | Default slug | Verified alternates | Tier |
| --- | --- | --- | --- | --- |
| Code review (realtime) | `code_model` | `deepseek/deepseek-v4-flash` | `deepseek/deepseek-v4.1-flash` (set `review.requestTimeoutMs`), `google/gemini-2.5-flash`, `meta-llama/llama-3.3-70b-instruct` | cheap |
| Code review (batch) | `review.batchModel` | `deepseek/deepseek-v4.1-flash:batch` | `z-ai/glm-5.3:batch` | cheap |
| Vision ground/replay | `model` | `google/gemini-2.5-flash-lite` | `google/gemini-2.5-flash` | cheap–mid |
| Escalation (heal) | `escalation_model` | `moonshotai/kimi-k2.5` | `anthropic/claude-sonnet-4` | mid–premium |
| Adjudication (confidence model) | `decisionModel` | `typesafe/jev-1.13-20260917` | none: pinned, because aliases like `~typesafe/jev-latest` drift | fixed |
| Grounding retry | `grounding_model` | — unset | `google/gemini-2.5-flash-lite` | cheap |

Why these defaults: the 2026-10-03 reviewer bake-off (PR #123) scored
`deepseek/deepseek-v4-flash` at recall 1.00 / precision 0.93 on the demo PR
for about $0.0001 per review, and `deepseek/deepseek-v4.1-flash` in batch at
62% judge-valid findings on a real-PR subset. The realtime default is cheap
but noisier (about 27% of its findings on real code were judged valid), so
the validate step and severity gating stay on; use batch for large PRs.
`deepseek/deepseek-v4-flash` has no `:batch` endpoint, which is why batch has
its own model. Reasoning models (`deepseek/deepseek-v4.1-flash`,
`z-ai/glm-5.3`, `z-ai/glm-5.3-flash`) exceed the 120 s realtime timeout;
raise `review.requestTimeoutMs` before using them realtime.

Tiers are qualitative: **cheap** ≈ cents per hundred reviews, **mid** ≈ cents
per review, **premium** ≈ dimes+ per review. The per-run dollar figure is
always recorded in the report ledger — the tier is a selection hint, not a
billing claim.

## Choosing per deployment

The caller environment wins over checkout config (and is the only way to set
these on untrusted `pull_request` runs):

- `ARGUS_CODE_MODEL="owner/model"` — code review model
- `ARGUS_REVIEW_PROFILES="security,perf"` — review lenses (see
  `src/review/packs.ts`): rubric blocks that tune recall toward security
  defects, performance costs, or debloat. Same severity gate and dedup as
  unlensed findings.
- `ARGUS_BUDGET_USD="0.25"` — hard per-review dollar cap

In `argus-reviewer.config.ts` the same knobs are `code_model` and
`review.profiles` — trusted checkouts only.
