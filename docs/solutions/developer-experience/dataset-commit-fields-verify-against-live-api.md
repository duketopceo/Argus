---
title: Verify dataset commit fields against the live API before using them as diff anchors — "target" can mean branch drift, not PR head
module: eval-harness
date: '2026-10-07'
problem_type: best_practice
component: testing_framework
severity: medium
applies_when:
  - "Building an eval/corpus replay from an external dataset of PRs or commits"
  - "Choosing which dataset fields to use as diff base/head anchors"
  - "Corpus replay produces diffs far larger than the PR actually changed"
  - "Assuming two SHAs in a row mean base..head"
symptoms:
  - "An 11-line PR replays as 605 commits / 44k changed lines"
  - "Reviews burn tens of model calls on unrelated branch drift"
  - "merge-base between two shallow-fetched SHAs silently resolves to the wrong ancestor"
root_cause: data_integrity
resolution_type: workflow_improvement
tags:
  - eval-corpus
  - aacr-bench
  - diff-anchoring
  - data-verification
  - review-eval
---

# Verify dataset commit fields against the live API before using them as diff anchors

## Context

`scripts/review-eval.mjs` replays corpus entries as `code-review --base <base>` in a worktree at `head`. For the AACR-Bench integration (`scripts/aacr-corpus.mjs`), the dataset supplies two commit fields per PR: `pr_source_commit` and `pr_target_commit`. The obvious mapping — target = head — is wrong, and it is wrong in a way that produces plausible-looking output instead of an error.

Measured on a real row (an 11-line TypeScript cline PR): diffing the dataset pair produced 605 commits and ~44,000 changed lines. The review ran 25+ model calls before being killed — everything "worked", it just reviewed months of unrelated branch drift.

## The actual AACR-Bench semantics

- `pr_source_commit` — the base-branch tip at PR time. Correct merge-base anchor → use as `base`.
- `pr_target_commit` — the **target-branch tip at dataset capture time**, not the PR head. PRs merged or updated after capture have diverged heads; even for merged PRs this field is branch state, not the reviewable commit.
- The real head must be resolved live: `gh api repos/<o>/<r>/pulls/<num> --jq .head.sha`, with retry and timeout.

`merge-base(pr_source_commit, gh_head)..gh_head` reproduces the true PR diff (2 files, +10/-1 on the example vs 605 commits the wrong way).

## Why it fooled the pipeline

1. Both fields are full 40-hex SHAs — shape validation passes.
2. They share real ancestry, so `merge-base` succeeds — no error, just the wrong diff.
3. `git diff base head` (no merge-base) between them is also huge, so no fallback path catches it either.

The only signals were soft: an absurd diff size and a model-call count far above the change size.

## Rules that now hold in the harness

- `toCorpus()` **requires** an explicit `resolveHead(p)` — the drift field is not carried on the intermediate object at all, so a later reader cannot wire it through "for convenience".
- PR URLs are strict-parsed (`^https://github.com/o/r/pull/N`) and the repo is emitted canonically — dataset strings never reach git argv verbatim.
- Corpus entry `note` fields record dataset provenance (`AACR-Bench <lang> PR, <n> changed lines, <k> verified issues`) so drift surprises stay auditable.
- Remote corpus entries require exact 40-hex SHAs — refs could resolve to anything the remote serves.

## Generalized lesson

Any external dataset mapping "commits" to "reviewable units" needs the same check before use:

- **Name semantics lie.** `source`/`target`, `base`/`head`, `before`/`after` are guesses until verified — resolve one row against the live API and compare diff sizes.
- **Success criteria are soft.** The failure mode is a plausibly-shaped wrong answer (a huge diff is still a diff). Add a sanity gate: expected vs actual changed-line count, when the dataset provides one (`pr_change_line_count` did).
- **Capture-time fields rot.** Anything resolved "at capture" (branch tips, statuses, reviewers) describes the dataset's past, not the object's present.
