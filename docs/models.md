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
| Code review | `code_model` | `deepseek/deepseek-v4.1-flash` | `google/gemini-2.5-flash`, `meta-llama/llama-3.3-70b-instruct` | cheap |
| Vision ground/replay | `model` | `google/gemini-2.5-flash-lite` | `google/gemini-2.5-flash` | cheap–mid |
| Escalation (heal) | `escalation_model` | `moonshotai/kimi-k2.5` | `anthropic/claude-sonnet-4` | mid–premium |
| Adjudication (Jev) | `decisionModel` | `typesafe/jev-1.13-20260917` | — pinned; aliases like `~typesafe/jev-latest` drift | fixed |
| Grounding retry | `grounding_model` | — unset | `google/gemini-2.5-flash-lite` | cheap |

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
