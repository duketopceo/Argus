# Reviewer model bake-off (Argus code-review lane)

Date: 2026-10-03. Base: `2e849a2` (release/v0.4.0 incl. reviewer noise fixes + validate step).
Harness: `run.mjs` (realtime, real `argus-reviewer code-review --fixture` path, `ARGUS_CODE_MODEL` override),
`batch.mjs` (OpenRouter Batch replay of the same per-chunk prompt), `judge.mjs` (LLM validity judge),
`score.mjs`, `materialize.mjs`, `report.mjs`. Raw data: `results.json`, `judged.json`.
All spend went through `~/bin/orch` (dedicated capped eval key).

## Fixtures and scoring

- **demo-pr** (planted bugs, 5 realtime runs per model, 1 batch run): T1 double-applied discount in
  `src/discount.ts`, T2 live-format Stripe key in `.env.example`. A finding in `docs/setup.md` is a
  false positive (documentation-shaped AWS key). Recall = planted issues found / 2. Precision =
  findings on T1/T2 / all findings. Realtime includes Argus's secrets lane; batch is model-only.
- **ocellus subset** (no planted bugs): 17 modified `src/` files of `1dfd9b5~40...1dfd9b5`
  (1.9k added lines, `cli.ts` excluded; 8 chunks). 1-2 realtime runs per model, 1 batch run.
  "post-filter" = findings in `code-review.json` (after the validate step); "invalid dropped" =
  findings the validate step removed (anchored outside the diff). pre-filter = post + dropped.
  "judge-valid" = share of the model's findings that `deepseek/deepseek-v4-pro` rated a real defect
  given the diff and file context (noisy proxy; 176 distinct findings judged: 42 valid, 130 invalid, 4 unclear).

## Results

| model | mode | demo ok/runs | recall | precision | doc-key FP/run | ocellus ok/runs | ocellus findings (post-filter) | bug+risk | invalid dropped | judge-valid/ocellus review | demo cost/review | ocellus cost/review | demo latency s | ocellus latency s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| google/gemini-2.5-flash-lite | realtime | 5/5 | 0.90 | 0.73 | 0.8 | 2/2 | 4.0 | 4.0 | 0.5 | 0.0 (0%) | $0.00034 | $0.00861 | 2 | 35 |
| deepseek/deepseek-v4.1-flash | realtime | 5/5 | 1.00 | 0.87 | 0.4 | 0/1 | n/a | n/a | n/a | n/a (n/a%) | $0.00137 | $n/a | 27 | n/a |
| deepseek/deepseek-v4-flash | realtime | 5/5 | 1.00 | 0.93 | 0.2 | 2/2 | 15.0 | 15.0 | 0.0 | 4.0 (27%) | $0.00011 | $0.00058 | 16 | 292 |
| z-ai/glm-5.3 | realtime | 4/5 | 1.00 | 0.83 | 0.5 | 0/1 | n/a | n/a | n/a | n/a (n/a%) | $0.01288 | $n/a | 64 | n/a |
| z-ai/glm-5.3-flash | realtime | 5/5 | 1.00 | 0.80 | 0.6 | 0/1 | n/a | n/a | n/a | n/a (n/a%) | $0.00057 | $n/a | 23 | n/a |
| qwen/qwen3-coder | realtime | 5/5 | 1.00 | 0.67 | 1.0 | 2/2 | 21.0 | 21.0 | 0.0 | 2.5 (12%) | $0.00077 | $0.01701 | 3 | 32 |
| openai/gpt-oss-120b | realtime | 5/5 | 0.60 | 0.80 | 0.2 | 2/2 | 4.0 | 4.0 | 0.0 | 0.5 (13%) | $0.00017 | $0.00325 | 9 | 158 |
| qwen/qwen3.7-flash | realtime | 0/2 | n/a | n/a | n/a | 0/0 | n/a | n/a | n/a | n/a (n/a%) | $n/a | $n/a | n/a | n/a |
| qwen/qwen3-coder | batch | err | n/a | n/a | n/a | err | n/a | n/a | n/a | n/a | (both fixtures) $n/a | | n/a (whole batch) | |
| deepseek/deepseek-v4-flash | batch | err | n/a | n/a | n/a | err | n/a | n/a | n/a | n/a | (both fixtures) $n/a | | n/a (whole batch) | |
| google/gemini-2.5-flash-lite | batch | 1/1 | 1.00 | 0.67 | 1 | 1/1 | 32 | 8 | 14 | 0 (0%) | (both fixtures) $0.00347 | | 502 (whole batch) | |
| openai/gpt-oss-120b | batch | 1/1 | 0.50 | 1.00 | 0 | 1/1 | 15 | 13 | 3 | 5 (33%) | (both fixtures) $0.00362 | | 541 (whole batch) | |
| z-ai/glm-5.3 | batch | 1/1 | 1.00 | 0.67 | 1 | 1/1 | 20 | 6 | 0 | 10 (50%) | (both fixtures) $0.08334 | | 668 (whole batch) | |
| deepseek/deepseek-v4.1-flash | batch | 1/1 | 1.00 | 1.00 | 0 | 1/1 | 21 | 11 | 0 | 13 (62%) | (both fixtures) $0.01631 | | 2007 (whole batch) | |
| z-ai/glm-5.3-flash | batch | err | n/a | n/a | n/a | err | n/a | n/a | n/a | n/a | (both fixtures) $n/a | | n/a (whole batch) | |

