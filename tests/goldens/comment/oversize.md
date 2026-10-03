<!-- argus-reviewer -->
### Argus: ⊘ needs changes

**flow failed** · head `a1b2c3d` · $0.004000 · 21.4s

| Status | Lane | Result | Proof | Spend |
|---|---|---|---|--:|
| ⊘ failed | review | 60 findings, 0 reproduced | ▰▰▱▱ corroborated | $0.003100 |
| ⊘ failed | flow | 1 of 2 tests passed | ▰▰▰▱ exercised | $0.000900 |

◆ 20 bugs · ◈ 40 risks · ○ 0 nits · 20 high-confidence · 1 suggestion ready to commit

<details><summary>Findings (60): omitted to keep this comment under 20 KB</summary>The full detail is in the report files and the workflow run linked below.</details>

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

<details><summary>Spend ledger: omitted to keep this comment under 20 KB</summary>The full detail is in the report files and the workflow run linked below.</details>

<details><summary>Diagnostics: omitted to keep this comment under 20 KB</summary>The full detail is in the report files and the workflow run linked below.</details>

<sub>Argus 0.4.0 · [workflow run and evidence](https://github.com/acme/shop/actions/runs/123456) · self-hosted, BYOK</sub>
