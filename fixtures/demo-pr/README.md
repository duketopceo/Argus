# fixtures/demo-pr

Deterministic fixture for `argus-reviewer code-review --fixture` and
`npm run demo`. Two source trees:

- `base/` — the merge-base state of a tiny app
- `head/` — the PR state: a real seeded bug in `src/discount.ts`
  (discount applied twice), a **documentation-shaped** credential
  (`__ARGUS_DEMO_DOC_KEY__` — substituted with the AWS docs example at
  materialize time; Jev should adjudicate it as not-live and suppress),
  and a **live-format** credential in `.env.example`
  (`__ARGUS_DEMO_LIVE_KEY__` — a fake-but-real-shaped Stripe key; Jev
  should hedge or flag it as live).

Placeholders exist so no secret-shaped literal sits in this repo —
`scripts/demo.mjs` substitutes them while materializing a temporary git
repo (branch `argus-fixture-base` at the base commit, HEAD at the PR
head) under `.argus-demo/repo`.