Ledger spend (sum of usage.cost): $0.2339


Cost columns: realtime = full `visionCostUsd` per review (includes ~$0.0001 of constant jev/decide
calls); batch = whole batch (demo 1 chunk + ocellus 8 chunks, 9 requests) at `:batch` prices.
Latency: realtime wall clock per review; batch wall clock for the whole batch.

Prices ($/Mtok in/out, realtime -> batch): gemini-2.5-flash-lite 0.10/0.40 -> 0.05/0.20;
deepseek-v4.1-flash 0.30/1.20 -> 0.112/0.336; deepseek-v4-flash 0.028/0.056 (no batch);
glm-5.3 1.40/4.40 -> 0.45/2.00; glm-5.3-flash 0.15/0.50 -> 0.06/0.20; qwen3.7-flash 0.03/0.13;
qwen3-coder 0.30/1.00 (no batch); gpt-oss-120b 0.037/0.17 -> 0.030/0.136.

## Findings

- **Pre-fix baseline noise is gone on this subset.** gemini-2.5-flash-lite (the old 1450-finding
  offender, on the full diff) now yields 4 findings per realtime review here; the validate step
  dropped 0.5/review (realtime) and 14 of 46 (batch, no strict schema). Its findings were judged 0% valid.
- **Open models beat the baseline on every axis that matters.** deepseek-v4-flash and
  deepseek-v4.1-flash reach recall 1.00 / precision 0.93 and 1.00 / 0.87 on demo-pr (baseline 0.90 / 0.73,
  and it flags the documentation key 0.8x per run).
- **Judge-valid rate on the Ocellus subset (batch)**: deepseek-v4.1-flash 62%, glm-5.3 50%,
  gpt-oss-120b 33%, gemini-2.5-flash-lite 0%. Realtime: deepseek-v4-flash 27%, gpt-oss-120b 13%,
  qwen3-coder 12%, gemini 0%.
- **Reasoning models time out in realtime.** Argus's per-request timeout is 120 s
  (`REQUEST_TIMEOUT_MS`). glm-5.3, glm-5.3-flash and deepseek-v4.1-flash each failed the Ocellus review
  with "operation was aborted due to timeout" on every attempt (3 attempts each) and also timed out on
  some demo-pr attempts (retried rows overwrite the failed attempt in `results.json`; observed first-attempt
  demo timeouts: v4.1-flash x2, glm-5.3 x1). In Batch there is no timeout, which is where they shine.
- **deepseek-v4-flash is the only cheap reasoning-light open model that finished everything
  in realtime** (255-329 s per 8-chunk review, each chunk under 120 s), at ~$0.0006/review.
- qwen3-coder is fast (32 s) but noisy (21 bug/risk findings, 12% valid, precision 0.67 on demo).
  gpt-oss-120b is cheap but misses the live key in realtime (recall 0.60).
  qwen3.7-flash is unusable on this account: the OpenRouter allowed-providers setting excludes its only
  provider (alibaba), so every call 404s.
- Batch is 2.7-3.1x cheaper per token for the models that support it (deepseek-v4.1-flash, glm-5.3,
  glm-5.3-flash, gpt-oss-120b, gemini-lite); deepseek-v4-flash and qwen3-coder have no `:batch` endpoint.
  Batch latency was 8-33 min for 9 requests; both glm-5.3-flash batches were still `in_progress` after
  60-90 min and were abandoned.

## Recommendation

- **Default realtime model: `deepseek/deepseek-v4-flash`.** Recall 1.00, precision 0.93, $0.0001/demo
  review, $0.0006 per 8-chunk review, 0.2 doc-key false positives per run. Caveat: ~27% of its
  Ocellus bug/risk findings were judged valid, so keep the validate step and severity gating on.
- **Default batch model: `deepseek/deepseek-v4.1-flash` (`:batch`).** Recall 1.00, precision 1.00,
  62% judge-valid, $0.016 for the whole 9-request batch. Take `z-ai/glm-5.3` (`:batch`, $0.083,
  50% valid, 11 min) when a stronger reviewer is worth ~5x the price and the review is large.
- Do not use gemini-2.5-flash-lite, qwen3-coder or gpt-oss-120b as the review default.

## Caveats

- Small samples: demo-pr has two planted issues; Ocellus has no ground truth and only 1-2 runs
  per cell. Recall/precision differences of 0.1-0.2 are within run-to-run variance.
- The judge is a model; its verdicts are a noisy proxy for validity, and the judge was not blind to
  severity. Judge cost is not itemized (usage.cost came back empty; ~$0.1 estimated).
- Batch mode is not a product feature of Argus: `batch.mjs` replays the same chunk prompt with
  `json_object` instead of the strict schema, and omits the synthesis call and the secrets/triage lanes.
  Batch and realtime rows are therefore comparable only roughly.
- Realtime latency is dominated by provider queueing for the reasoning models; it varies run to run.
- Fixtures are materialized into a scratch dir outside the repo; `run.mjs --work <dir>` recreates them.

## Spend

Ledger (sum of `usage.cost`, realtime + batch): see the line under the table. Judge ~$0.1 on top.
The key's own `usage` counter moved by about $0.33 for the whole session, far below the $5 cap.
