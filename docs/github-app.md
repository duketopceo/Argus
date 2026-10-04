# Your own Argus GitHub App — create, install, wire

Argus posts its sticky comment with the workflow `GITHUB_TOKEN` — no app
required. The app exists for one reason: **making the verdict a real review**
(`APPROVE` / `REQUEST_CHANGES`) that `require_approving_reviews` counts. See
[`approval-token.md`](approval-token.md) for why the Actions token and author
PATs cannot do this.

(Looking for the App that opens the onboarding PR on install? That is [`self-host-app.md`](self-host-app.md).)

You create the app on **your** account, install it on **your** repositories,
and your workflow mints a short-lived installation token at run time. No
hosted service, no webhook, no shared credential — the same BYOK model as the
OpenRouter key.

## 1. Create the app (~2 minutes)

**Settings → Developer settings → GitHub Apps → New GitHub App**
(<https://github.com/settings/apps/new>):

| Field | Value |
|---|---|
| GitHub App name | `argus-reviewer-<you>` — must be globally unique; the `[bot]` suffix is added automatically |
| Homepage URL | `https://github.com/duketopceo/Argus` |
| Webhook | **uncheck "Active"** — Argus runs inside Actions; nothing calls back |
| Permissions → Repository → Pull requests | **Read and write** — submits and dismisses reviews |
| Permissions → Repository → Checks | **Read** — `approval-check` reads the check runs it verifies |
| Permissions → Repository → Contents | Read — lets the token also serve checkout/diff reads if you reuse it |
| Where can this be installed | **Only on this account** |

Create, then on the app page:

- Note the **App ID** (top of the page).
- **Generate a private key** — a `.pem` downloads immediately.

## 2. Install it on your repositories

App page → **Install App** (left rail) → choose *All repositories* or pick the
ones Argus reviews. No further config: the app has no events to receive.

## 3. Store the credentials

```bash
gh secret set ARGUS_APP_PRIVATE_KEY < ~/Downloads/argus-reviewer-you.YYYY-MM-DD.private-key.pem
gh variable set ARGUS_APP_ID --body 1234567   # App ID is not a secret — a variable is fine
```

## 4. Mint the token in the workflow

`actions/create-github-app-token` is the maintained path — no hand-rolled JWT:

```yaml
- uses: actions/create-github-app-token@fee1f7d63c2ff003460e3d139729b119787bc349 # v2
  id: argus-app
  with:
    app-id: ${{ vars.ARGUS_APP_ID }}
    private-key: ${{ secrets.ARGUS_APP_PRIVATE_KEY }}

- uses: duketopceo/Argus/action@<release-sha>
  with:
    openrouter-api-key: ${{ secrets.OPENROUTER_API_KEY }}
    approval-token: ${{ steps.argus-app.outputs.token }}
    approval-evidence: 'npm test'       # the command the approval stands on
    approval-check: 'test'              # a check-run name that must be green on the head SHA
```

The token lives for the job and expires when it ends. Reviews it submits show
as `argus-reviewer-you[bot]` — a distinct identity that cannot be confused
with a human approver or the PR author.

## Failure modes are loud, not silent

- App lacks `pull_requests: write` → the review POST 403s; the comment lane
  still reports the verdict.
- `approval-token` set without `approval-evidence` → the lane refuses
  (approvals must cite the command they stand on).
- `approval-check` missing/queued/red on the head SHA → refusal, not approval.
- Token expired mid-run → the lane reports the auth failure on the comment.

If any of those fire, Argus still leaves the sticky comment and commit
status — only the formal review event is skipped.
