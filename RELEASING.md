# Releasing

Releases are tag-triggered and published via **npm trusted publishing** (OIDC) —
there is no `NPM_TOKEN` in CI.

## One-time setup

On npmjs.com, under the `argus-reviewer-e2e` package settings → **Trusted
Publisher**:

- Provider: GitHub Actions
- Repository: `duketopceo/Argus`
- Workflow filename: `release.yml`
- Environment: `npm`

The `npm` GitHub environment has a required-reviewer rule, so each publish
pauses for maintainer approval after the tag push.

## Cut a release

```bash
# 1. bump version + changelog entry in a release PR (no commit/tag —
#    the PR merge carries it to main)
npm version patch --no-git-tag-version   # or minor/major

# 2. after the PR merges, tag main and push
git checkout main && git pull
git tag v$(node -p 'require("./package.json").version')
git push origin v$(node -p 'require("./package.json").version')

# 3. retarget the `init` scaffold: bump the duketopceo/Argus/action@ pin in
#    src/cli.ts INIT_WORKFLOW to the new tag's commit SHA, rebuild dist/, and
#    land it as a small follow-up PR. The template pins by SHA, so it only
#    knows about a release after the tag exists.
```

The workflow typechecks, builds, tests, runs the clean-install consumer smoke
against the packed tarball, verifies the tag matches `package.json`, then
waits for approval in the `npm` environment before
`npm publish --provenance`.

## Fallback

If trusted publishing is unavailable, publish locally with passkey auth:

```bash
npm publish --auth-type=web
```

Do not store a bypass-2FA token in repo secrets — the whole point of this
pipeline is that no long-lived npm credential exists.
