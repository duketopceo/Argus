# Comment fixtures

Each `*.json` file here is one sticky-comment input. `tests/unit/comment-golden.test.ts`
renders it through `action/sticky-comment.cjs` and compares the result with
`tests/goldens/comment/<name>.md`. All fixtures are synthetic (`acme/shop`)
except the one below.

## `dogfood-demo-pr.json` (brand renders, plan U16 and Q14)

The README hero and the social card (`npm run render:brand`, output in
`docs/assets/`) are rendered from this fixture's golden. It is a scrubbed copy
of a real run, not a mock-up:

- **Source:** `.argus-demo/report/code-review.json`, written on 2026-09-23 by
  `npm run demo`, which runs the real code-review pipeline against
  `fixtures/demo-pr` with real model calls. Verdict, findings, proof levels,
  token counts and the metered spend ($0.000739) are as that run recorded them.
- **No new spend:** the fixture is a copy; rendering it makes no model call.
- **Scrubbed:**
  - The triage model and provider (a private model) are replaced with
    `redacted/triage-model` and `redacted`. Their call costs are kept.
  - Finding messages lose the legacy `L<n>: <emoji> <severity>:` prefix the
    prompt produced at the time, and start with a capital letter.
  - The AWS documentation example access key named in the nit is replaced with
    a description, so no key-shaped literal is committed.
  - The em-dash in the probe-lane skip reason is replaced with a colon.
- **Wrapped:** the code review sits under the same `body`, `version` and
  `runUrl` envelope as the other fixtures (`review-only`, `0.4.0`, the
  `acme/shop` run link). The demo ran locally, so it has no workflow run of
  its own.
