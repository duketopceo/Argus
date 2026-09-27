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
```

Mint the installation token in a prior step and hand it to the action; the
action never mints one itself.

## Review discipline

An approval token is an identity, not a judgement. Two rules keep it from
becoming a rubber stamp:

1. **No self-approval of your own commits.** The App must be a distinct
   identity from whoever opened the pull request.
2. **The approval cites its evidence.** Argus's review body carries the
   verdict, the blocking findings with file and line, and a link to the run
   that produced them — so an `APPROVE` is traceable to a `code-review.json`,
   never a bare signature.

Name a human owner for the discipline. An unattended approver on a protected
branch is an approval gate with no reviewer behind it.
