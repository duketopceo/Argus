# Self-host the onboarding App

The onboarding App opens a pull request that adds the Argus workflow whenever
you install it on a repository. It is the same PR `npx argus-reviewer init --pr`
opens, triggered by an install instead of a command. You register the App on
your own account or organization and run its webhook Worker on your own
Cloudflare account. Nothing is hosted for you.

This is a different App from the review-approval App in
[`github-app.md`](github-app.md). That one has no webhook and exists so a
verdict can count as an approving review. Keep them separate.

## Security boundary

- The Worker never holds your OpenRouter key. There is no `OPENROUTER_*`
  binding, and a test greps the Worker source for one.
- The Worker never runs your code, never checks it out, and never runs a
  review. It writes one branch and opens one pull request per repository, using
  the same scaffold module as the CLI.
- It listens to `installation` and `installation_repositories` only. It is not
  subscribed to `pull_request`, `push` or `issue_comment`, so it never handles
  pull-request-controlled content.
- Permissions: `metadata: read`, `contents: write`, `pull_requests: write`,
  `workflows: write`. No `secrets`, `actions`, `checks` or `administration`.
  `workflows: write` is there only because the PR adds files under
  `.github/workflows/`.
- Every request is checked with HMAC-SHA256 over the raw body before any JSON
  is parsed. Failures return a bare 401. Installation tokens are limited to the
  one repository, are never stored, and are redacted from errors.
- The private key is the sensitive part. Anyone holding it can push branches
  and open PRs on every installation. Branch protection and required review on
  your default branches still apply. See [Key rotation](#key-rotation).

## 1. Choose the Worker URL

`wrangler.toml` ships with `workers_dev = false` and no route, so a plain
deploy has no public URL. Pick one of these before you register the App:

- **Route on your own zone (recommended).** Add this to
  `app/worker/wrangler.toml`, with a hostname on a zone in your Cloudflare
  account:

  ```toml
  routes = [{ pattern = "argus.example.com/webhook", zone_name = "example.com" }]
  ```

  The webhook URL is then `https://argus.example.com/webhook`.
- **`workers.dev`.** Set `workers_dev = true`. The URL is
  `https://argus-app-worker.<your-subdomain>.workers.dev`. Do this only if you
  accept a public, guessable hostname. Forged requests still get a 401, but you
  lose the zone's WAF rate rules.

Requests to any path other than `/webhook` get a 404.

## 2. Deploy the Worker

```bash
cd app/worker
npm ci
npx wrangler login
npx wrangler deploy
```

Until the secrets exist, `/webhook` answers 500 and does nothing.

## 3. Register the App with the manifest flow

The manifest flow creates the App from a JSON file and hands back its ID,
webhook secret and private key in one response, so you never copy a key from a
settings page.

1. Generate the manifest form for your URL (add `--org my-org` to register
   under an organization):

   ```bash
   node app/register/manifest.mjs --worker-url https://argus.example.com --html register.html
   ```

   Print the JSON instead by leaving out `--html`. It contains the name, the
   webhook URL `<worker>/webhook`, `default_events` of `installation` and
   `installation_repositories`, and the four permissions above.
2. Open `register.html` in your browser, continue to GitHub, and click
   **Create GitHub App**. GitHub then redirects to
   `http://localhost:3000/argus-registered?code=...`. Nothing needs to listen
   there. Copy the `code` value from the address bar. It works once and expires
   after one hour.
3. Exchange the code and store the three values as Worker secrets in one go.
   The response includes the key in GitHub's PKCS#1 PEM form, and the Worker
   accepts that as is, so there is no conversion step:

   ```bash
   cd app/worker
   CONVERSION=$(curl -fsS -X POST -H 'Accept: application/vnd.github+json' \
     https://api.github.com/app-manifests/<code>/conversions)
   jq -r .id             <<<"$CONVERSION" | npx wrangler secret put APP_ID
   jq -r .webhook_secret <<<"$CONVERSION" | npx wrangler secret put WEBHOOK_SECRET
   jq -r .pem            <<<"$CONVERSION" | npx wrangler secret put PRIVATE_KEY
   unset CONVERSION
   ```

   Do not save the response to a file or paste it into a chat or ticket. If a
   command fails after the code is spent, delete the App on GitHub and register
   again.
4. Keep a copy of the key in your password manager or `omaseal`, not on disk.

## 4. Install and verify

From the App's settings page choose **Install App**, then pick a scratch
repository. Within a few seconds a pull request titled "Add Argus reviewer"
should appear. In **Advanced** on the App page, check that the delivery for the
`installation` event shows a 202.

## Free-tier limits

The Worker is built to run on the Workers free plan.

| Limit | Free plan | What the Worker does |
|---|---|---|
| Requests | 100,000 per day | A forged request costs one HMAC check and gets a 401. |
| CPU time | 10 ms per request | Signing is cheap. The onboarding work runs after the 202 is returned. |
| Subrequests | 50 per invocation | Uses at most 45. |

One fresh repository costs up to 12 subrequests, so **one delivery onboards at
most 3 fresh repositories**. Repositories that are forks, archived or already
onboarded cost less, so more of those fit. A repository that did not fit is
logged as deferred and gets no PR. To onboard it, remove and re-add it in the
installation settings, or run `npx argus-reviewer init --pr` in it. Install on
a few repositories at a time rather than "All repositories" on a large
organization.

Workers logs are off by default (`[observability] enabled = false`). The Worker
never logs bodies or tokens either way.

## Key rotation

GitHub allows several private keys per App, so rotation has no downtime. Do it
once a year and immediately after any suspected exposure.

1. App settings, **Private keys**, **Generate a private key**. This is key B.
   Key A stays valid.
2. `cd app/worker && npx wrangler secret put PRIVATE_KEY` and paste the contents
   of key B's `.pem` file. Secret changes take effect on the next request, with
   no redeploy.
3. Install on a scratch repository (or redeliver a recent `installation`
   delivery from the App's **Advanced** tab) and confirm a 202.
4. Delete key A on the App settings page, and delete the downloaded `.pem`
   files and any other copies.

If key A leaked, also review the App's activity in the audit log, since it could
have minted tokens for every installation.

## Manual integration test

Run this once after the first deploy, and after changes to the Worker. Use a
scratch repository you own. Never use the Argus repository or a repository with
real work.

1. Install the App on the scratch repository only.
2. Confirm the onboarding PR opens, adds the four scaffold files, and sets no
   secrets.
3. Add `OPENROUTER_API_KEY` to the scratch repository's secrets yourself and
   merge the PR. Confirm the workflow runs on the next pull request.
4. Reinstall or re-add the repository and confirm no duplicate PR appears.
5. For local development, `npx wrangler dev` plus a tunnel such as
   `cloudflared tunnel --url http://localhost:8787` gives GitHub a URL to
   deliver to. Point a separate dev App at it, never the production App.

Unit tests cover the same paths offline with a fake GitHub API:
`cd app/worker && npm test`.
