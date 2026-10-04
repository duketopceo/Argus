# 'The witness' — verbatim strings

Every on-screen string below is real product output. Sources:
`tests/goldens/comment/mixed-four-lane.md` (lane table + header + severity),
`fixtures/manifests/mixed-four-lane.json` (spend/tokens), VHS tapes
(terminal), `argus-reviewer init` output (end card). Never paraphrase a
number. Claim lines are the only authored copy.

## S1 hook
- headline: `Every PR gets a witness.`

## S2 terminal (VHS)
- command: `npx argus-reviewer init`
- kinetic: `Your keys. Your models. Your runner.`

## S3 lanes (mixed-four-lane golden)
- header: `Argus: ⊘ needs changes`
- summary: `2 findings reproduced in src/discount.ts · head a1b2c3d · $0.004210 · 38.1s`
- rows:
  - `⊘ failed · review · 3 findings, 2 reproduced · ▰▰▰▰ reproduced · $0.003100`
  - `● passed · flow · 4 of 4 journeys, 1 healed · ▰▰▰▱ exercised · $0.001110`
  - `– skipped · app · not selected`
  - `◐ inconclusive · a0 · agent report is self-reported · ▰▱▱▱ suspected · unmetered`
- severity: `◆ 2 bugs · ◈ 1 risk · ○ 0 nits · 1 high-confidence · 1 suggestion ready to commit`
- kinetic: `Four lanes. Honest when unsure.`

## S4 finding (same fixture, review lane)
- diff anchor: `src/discount.ts:19`
- finding: `Loop bound i <= len(events) reads one past the end.`
- evidence: `probe fails on head, passes on base`
- provenance hover: `deepseek/deepseek-v4.1-flash · 0.94`
- kinetic: `Every finding cites its source.`

## S5 cost (manifest values)
- first run: `$0.004210` total (review `$0.003100` + flow `$0.001110` + a0 `unmetered`)
- cache-hit re-run: `$0.000000` (fingerprint cache 3 hits · 1 miss · 1 heal)
- kinetic: `Re-reviews cost nothing.`

## S6 surfaces
- HTML evidence report · watch TUI · `argus-reviewer check`
- kinetic: `One witness, every surface.`

## S7 end card
- `argus-reviewer-e2e` · `self-hosted · BYOK`
- `npx argus-reviewer init`
- repo URL
