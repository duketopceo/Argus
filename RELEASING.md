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
# 1. bump version + changelog entry, merge to main
npm version patch   # or minor/major — do it in a release PR

# 2. tag and push
git tag v$(node -p 'require("./package.json").version')
git push origin v$(node -p 'require("./package.json").version')
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
