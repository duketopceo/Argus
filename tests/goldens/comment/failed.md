<!-- argus-reviewer -->
### Argus: ⊘ failed

**flow failed** · head `a1b2c3d` · $0.002100 · 21.4s

| Status | Lane | Result | Proof | Spend |
|---|---|---|---|--:|
| ● passed | review | 1 finding, 0 reproduced | ▰▱▱▱ suspected | $0.001200 |
| ⊘ failed | flow | 1 of 2 tests passed | ▰▰▰▱ exercised | $0.000900 |

◆ 0 bugs · ◈ 0 risks · ○ 1 nit

<details>
<summary>Findings (1)</summary>

The change is small and reads correctly; one naming nit.

| Severity | Proof | p | Category | Location | Finding |
|---|---|---|---|---|---|
| ○ nit | ▰▱▱▱ suspected |  | naming | `src/login.ts:14` | Rename `x` to `attempts` for clarity. |

</details>

<details>
<summary>Tests (2)</summary>

| Test | Result | Calls | Spend | Heals | Asserts |
|---|---|--:|--:|--:|--:|
| checkout applies discount | ● passed | 2 | $0.000600 | 0 | 1 |
| login form | ⊘ failed | 1 | $0.000300 | 0 | 1 |

**checkout applies discount**
- ● passed · *total shows the discounted price*: total reads $90.00

**login form**
- ⊘ failed · *login form is visible*: no form found on the page

- video: `argus-reviewer-report/videos/login.webm`

</details>

<details>
<summary>Spend ledger</summary>

| Line item | Value |
|---|--:|
| Vision calls | 3 |
| Per-call cost (avg) | $0.000300 |
| Calls (google/gemini-2.5-flash-lite) | 3 |
| Spend (google/gemini-2.5-flash-lite) | $0.000900 |
| Total vision spend | $0.000900 |
| Sandbox seconds | 9.2s |
| Budget cap | $0.050000 |
| Budget exceeded | no |

**Fingerprint cache:** 1 hit(s) · 2 miss(es) · 0 heal(s)

**Code review:** deepseek/deepseek-v4.1-flash · 2400 tokens · $0.001200

</details>

<details>
<summary>Diagnostics</summary>

- Head binding: match, checkout matches the intended PR head

</details>

<sub>Argus 0.4.0 · [workflow run and evidence](https://github.com/acme/shop/actions/runs/123456) · self-hosted, BYOK</sub>
