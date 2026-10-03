<!-- argus-reviewer -->
### Argus: ⊘ needs changes

**3 findings, none reproduced** · $0.000739

| Status | Lane | Result | Proof | Spend |
|---|---|---|---|--:|
| ⊘ failed | review | 3 findings, 0 reproduced | ▰▱▱▱ suspected | $0.000739 |
| – skipped | flow | run lane disabled |  |  |

◆ 1 bug · ◈ 1 risk · ○ 1 nit

<details>
<summary>Findings (3)</summary>

3 finding(s) include bug or risk

| Severity | Proof | p | Category | Location | Finding |
|---|---|---|---|---|---|
| ◆ bug | ▰▱▱▱ suspected | 0.66 | correctness | `src/discount.ts:6` | Discount is applied twice, so 10% yields 81% of price. Return `price * (1 - pct / 100)` and drop the `discounted` intermediate. |
| ◈ risk | ▰▱▱▱ suspected | 0.68 | security | `.env.example:2` | The `sk_live_` prefix matches real Stripe live-key pattern and will trip secret scanners / invite copy-paste of a live-format value. Use `STRIPE_SECRET_KEY=sk_test_replace_me` or `your_key_here`. |
| ○ nit | ▰▱▱▱ suspected | 0.66 | convention | `docs/setup.md:6` | The AWS documentation example access key gets copied verbatim; use `AWS_ACCESS_KEY_ID=<your-access-key-id>` to remove the key-shaped literal. |

</details>

<details>
<summary>Spend ledger</summary>

**Code review:** deepseek/deepseek-v4.1-flash · 5072 tokens · $0.000739

</details>

<details>
<summary>Diagnostics</summary>

- Risk triage: risk 2.72/5 · deep-review 0.92 · top area `billing` (annotate)
- CI evidence inconclusive for 3 findings: could not fetch CI check-runs
- Probe lane skipped: fixture mode: probes need a real PR checkout
- Secrets scan: 2 candidate(s), 2 adjudicated-suppressed
- Adjudication: 3 finding(s) scored

</details>

<sub>Argus 0.4.0 · [workflow run and evidence](https://github.com/acme/shop/actions/runs/123456) · self-hosted, BYOK</sub>
