# OCR dry run — FAILED, do not wire this up

**Date:** 2026-10-04
**Verdict:** kill criterion tripped. Do not integrate `ocr` into Argus as a static lane.

## What was attempted

Install `@alibaba-group/open-code-review` (v1.12.11) and run `ocr scan` against
Argus's `src/` to see whether it finds anything the existing
`src/review/secrets.ts` lane misses.

## Result: never completed

| Attempt | Scope | Est. tokens | Outcome |
|---|---|---|---|
| 1 | `src/` (41 files) | ~1.6M | killed at 560s, mid-review, 0 bytes written |
| 2 | `src/review/secrets.ts` | ~51K | killed at 280s, 0 bytes written |
| 3 | same, unbounded | ~51K | killed at ~6min, 0 bytes written, process idle |

In every case the process produced **no output file** and stalled partway.
It was not slow-but-progressing — at 0.0% CPU with no open TCP socket for the
final 3 minutes, it was **blocked, not working**.

## The inference endpoint is not the problem

Ruled out with direct calls against the same key:

| Probe | Result |
|---|---|
| `/v1/chat/completions`, qwen3.8-27b | 2s |
| `/v1/chat/completions`, deepseek-v4-flash | 1s |
| `/v1/chat/completions`, glm-5.3-flash | 3s |
| `/v1/chat/completions`, gpt-6-luna | 1s |
| `/v1/messages` (Anthropic shape, what ocr uses) + `tools` | 2.7s, correct `tool_use` block |

So the gateway responded on both lanes, and the `/v1/messages` probe returned
a `tool_use` block in 2.7s. These probes do not establish streaming behavior
or rule out the provider as the cause of OCR's hang.

## Two config mistakes I made first (for the record)

1. **No LLM configured.** Required `OCR_LLM_URL` / `OCR_LLM_TOKEN` / `OCR_LLM_MODEL`.
2. **Base URL must be the bare host.** `OCR_LLM_URL=https://api.experientiallabs.ai`,
   *not* `.../v1` — ocr appends `/v1/messages` itself. Supplying `/v1` yields
   `/v1/v1/messages` → 404.

Neither was the cause of the hang. Both are worth recording if anyone retries.

## Kill criteria check

The plan (`docs/plans/2026-10-03-ocr-static-lane.md`) lists three conditions
that mean close rather than ship:

- [x] **The lane adds more than ~30s to a typical review.** It exceeded 6
      minutes on a *single file* and never returned.
- [ ] Real JSON shape can't be mapped without guessing — **unverifiable**,
      because no run ever produced JSON. This is the decisive one: the plan's
      Task 3 parser is written against an assumed shape, and the plan's whole
      premise (that real output can be pinned as a fixture, Task 6) **cannot
      be satisfied**.
- [ ] Rules duplicate `scanSecrets` — untestable, no findings produced.

## Recommendation

**Do not build the static lane.** Tasks 3–7 of the plan are unverifiable while
the tool cannot complete a one-file scan. The additive-only union, the
degrade-never-fail contract, and the union tests are still sound engineering
— but they would protect a lane that never yields findings, which is worse
than no lane: it adds a dependency, a subprocess, and latency to prove nothing.

Tasks 1–2 already landed on `feat/ocr-static-lane` (config surface + binary
discovery). Both are small and harmless. Either leave them as unused scaffolding
or close the branch.

## If someone retries

The likely culprit is OCR's agent loop against a **free-tier shared lane with
no streaming agreement** — it may be waiting on a stream that the gateway
holds open rather than closing. Worth trying a paid endpoint with confirmed
streaming support before concluding OCR itself is broken.

Untested here: `ocr review` (diff mode) vs `ocr scan` (full-file), whether
`--model` is honoured over `OCR_LLM_MODEL`, and the non-xplabs providers.