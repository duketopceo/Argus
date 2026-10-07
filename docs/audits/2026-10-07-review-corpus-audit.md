---
title: "Review corpus audit — what Argus actually posts on its own PRs"
type: audit
date: 2026-10-07
origin: plan docs/plans/2026-10-07-1900-feat-review-polish-scale-plan.md (U1)
method: gh api pull-comments across all 92 PRs; classification by severity marker + path
---

# Review corpus audit — 2026-10-07

## Headline numbers

| Metric | Value |
| --- | --- |
| PRs scanned | 92 (all, open+merged) |
| PRs with argus inline comments | 56 (61%) |
| Total argus inline comments | 500 |
| Mean comments per reviewed PR | 8.9 — median 6, max 52 (#59) |
| Corr(comments, diff size) | 0.59 — volume tracks size loosely, not proportionally |
| Zero-comment PRs (recent) | #163, #165, #166 — coincide with the deepseek-stall window fixed in #168/#172; likely silent timeouts, not clean diffs |

## Severity distribution

| Class | Count | Share |
| --- | --- | --- |
| nit (`nit:`/`🔵`/`Minor`) | 250 | 50% |
| warning (`🟠`/warning) | 24 | 5% |
| critical (`🔴`/blocker) | 31 | 6% |
| unmarked/other (older comment format) | 195 | 39% |

On recent PRs the nit share runs 56–100%. The single worst offender
(#136) posted 11 consecutive style nits including a **hallucinated
suggestion** — `os.constants.TMPDIR` does not exist; the comment confuses
the env var with an API constant.

## Path-type distribution

| Path type | Count | Share | Note |
| --- | --- | --- | --- |
| `src/` | 285 | 57% | |
| `docs/` | 114 | 23% | markdown review — needs sampling to judge value |
| `dist/` | 54 | 11% | **committed build output — should never be reviewed** |
| `tests/` | 44 | 9% | |
| generated/lock | 3 | 1% | |

## Structural noise findings

1. **Boilerplate footer on every nit**: `*CI evidence: no repo index —
   run argus-reviewer index first*` is appended to each inline comment,
   doubling visual weight. The footer belongs on the sticky summary once,
   not per-finding.
2. **Generated output reviewed**: 54 comments on `dist/` — there is no
   default-ignore list. CodeRabbit ships ~40 default patterns
   (`!**/dist/**`, lockfiles, `generated/`, `.map`, minified); Argus has
   none.
3. **False-positive example verified**: `os.constants.TMPDIR` suggestion
   (PR #136) references a nonexistent constant — exactly the class OCR's
   reflection pass exists to catch.
4. **Silent zero-comment PRs**: three recent PRs posted no inline
   comments during the deepseek stall window; a timed-out lane reports
   nothing — that's indistinguishable from "clean" to a reader.

## Implications for U2–U5

- **U2 eval harness**: corpus = these 500 comments; labels = acted-on vs
  ignored can be approximated by whether the flagged line changed in a
  later commit on the same PR.
- **U3 hygiene** target measured: dropping `dist/`+generated alone removes
  11% of volume; nit consolidation removes the dominant mode. A #173-class
  PR (14 comments) becomes ≤5 actionable + 1 grouped nit section.
- **U4 precision**: the hallucinated-API nit is the reflection-pass test
  case — a finding whose suggested identifier doesn't exist in the repo
  or stdlib should be dropped before posting.
- **Silent-stall honesty**: zero-comment PRs need a manifest/sticky signal
  distinguishing "reviewed, no findings" from "lane never completed" —
  this is a finding for U3 or a small standalone fix.
