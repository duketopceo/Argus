# Seeded review showcase

Purpose-built diff for demonstrating the Argus review lane. **Do not merge.**

Seeded deliberately:

- `discount.ts` — percentage applied twice (logic bug the model should catch with correct math)
- `query.ts` — SQL string-concatenation injection
- `credentials.ts` — Stripe + AWS *documentation-example* keys on bare export lines (Jev should adjudicate them as plausible-looking → reported)
- This file's line below carries the same AWS docs example *with* "docs example" context — Jev should suppress it with an audit record:

```
export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE  # AWS docs example value
```
