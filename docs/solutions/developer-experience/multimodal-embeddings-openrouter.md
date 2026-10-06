---
title: Multimodal embeddings via OpenRouter — model pick and API shape for screenshot similarity
module: flow-lane
date: '2026-10-06'
problem_type: reference
component: tooling
symptoms:
  - 'need visual/UI similarity without brittle pixel-diffing (flow lane, dashboard regression)'
  - 'OpenRouter embeddings 400s with "invalid_union" until the input shape is right'
root_cause: api_shape
resolution_type: spike_verified
severity: info
tags:
  - embeddings
  - multimodal
  - openrouter
  - voyage
  - nemotron
  - flow-lane
---

# Multimodal embeddings via OpenRouter — model pick and API shape for screenshot similarity

## What this is

2026-10-06 spike: prove OpenRouter `/embeddings` gives Argus screenshot↔text similarity for the flow lane (visual drift detection without pixel-diff brittleness). Verified live against real dashboard screenshots.

## Model verdict (spike-tested, real Argus screenshots)

| Model | dims | img⋅img | img⋅txt relevant | unrelated floor | $/screenshot |
| --- | --- | --- | --- | --- | --- |
| `nvidia/llama-nemotron-embed-vl-1b-v2:free` | 2048 | 0.809 | 0.331 | ~0.11 | $0 (rate-limited) |
| `voyageai/voyage-multimodal-3.5` | 1024 | 0.853 | **0.472** | ~0.12 | ~$0.0006 |
| `google/gemini-embedding-2` | 3072 | **0.910** | 0.447 | ~0.27 (noisy) | ~$0.0001 |

**Default: `nvidia/llama-nemotron-embed-vl-1b-v2`** — free, cleanest separation between relevant and unrelated pairs (the property a divergence threshold lives or dies on), 131K ctx, visual-document specialist. Gemini's higher raw img⋅img is undercut by its ~0.27 noise floor. **Paid fallback: `voyageai/voyage-multimodal-3.5`** (MongoDB-owned, US-hosted; best cross-modal lift). Free tier is revocable — treat as dev default, not a dependency.

## OpenRouter embedding API shape — non-obvious, verified

- Endpoint: `POST https://openrouter.ai/api/v1/embeddings` — NOT `/chat/completions`.
- `input` union (probe the 400 errors to read this): `string | string[] | number[] | Array<{ content: ContentPart[] }>`. Images must arrive as `input: [{ content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,…' } }] }]` — no bare `{content}` object, no mixed string+object arrays.
- One call per input is the safe pattern; mixed-type batches are rejected outright.
- `usage` returns `prompt_tokens` + `cost` — images tokenize at ~1700–2600 tokens/screenshot.
- **Account-level `allowed-providers` allowlist** (openrouter.ai/settings/privacy) gates embedding providers too — voyageai was absent until enabled manually. A 404 "No allowed providers" is this, not a model outage.

## Where it lands later

Flow lane: embed baseline vs PR replay frames, threshold cosine for visual drift; optionally text-query frames ("find the frame where the modal opened"). Not yet integrated — this doc is the pick + API contract, not the feature.
