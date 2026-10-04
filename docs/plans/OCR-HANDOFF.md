# OCR Static Lane — Implementation Handoff

Branch: `feat/ocr-static-lane` (off `main`)
Plan: `docs/plans/2026-10-03-ocr-static-lane.md` (PR #122, merged context)
Plan PR: #122 — green, all 8 checks pass.

## Status

| Task | What | State |
|---|---|---|
| 1 | Default-off config surface (`resolveStaticLaneConfig`) | **done** `73557d4` |
| 2 | Binary discovery, not-installed vs crashed (`discoverOcr`) | **done** `b9d76d5` |
| 3 | Defensive JSON parsing → `AdjudicableFinding` | todo |
| 4 | Lane runner that never throws (`runStaticLane`) | todo |
| 5 | Additive-only union (`unionFindings`) | todo |
| 6 | Real-binary smoke gate — **manual, needs a human** | todo |
| 7 | Docs | todo |

## Read this before implementing

**The four constraints come from existing Argus code, not invention:**

1. **Additive-only.** Static findings union in *after* model synthesis. A prompt-injected synthesis must never erase them. Mirrors the contract documented at `src/review/secrets.ts:1-19`.
2. **Degrade, never fail.** Missing binary / crash / timeout / schema drift → a `skipped` reason string. Never a failed review, never a silent empty result.
3. **Off by default, zero new required deps.** Behavior must be byte-identical when the lane is off.
4. **Masking contract preserved.** Raw secret literals cross to Jev inside `state` only — never into findings, comments, report, or logs.

## Key file references

- `src/detect.ts:1-60` — `ExecFn` / `defaultExec` seam. **All subprocess access must go through this**, same as `scanSecrets`.
- `src/review/adjudicate.ts:24-30` — `AdjudicableFinding` shape that static findings must satisfy.
- `src/review/secrets.ts:1-19` — the safety-contract header comment. Read it before writing.
- `tests/unit/secrets.test.ts` — test style reference. Imports use `.js` extensions on `.ts` source paths.

## Commands

```bash
npx vitest run tests/unit/static-lane-*.test.ts    # just the new tests
npm test                                            # full suite — must stay green
npm run typecheck && npm run lint && npm run build
```

### Baseline: 14 failures are pre-existing — NOT yours

Verified on clean `origin/main` in this same worktree:

```
Test Files  7 failed | 35 passed (42)
     Tests  14 failed | 522 passed | 25 skipped (561)
```

Root cause is a **missing local Playwright browser binary**, not code:

```
browserType.launch: Executable doesn't exist at
  ~/Library/Caches/ms-playwright/chromium_headless_shell-1243/...
```

Fix locally with `npx playwright install`. On CI (PR #122 passed Node 22 + 24) these all pass, because CI has the browser. **Do not chase these 14** — diff the failure count against the 522 baseline instead.

## Task 6 is a human gate — do not fake it

It cannot be mocked. A mocked `ExecFn` cannot catch a wrong CLI flag or a changed JSON shape.

```bash
npm install -g @alibaba-group/open-code-review
ocr --version
cd <repo>
ocr review --format json --output - > /tmp/ocr.json
head -c 600 /tmp/ocr.json
```

Then pin the real output as a fixture at `tests/fixtures/ocr-review.json` and assert `parseOcrFindings` handles it without degrading.

**If the real JSON shape differs from what the plan assumed, fix the parser and update the plan.** Do not bend the parser to match a guess.

## Kill criteria — close the PR rather than ship weak

- Real `ocr` JSON can't be mapped to `AdjudicableFinding` without guessing field names
- Lane adds > 30s to a typical review
- `ocr`'s rules turn out to duplicate existing `scanSecrets` coverage with no added coverage

## Known non-obvious facts

- `ocr` is Apache-2.0 and OpenAI-compatible, so `api.experientiallabs.ai/v1` + `glm-5.3-flash-abliterated` works as its LLM if you want free inference. The deterministic rules do the real work, so model quality matters less here than elsewhere.
- **OCR has lower recall than a general-purpose agent by design** (trades recall for precision). Enabling this can *reduce* total findings. That is not a bug — don't "fix" it by loosening the gate.
- SSH signing is broken on this machine (`sign_and_send_pubkey: signing failed for ED25519 "GitHub"`). Pushes still succeed via GitHub fallback, but it will bite on a protected branch. Unrelated to this work; worth fixing separately.