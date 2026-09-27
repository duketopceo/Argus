# Approval tokens: making an Argus verdict count as a review

Argus posts a sticky PR comment. A comment is not a review, and
`require_approving_reviews` reads reviews only — so on a protected branch an
Argus verdict leaves the gate unsatisfied no matter how good the analysis is.

The `approval-token` input closes that gap. Argus then submits a real review
(`POST /repos/{owner}/{repo}/pulls/{n}/reviews`) with the event its verdict
implies:

| `code-review.json` verdict | review event    | effect on `reviewDecision` |
| -------------------------- | --------------- | -------------------------- |
| `pass`, `approve`          | `APPROVE`       | satisfies the gate        |
| `needs_changes`            | `REQUEST_CHANGES` | blocks the merge         |
| `skipped`                  | `COMMENT`       | no effect                 |

`skipped` deliberately resolves to `COMMENT`. A run that never read the diff
must not manufacture an approval.

## Which tokens GitHub will let approve

Two token sources are refused, and neither is fixable with a permission scope.
Both were measured against `duketopceo/orchestral`, not inferred:

**`github.token` / `github-actions[bot]` — refused outright.**

```json
{"message":"Unprocessable Entity",
 "errors":["GitHub Actions is not permitted to approve pull requests."],
 "status":"422"}
```

This is GitHub policy for the Actions token, not a scope you can widen. No
`permissions:` block changes it. It is also why the review lane runs as its own
composite step using `gh` instead of inside `actions/github-script` — that
step's Octokit is permanently pinned to `github.token`.

**A PAT belonging to the PR author — refused.**

```json
{"message":"Unprocessable Entity",
 "errors":["Review Can not approve your own pull request"],
 "status":"422"}
```

So an author token can never approve its own pull request, however it
authenticates.

## What does work

A **GitHub App installation token** minted from an app installed on the
repository, with `pull-requests: write`:

```bash
# App private key -> installation token for the repo
curl -s -X POST \
  -H "Authorization: Bearer $APP_JWT" \
  https://api.github.com/app/installations/$INSTALLATION_ID/access_tokens \
  -d '{}' | jq -r .token
```

The review is then attributed to `<app-slug>[bot]`, and GitHub counts it —
GitHub forbids the *author* from approving, not Apps generally. An App review
has satisfied `require_approving_reviews` on `main` many times on this
repository (`cursor` appId 1210556, 24 `APPROVED` reviews).

## Wiring

```yaml
permissions:
  contents: read
  pull-requests: read        # the sticky comment only needs read

jobs:
  argus:
    uses: duketopceo/Argus/@main
    with:
      openrouter-api-key: ${{ secrets.OPENROUTER_API_KEY }}
      approval-token: ${{ secrets.ARGUS_APPROVAL_TOKEN }}
      approval-evidence: 'python -m unittest discover -s tests && ruff check .'
      approval-check: 'test (22)'
```

Mint the installation token in a prior step and hand it to the action; the
action never mints one itself.

`approval-evidence` is not optional once `approval-token` is set. The lane
refuses to submit an approval that cites no command:

```
argus-reviewer: approval-token was supplied without approval-evidence. An
approval must cite the test command it stands on. […] or drop approval-token
to stay on the comment lane.
```

An approval nobody can re-run is a signature, not a review, so the rule is
enforced rather than documented.

## `approval-check` is what makes that evidence rather than a claim

`approval-evidence` is a string the caller supplies. A string is a claim:
nothing in it proves the command ever ran, so on its own it would let a
reviewer approve by typing a plausible command.

`approval-check` closes that. Name a check run on this repository, and Argus
reads the check runs recorded against the **head commit of the pull request**
and refuses to submit an `APPROVE` unless that check has completed
successfully:

```
argus-reviewer: `test (22)` reported `failure` on the head commit
(https://github.com/o/r/runs/7). Refusing to approve a commit whose named
check is not green.
```

Three properties make this a control rather than a convention:

- **It is bound to the head SHA**, not the branch tip, so an approval cannot be
  carried over to commits that were never tested. If the head SHA is unknown
  the lane refuses rather than falling back to the tip.
- **It fails closed.** No check of that name, still queued, still running, or
  unreadable are all refusals — never an approval.
- **It matches names exactly** (case-insensitively). `test` does not match
  `test (22)`, so a green unit job cannot stand in for the whole suite.

When it does verify, the review cites the real run, not just the command:

```
**Verified by:** `python -m unittest discover -s tests && ruff check .`
**Green on this commit:** [`test (22)` → https://github.com/o/r/runs/7](…) reported `success`.
```

`REQUEST_CHANGES` and `COMMENT` do **not** consult the check. Red CI is
exactly when a negative review must still go out, so gating that path would
suppress the review you most want.

## Stale approvals: the hole `dismiss_stale_reviews: false` leaves

`dismiss_stale_reviews` is `false` on the protected branch, so an `APPROVE`
keeps counting after someone pushes to the same pull request. This is not
theoretical. On `duketopceo/orchestral`, **5 of 9** `cursor` approvals were
issued at one head SHA and the pull request then merged at a different one:

| PR | Commits pushed *after* its approval |
|---|---|
| #30 | 8 |
| #27 | 6 |
| #29 | 4 |

Those merges passed a gate the approver's decision no longer described.

Argus closes part of this itself, in two places:

1. **The head-moved guard.** Before submitting, the lane re-reads the pull
   request's head. If it no longer matches the SHA this run reviewed, nothing is
   submitted:

   ```
   argus-reviewer: the head of #101 moved from a1b2c3d to e4f5a6b while this
   run was working. This run reviewed the older commit, so no review was
   submitted. The push triggers a new run, which will review the new head.
   ```

2. **Stale self-retirement.** After an `APPROVE` lands, the lane dismisses any
   earlier `APPROVED` review **by the same identity** whose `commit_id` is not
   the current head. Scoped to its own login on purpose: an approver revoking
   its own outgrown approval is self-correction, while revoking a colleague's is
   not something a bot should do. Dismissals happen *after* the submit, so a
   failed review can never destroy an approval the pull request already had, and
   a failed dismissal warns without failing a review that succeeded.

**What this does not close.** The window between a push and Argus's next run
starting. Only `dismiss_stale_reviews: true` closes that, and it is a
branch-protection setting, so it is a decision for the repository owner rather
than something this action can do. Treat Argus's self-retirement as a second
line, not a replacement.

## Review discipline

An approval token is an identity, not a judgement. Two rules keep it from
becoming a rubber stamp:

1. **No self-approval of your own commits.** The App must be a distinct
   identity from whoever opened the pull request.
2. **The approval cites its evidence, and the evidence is checked.**
   `approval-evidence` names the command; `approval-check` proves it ran. The
   review body carries the verdict, the blocking findings with file and line,
   and a link to both the Argus run and the verified check run — so an
   `APPROVE` is traceable to a `code-review.json` and a green CI run, never a
   bare signature.

Name a human owner for the discipline. An unattended approver on a protected
branch is an approval gate with no reviewer behind it.
