---
title: "feat: codebase-context code review (index-informed PR review)"
created: 2026-09-11
origin: R3 roadmap phase — competitive gap: every serious review tool indexes the repo
---

# Codebase-context code review

## Summary

`argus-reviewer code-review` currently sends only the raw PR diff chunks to the
code model. Every serious competitor (CodeRabbit, Greptile, Bito, Cubic)
indexes the codebase and reviews with caller/importer context. We now have the
index — `src/index/scan.ts` landed on `main` — so the moat feature is wiring it
into the review prompts: for each changed file, inject a bounded context block
(purpose, top importers, top imports) so the model reviews the diff *in
context* rather than in isolation.

## Problem Frame

- `cmdCodeReview` fetches `pulls/{pr}/files` patches and chunks them by ~6k
  tokens (`buildPatchChunks`) — no knowledge of the rest of the repo.
- Findings that require context ("this caller passes null", "this file is
  imported by the payment path") are impossible today.
- `src/index/scan.ts` already produces `argus.index.json` with per-file
  purpose, imports, importedBy, and content hash; the action already runs
  `index` before `run` when `index: 'true'` (default).
- Constraint: context must be token-bounded — a cheap flash model reviews the
  diff; blowing up prompt size defeats the cost moat.

## Requirements

- **R1.** When `argus.index.json` exists in the working directory,
  `code-review` attaches a bounded context block per changed file to each
  review chunk.
- **R2.** Context per file: `purpose` (if indexed), top-N `importedBy` paths,
  top-N `imports` paths — each list capped and the whole block token-capped
  (~500 tokens/file, ~2000 tokens/chunk max) using the existing chars/4
  estimate.
- **R3.** No index → identical behavior to today (no failure, no noise).
- **R4.** Output contract unchanged: `code-review.json` schema, verdict
  values, severity gating, commit-status semantics.
- **R5.** No new config keys required — index presence is the opt-in. The
  action's `index` input already defaults to `'true'`.

## Key Technical Decisions

- **KTD1. Index-only context.** No embeddings, no AST walk, no extra model
  calls for context synthesis. The index is already built and free.
- **KTD2. Per-file context blocks inside the chunk text.** Context lives
  adjacent to each file's patch so the model sees it next to the diff — not in
  a detached header. Format: a short `> context:` line block under each
  `### filename` heading.
- **KTD3. Prompt instruction, not schema change.** The review prompt gains one
  line telling the model context blocks exist and to weigh importer blast
  radius; findings schema untouched.
- **KTD4. Deterministic cap.** Lists truncated to 5 entries; block hard-capped
  via char budget; never throws on missing/malformed index.

## Scope Boundaries

### In scope
- `src/index/context.ts` — bounded per-file context block builder
- `src/cli.ts` — wire context into `buildPatchChunks` / `cmdCodeReview`
- Prompt line for context awareness
- Unit tests

### Out of scope
- Embeddings / semantic search over the repo
- Multi-stage context-aware synthesis prompt changes (synthesis prompt can get
  one line later if needed — v1 keeps it identical)
- Auto-fix / apply-suggestion mode
- GitHub Enterprise path changes

## Implementation Units

### U1. `src/index/context.ts` — bounded review-context builder

**Goal:** `loadReviewContext(indexPath, filenames)` returns
`Record<filename, contextBlock>` where each block is ≤ ~500 estimated tokens.

**Requirements:** R1, R2, R3, KTD1, KTD2, KTD4

**Files:** `src/index/context.ts` (new), `tests/unit/index-context.test.ts` (new)

**Approach:** read the index via existing `readIndex`; for each requested
filename, produce a compact block:

```
> context: purpose=<one line> | importedBy=<top 5> | imports=<top 5>
```

List entries truncated to 5, sorted by path length ascending (shortest = most
relevant). Missing file in index → no entry (silent). Missing/unparseable
index → empty record (silent). Path matching must tolerate leading `./` and
workspace-relative vs index-relative differences.

**Patterns:** `src/index/scan.ts` `readIndex` + `RepoIndex` shape; the chars/4
token estimate already used in `buildPatchChunks`.

**Test scenarios:**
- Index present, file indexed → block contains purpose + lists, ≤ cap
- File absent from index → no entry
- Malformed index JSON → empty record, no throw
- >5 importers → truncated to 5
- Block stays under ~2000 chars

**Verification:** `npm test` green with new unit test file.

### U2. Wire context into `cmdCodeReview` chunks + prompt line

**Goal:** `buildPatchChunks` emits chunks whose `### file` sections include the
context block; the review prompt gains one line: `Lines beginning "> context:"
are index facts about the file — weigh importer blast radius when judging
severity.`

**Requirements:** R1–R5

**Files:** `src/cli.ts` (buildPatchChunks + cmdCodeReview + prompt), `src/index/context.ts`

**Approach:** `cmdCodeReview` resolves `argus.index.json` (`config.indexPath`
default) once, calls `loadReviewContext`, passes the map into
`buildPatchChunks` (signature gains an optional second arg — keep default `= {}`
so existing tests/callers compile unchanged). Context chars count toward the
chunk token target so large-context files still split correctly.

**Test scenarios:**
- Chunk text contains `> context:` when index has the file
- Chunk text identical to today when index missing (golden-path regression)
- `code-review.json` schema/verdict unchanged
- Context pushes a file to a later chunk when over the token target

**Verification:** `npm run typecheck && npm run lint && npm test` green.

## Risks

- **Prompt-size creep** — mitigated by hard caps (R2).
- **Stale index** — index has per-file content hashes; v1 does not verify
  hash-vs-diff freshness (the diff-invalidates-cache feature uses it the other
  direction). A stale index may attach a stale `purpose` — acceptable for v1,
  noted as follow-up.
- **silent no-op regression** — covered by the identical-chunks test (R3).
