<!-- argus-reviewer -->
### Argus: – skipped

**Not run:** `OPENROUTER_API_KEY` is not configured, so no lane ran. This status is neutral, not a failure.

| Status | Lane | Result | Proof | Spend |
|---|---|---|---|--:|
| – skipped | review | no API key |  |  |
| – skipped | flow | no API key |  |  |
| – skipped | app | no API key |  |  |
| – skipped | a0 | no API key |  |  |

Fix: add the key as a repository secret, then re-run the workflow: `gh secret set OPENROUTER_API_KEY`

<sub>Argus 0.4.0 · [workflow run and evidence](https://github.com/acme/shop/actions/runs/123456) · self-hosted, BYOK</sub>
