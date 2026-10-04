---
version: 0.1-draft
name: Argus design system ("Ocellus")
status: implemented. Comment grammar, glyph vocabulary, brand assets, and the CLI, TUI, desk, report and launch-video surfaces ship via the Ocellus program (docs/plans/2026-10-02-2316-feat-ocellus-redesign-plan.md).
date: 2026-10-02
description: >
  Design direction, audit, asset plan and full system spec for Argus
  (argus-reviewer-e2e). Argus is presented as a forensic instrument: an
  unsleeping witness that collects evidence and keeps the bill. Neutral
  graphite and cool-paper surfaces, one cobalt accent with fixed jobs,
  Schibsted Grotesk for prose, Martian Mono for anything you could copy or
  count, and a custom family of eye-state glyphs where each status has its
  own shape.

colors:
  light:
    canvas: "#F4F5F7"
    surface: "#FFFFFF"
    surface-sunk: "#EAECEF"
    raised: "#FFFFFF"
    hairline: "#D3D8DF"
    control-border: "#7E8693"
    ink: "#0E1116"
    ink-2: "#3A414C"
    ink-3: "#5D6571"
    accent: "#2343F5"
    accent-tint: "#E6EAFE"
    on-accent: "#FFFFFF"
    passed: "#0F7A55"
    passed-tint: "#E3F3EC"
    failed: "#C42B2F"
    failed-tint: "#FBE7E6"
    caution: "#946000"
    caution-tint: "#FBF0D9"
  dark:
    canvas: "#0C0E12"
    surface: "#14171C"
    surface-sunk: "#090B0E"
    raised: "#1B1F26"
    hairline: "#272C34"
    control-border: "#666E7A"
    ink: "#E8EBF0"
    ink-2: "#B4BBC6"
    ink-3: "#8A929E"
    accent: "#7D91FF"
    accent-tint: "#1A2140"
    on-accent: "#0C0E12"
    passed: "#3CCF94"
    passed-tint: "#10241C"
    failed: "#FF6E6A"
    failed-tint: "#2A1414"
    caution: "#F0B03C"
    caution-tint: "#2A2010"

typography:
  sans: "Schibsted Grotesk (OFL, variable wght 400-900, has italics)"
  mono: "Martian Mono (OFL, variable wght 100-800, wdth 75-112.5)"
  fallback-sans: "system-ui, -apple-system, 'Segoe UI', sans-serif"
  fallback-mono: "ui-monospace, 'SF Mono', 'Cascadia Mono', Menlo, monospace"

spacing: [0, 2, 4, 8, 12, 16, 24, 32, 48, 64, 96]
rounded: { none: 0, xs: 2, sm: 4, md: 6, eye: "50% (glyphs and the mark only)" }
motion:
  instant: 100ms
  state: 180ms
  panel: 260ms
  ease-out: "cubic-bezier(0.2, 0, 0, 1)"
  ease-in-out: "cubic-bezier(0.4, 0, 0.2, 1)"
---

# Argus design system: "Ocellus"

> An *ocellus* is the eye-spot on a peacock feather. In the myth, Hera put the
> hundred eyes of Argus Panoptes on the peacock's tail after Hermes put him to
> sleep and killed him. Argus never slept with every eye shut. Some stayed
> open while others rested. That is a fair description of the lane model: each
> lane is either looking, or has its eyes deliberately closed and says so.
> ([Wikipedia](https://en.wikipedia.org/wiki/Argus_Panoptes),
> [Theoi](https://theoi.com/Gigante/GiganteArgosPanoptes.html))

This document covers phase 1 only: research and a spec. It follows the
`refero-design` method (research first, reference lock, decision ledger,
anti-averaging) and the `design-taste-frontend` redesign protocol (audit before
touching, dials, AI-tell gates). The Refero MCP tools were not configured in
this environment. Research used the bundled craft references, the
`awesome-design-md` corpus (Linear, Sentry, ClickHouse, Warp), live web sources
(cited inline and in §12), and headless screenshots of the real dashboard.

---

## 0. Design read

**Reading this as:** a redesign (overhaul) of a developer tool's evidence
surfaces, for engineers and tech leads reviewing pull requests. The language
should be a quiet forensic instrument: dense, honest and precise. It leans on
custom tokens over native CSS. There is no third-party design system: the
surfaces are GitHub markdown, terminals, and one small local web UI. None of
them can host a component framework, and most of them can't host CSS at all.

| Dial | Product surfaces (comment, dashboard, TUI) | Marketing surfaces (README, social, docs) |
|---|---|---|
| DESIGN_VARIANCE | 3 | 6 |
| MOTION_INTENSITY | 2 | 4 |
| VISUAL_DENSITY | 7 | 4 |

Mode: **redesign, overhaul visuals, preserve content contracts.** The status
vocabulary, the manifest contract, the lane names and the "never color only"
rule all survive. Everything visual is rebuilt from scratch.

---

## 1. Product read and users

**What Argus is.** A self-hosted, BYOK (OpenRouter) PR reviewer that does four
things:

1. **review**: the model reads the diff and returns inline findings plus a verdict.
2. **flow**: replays journeys recorded in plain English. A vision model clicks
   from screenshots, a fingerprint cache makes replay free, and drift "heals".
3. **app**: runs a directed task against the live app and checks an expected
   state.
4. **a0**: delegates to the user's own Agent Zero host. It reports
   `inconclusive`, never `passed`.

Every run writes one `run-manifest.json`. That manifest is the single evidence
contract that every surface renders (`src/report/manifest.ts`,
`src/report/viewmodel.ts`).

**What makes it different:** honesty and money. Statuses never claim more than
the evidence supports ("reproduced, not suspected"), and every call is metered
to the dollar. The brand has to look like it **keeps receipts**.

**Users**

| User | Where they meet Argus | What they need in under 5 seconds |
|---|---|---|
| PR author | Sticky comment, inline review comments, check run | "Is my PR blocked? Which lines? Is it proven or a guess?" |
| Reviewer / tech lead | Same, plus artifacts | "Can I trust this verdict? What did it actually execute?" |
| Adopter evaluating the tool | README, npm page, social card, demo media | "What does it do, what does it cost, is it safe on hostile PRs?" |
| Operator (the maintainer today) | CLI, `npm run watch` TUI, Electron dashboard | "What ran, what it cost, what's degraded, what's healing?" |

**Key structural finding.** `package.json` `files` is `["dist", "action"]`.
That means **the Electron dashboard (`electron/`) and the TUI
(`scripts/watch.mjs`) do not ship to consumers.** Even so, the README presents
both as product surfaces (README line 34). Consumers actually see only the PR
comment and inline review, the check run, CLI output, report files, and the
README/npm page. The PR comment is therefore the product's real UI, and it gets
the highest priority below.

---

## 2. Current-state audit

### 2.1 Surface inventory

| # | Surface | Files | Stack / styling | Seen by |
|---|---|---|---|---|
| S1 | Sticky PR comment (live renderer) | `action/sticky-comment.cjs` (1188 lines); reference TS renderer `src/report/comment.ts` | GitHub-flavored markdown, `<details>`, tables, emoji | Every consumer, every PR |
| S2 | Inline review comments + review body | `src/cli.ts:1545-1551`, `action/sticky-comment.cjs:825-1010`, `action/emit-review.mjs` | Markdown, `suggestion` blocks | Every consumer |
| S3 | Check run / commit status | `action/sticky-comment.cjs:1094-1150` | GitHub checks API text | Every consumer |
| S4 | CLI output + help | `src/cli.ts` (USAGE at :128, init at :2886-2943), `src/log.ts` | Plain text, `[level] msg`, no color, no TTY detection | Every consumer |
| S5 | Report files | `src/report/run.ts`, `junit.ts`, `manifest.ts` | JSON / JUnit XML. No human-readable HTML report | Consumers (artifacts) |
| S6 | Electron dashboard | `electron/index.html`, `renderer.js`, `main.mjs`, `preload.mjs` | Vanilla DOM, inline CSS, GitHub Primer dark hexes, all monospace | Maintainer only (not shipped) |
| S7 | TUI `watch` | `scripts/watch.mjs`, `scripts/collect.mjs`, `scripts/tail-live.mjs` | Raw ANSI, fixed 100 columns, full clear on every render | Maintainer only (not shipped) |
| S8 | README / npm page | `README.md`, `docs/quickstart.md` | Markdown, shields badges, one PNG, one GIF | Adopters |
| S9 | Social preview | `docs/assets/social.png` | Static PNG | Link unfurls |
| S10 | Demo evidence | `demo/pr31-review-surface/*.png`, `scripts/demo.mjs`, `fixtures/demo-pr/` | Screenshots of a GitHub PR | Adopters / docs |
| S11 | GitHub Action listing | `action/action.yml` | No `branding:` block, so the Marketplace shows a generic icon | Adopters |
| S12 | Issue/PR templates | `.github/ISSUE_TEMPLATE/*`, `.github/pull_request_template.md` | Markdown forms | Contributors |

**Dashboard as rendered today.** I captured it headlessly with Playwright,
using real `collect()` data plus a seeded four-lane manifest. No paid calls
were made and the eval button was stubbed.

- Filled state: a top bar with a purple `◉` and a cyan wordmark, then
  "Verify Runs" (run list, lane rows, key/value inspector), then PR and
  workflow cards, then "Latest Eval" dumping raw markdown table pipes, then
  journal cards and the live log.
- Empty state: seven bordered boxes, each with a single grey line ("none open",
  "no runs", "no journal entries"). The run-list empty copy wraps in a 260px
  column.

### 2.2 What to preserve (existing wins)

- **One view-model for every surface.** `manifestToRunView` is used by the
  comment, TUI and dashboard, and parity tests pin it. The redesign must sit
  on top of the view-model and never fork it.
- **Statuses are words plus glyphs, never color alone.** This is stated in
  code comments and the smoke test enforces it.
- **Keyboard listbox semantics in the dashboard.** Roles, `aria-selected`,
  arrow keys, `:focus-visible`.
- **Poll fingerprinting** (`verifyKey`) so a refresh never destroys focus.
- **Honest copy.** "This status is intentionally neutral, not a failure."
  The `init` block "What runs and what it costs". `a0` reports
  `inconclusive`. This voice is the brand. Keep it.

### 2.3 UX friction (ranked)

| Rank | Finding | Evidence | Severity |
|---|---|---|---|
| F1 | **The README demo GIF ends on unrelated personal tooling.** The last ~25% of `docs/assets/demo.gif` shows unrelated personal terminal tooling (a secrets-manager help screen and an import command). A desktop notification toast ("Gho… dev") overlaps the first frames. This leaks private workflow, and it's the first thing adopters watch. | Frames 180-217 of `docs/assets/demo.gif` (1100×487, 218 frames, 18.2s) | P0 (trust/privacy) |
| F2 | **Three competing icon vocabularies in one comment.** Lane emoji (`✅❌⚪⛔⚠️🟡`), verdict emoji (`✅👍🔴`), severity emoji (`🐛⚠️💡❓`), and decorative section emoji (`📝📒💰🔧🔭📂🚥✨🧠🧭🧪`). `⚠️` means both "unavailable" and "risk". `✅` means passed, approve, and "budget OK". | `action/sticky-comment.cjs:84-85, 249-456, 482, 520` | P0 |
| F3 | **Internal codenames leak into user copy.** "Jev unavailable", "triage unadjudicated", HTTP codes ("REQUEST_CHANGES downgraded to COMMENT — 422"), requirement IDs in comments. | `sticky-comment.cjs:545, 995`; pr31 screenshot | P0 |
| F4 | **Redundant inline-comment preamble.** "argus-reviewer bug: L19: 🔴 bug: …". The tool name, severity, line and severity again come before the actual sentence. "CI evidence: no repo index — run argus-reviewer index first" repeats on every comment. | `src/cli.ts:1545-1551`; `demo/pr31-review-surface/pr31-conversation.png` | P0 |
| F5 | **README and docs describe surfaces consumers can't run** (`npm run watch`, `npm run app`). | `README.md:34,119`, `package.json` `files` | P0 (expectation) |
| F6 | **One click spends real money.** "run eval" (dashboard) and `e` (TUI) launch `evals/run.mjs` against OpenRouter with no confirmation, estimate or budget readout. | `electron/renderer.js:330`, `scripts/watch.mjs:236` | P1 |
| F7 | **The dashboard borrows GitHub's identity.** `--bg #0d1117`, `--panel #161b22`, `--border #30363d` are Primer dark tokens verbatim. The UI reads as a GitHub skin with a stray purple eye. There's no Argus identity anywhere. | `electron/index.html:8-11` | P1 |
| F8 | **Dashboard information architecture is maintainer-centric.** Evals, journals and workflow runs of the Argus repo itself share equal weight with run evidence. Eval markdown renders as raw text with table pipes. Workflow titles truncate to "fe…". The sparkline is a fixed 520×60 canvas, not DPR-aware, with hard-coded hexes. | Screenshot, `renderer.js:70-90` | P1 |
| F9 | **There is no evidence viewer.** The product's core claim is "screenshots, video, probes", yet every surface shows file paths (`reports/flow-lane.json`, `- video: path`) instead of the evidence itself. | `comment.ts:evidenceRows`, `renderer.js:renderInspector` | P1 |
| F10 | **TUI mechanics.** Fixed `MAX_W = 100` ignores terminal width. A full `\x1b[2J` clear on every render causes flicker. There's no alternate screen buffer. Ages print as `1366m`. There's no lane selection or inspector parity with the dashboard. | `scripts/watch.mjs:12, 226` | P1 |
| F11 | **The CLI has no visual hierarchy.** No color, no TTY or `NO_COLOR` handling, and `[warn] msg` everywhere. PASS/FAIL lines are fine but the run summary is one long sentence. | `src/log.ts`, `src/cli.ts:750-830` | P1 |
| F12 | **Name sprawl.** Argus / argus-reviewer / argus-reviewer-e2e / legacy vision-e2e / "argus-reviewer watch" / Electron `title: 'argus-reviewer'` / `app.setVersion('0.1.0')` against package 0.3.1. | `package.json`, `electron/main.mjs:22,131` | P1 |
| F13 | **No human-readable report.** A run produces JSON plus JUnit. Reviewers without the dashboard can't browse evidence. | `src/report/*` | P2 (big ceiling win) |
| F14 | **Empty states are dead ends.** "none open", "no runs", "no journal entries" never say what to do next. The one actionable empty state ("no verify runs yet — argus-reviewer verify writes run-manifest.json") wraps awkwardly. | Empty screenshot | P1 |
| F15 | **Comment structure is duplicated three times.** There are separate bodies for manifest, report and review-only, and each has its own header logic. Visual changes will drift unless the comment gets one layout grammar. | `sticky-comment.cjs:193, 216, 680` | P1 (engineering-enabling) |

---

## 3. Asset inventory

### 3.1 Existing assets

| Path | Type | Verdict | Notes |
|---|---|---|---|
| `docs/assets/social.png` | 1280×640 PNG, social card | **Redo** | Generic "dark card with mono type" template. It uses an OS emoji eyeball (`👁`-style raster) as the logo, an olive/khaki accent that appears nowhere else, a faint grid and a corner glow (AI-tell decoration), and a fabricated-looking "12 flows · $0.00" strip. JetBrains Mono everywhere. |
| `docs/assets/demo.gif` | 1100×487 GIF, 18.2s, 475 KB | **Redo (P0, remove now)** | See F1. Content is otherwise good: a real `run`, PASS, $0.000479, `jq` into `run.json`. Re-record from a script. |
| `demo/pr31-review-surface/pr31-conversation.png` | 1400×1600 PNG | **Redo** | Captured logged out, so the GitHub "Sign up for free" banner and footer are in frame. It shows the old redundant inline format (F4). Keep as historical evidence and don't link it from the README. |
| `demo/pr31-review-surface/pr31-files.png` | 1400×1600 PNG | **Redo** | Same issues. |
| `electron/index.html` `◉` glyph | Unicode "logo" | **Replace** | Purple, off-palette, not a mark. |
| Electron app icon | none | **Missing** | Default Electron atom in dock/taskbar. |
| Status glyphs `✓ ✗ — ⛔ ⚠ ~` | Unicode in `viewmodel.ts` | **Keep as terminal fallback, redesign primary** | Reasonable, but `⛔`/`⚠` are emoji-presentation on many fonts and render as color pictographs. `~` is weak for "inconclusive". |
| Comment emoji set | Unicode emoji | **Replace** | F2. |
| `action/action.yml` branding | none | **Missing** | Marketplace allows only a Feather icon name plus one of 8 colors. Use `icon: eye`, `color: blue`. |
| Fonts | system mono stacks only | **Missing** | No brand type anywhere. |
| Favicon / web icons | none | **Missing** | Needed only if a docs site or `desk` web UI ships (§8). |
| OG image per docs page | none | **Missing (P2)** | Only if a docs site ships. |
| Empty-state / loading art | none | **Missing** | |
| `tests/fixtures/*.html` | Test pages | **Keep, out of scope** | Fixtures must stay plain. They are vision-model targets, and redesigning them changes eval baselines. |

### 3.2 New custom assets needed

Production rule: **every brand and semantic asset is drawn by hand as SVG on a
geometric grid.** Bitmaps are exported from the SVG masters. Generated imagery
is used **only** for one optional editorial background (A12), never for UI or
marks. Masters live in `assets/brand/` (new), with exports in
`assets/brand/export/`.

| ID | Asset | Creative brief | Production method | Priority |
|---|---|---|---|---|
| A1 | **Mark: "Ocellus"** | One eye-spot built from three concentric rings on a 24-unit grid: an outer ring (stroke 1.75), an iris ring (stroke 1.75), and a solid pupil offset 1 unit up and right so it reads as looking. The pupil is the only filled shape. Inside the outer ring, four tick marks at 45°, 135°, 225° and 315° stand for the four lanes and double as an instrument reticle. It must work as a single color at 16 px (ticks drop out below 20 px) and must not read as a target, a camera shutter or the Eye of Providence. No eyelashes, no almond eye outline, no peacock colors. | Hand SVG (Figma or direct path authoring). Optical-size variants for 16, 24 and 64+. | P0 |
| A2 | **Wordmark "argus"** | Lowercase, set in Martian Mono at wdth 87.5, wght 560, tracking -1%. Redraw the `g` as a single-storey form whose bowl repeats the ocellus pupil offset. Outline to paths so it needs no font at runtime. There's also a lockup: mark + wordmark, with the gap equal to the iris diameter. "reviewer" is never part of the logo. It's a CLI name, not a brand. | Type then hand path edit. Monochrome only. | P0 |
| A3 | **Status glyph set (6)**, the signature asset. Each status is an eye state, so the shape alone carries meaning. | `passed`: open eye, full pupil. `failed`: open eye with a diagonal strike through the pupil. `inconclusive`: half-lidded (upper lid line at 45% height, pupil half hidden). `blocked`: eye behind a horizontal bar, closed by policy. `unavailable`: dashed outer ring with an empty center, no instrument. `skipped`: closed lid, a single downward arc, resting by choice. Grid 16/20 px, stroke 1.5, round caps. Each one must pass the "glance in grayscale" test against the other five. | Hand SVG. Plus a **terminal/markdown fallback map** (§6.7) that stays one cell wide. | P0 |
| A4 | **Evidence-strength glyphs (4)** | The `suspected → corroborated → exercised → reproduced` ladder as a 4-notch tally: notches filled left to right, mono, 12×12. This is what turns "proven vs guessed" into something you can read at a glance. | Hand SVG + Unicode fallback (`▱▱▱▱`, `▰▱▱▱` … `▰▰▰▰`). | P0 |
| A5 | **Severity glyphs (4)**: bug, risk, nit, question | Geometric, not pictographic (no bug insect, no light bulb). bug = filled diamond. risk = outlined diamond with a center dot. nit = small open circle. question = open square. Shape-only distinction, and color is optional. | Hand SVG + Unicode fallback (`◆ ◈ ○ □`). | P0 |
| A6 | **Lane glyphs (4)**: review, flow, app, a0 | review = two stacked diff lines with a margin bar. flow = three dots joined by a path. app = window frame with a cursor notch. a0 = a box with an arrow leaving it (delegation). Same 1.5 stroke system as A3. | Hand SVG. | P1 |
| A7 | **UI chrome icons** (refresh, search, filter, settings, external, copy, chevrons, close, play, keyboard, ~20 total) | Commodity glyphs drawn on the same grid and stroke as A3 so the whole UI shares one hand. *Open question Q4:* taking these from Phosphor Regular 1.5 instead would save about 2 days with no brand cost. | Hand SVG, or Phosphor as the documented exception. | P1 |
| A8 | **App icon** (desktop/desk app) | The ocellus in `on-accent` on a cobalt (`#2343F5`) squircle field. A faint sunk inner ring gives depth through a value step, not a gradient or gloss. Sizes: 1024 master, `.icns`, `.ico` (16-256), Linux 512/256/128 PNG. | Hand SVG to `iconutil`/ImageMagick export script committed as `scripts/build-icons.mjs`. | P1 |
| A9 | **Favicon set** (only if web `desk` or docs site ships) | `favicon.svg` with an internal `@media (prefers-color-scheme: dark)` swap, `favicon-32.png`, `apple-touch-icon.png` 180, `icon-512.png`, and a maskable variant with a 20% safe zone. | Exported from A1/A8. | P2 |
| A10 | **Social preview 1280×640** | Not a "dark card with a logo". Use a **real redesigned verdict comment**, rendered and cropped at 2x, occupying the right 58%. The left side has the lockup and one line: "Reviews your PR, runs your app, shows the receipts." The bottom-left carries the spend figure from that real run in Martian Mono. No grid texture, no glow, no fabricated counts. Canvas `dark.canvas`. | Playwright render of an HTML template (`assets/brand/social.html`) fed by a recorded fixture manifest, so it can be regenerated. | P0 |
| A11 | **README hero** | `<picture>` with light and dark sources ([GitHub docs](https://github.blog/developer-skills/github/how-to-make-your-images-in-markdown-on-github-adjust-for-dark-mode-and-light-mode/)). This is "anatomy of a verdict": the real comment, annotated with 3 callouts (verdict + proof strength / lanes / spend). Built as a real render, never a div mock-up. | Same Playwright template pipeline as A10, two themes. | P0 |
| A12 | **Demo media** | Re-record as **scripted, deterministic** terminal casts with [VHS](https://github.com/charmbracelet/vhs) `.tape` files committed under `assets/demo/`. Cast 1: `init`. Cast 2: `run` on a **cache hit** ($0.000000, which is the pitch and costs nothing to record). Cast 3: `verify` lane summary. Use a clean profile shell, fixed terminal theme from §6.1, Martian Mono, and 1100 px width. Ship MP4/WebM via GitHub video upload, with a GIF fallback of 3 MB or less. Optional: one browser cast of the desk evidence viewer. | VHS + Playwright video. Never a live personal terminal. | P0 |
| A13 | **Empty-state illustrations (4)** | Monoline, same stroke as A3, max 2 tones (ink-3 + accent), 160×120. (1) "No runs yet": a closed-lid ocellus over a blank ledger line. (2) "No OpenRouter key": an ocellus with an unthreaded key tick. (3) "Nothing to heal": an open eye over a level line. (4) "Manifest unreadable": an eye over a torn ledger edge. Each one pairs with a command to copy. | Hand SVG. | P1 |
| A14 | **Motion assets** | (a) **Scan**: while a lane runs, the pupil drifts along the iris ring (1.6 s loop, ease-in-out). (b) **Blink-to-state**: when a lane resolves, the lid closes and reopens into the final status glyph (260 ms). (c) **Terminal spinner**: 4 frames `◌ ◍ ◎ ◉` at 120 ms. (d) **Tally tick** when the cost ledger increments (the number rolls, 180 ms). Reduced-motion fallbacks: static half-lid for running, an instant swap for resolve. | SVG + CSS keyframes (no Lottie, no JS animation library). Terminal frames in code. | P1 |
| A15 | **Type assets** | Self-hosted, subset WOFF2 of Schibsted Grotesk (wght 400-700 + italic 400) and Martian Mono (wght 400-600, wdth 87.5-100), with OFL license files. Latin + Latin-1 + arrows/box-drawing for Mono. | `glyphhanger`/`pyftsubset`. Budget in §10. | P1 |
| A16 | **Comment glyph images** (experiment) | Optional SVG versions of A3/A4 hosted at a tag-pinned `raw.githubusercontent.com/duketopceo/Argus/<tag>/assets/brand/glyphs/*.svg` and embedded with `<img height="14" alt="passed">`. They appear only if Q3 approves it. The Unicode fallback stays the default. | Exported from A3. | P2 |
| A17 | **HTML run report template** | A self-contained `report.html` (inline CSS/JS/fonts subset, no network) written next to `run-manifest.json`, uploaded with the workflow artifacts and linked from the comment. It is the consumer-facing evidence viewer (§7.6). | Template in `src/report/html.ts`. | P2 (ceiling) |

---

## 4. Research and references

### 4.1 Category scan: what "best in class" looks like

| Product | What it does best | Take | Reject |
|---|---|---|---|
| **Linear** (`awesome-design-md/design-md/linear.app/DESIGN.md`) | Product-led density, a four-step surface ladder, hairline borders, a single accent kept for brand, focus and primary CTA. Screenshots of the real product do the marketing. | Surface ladder, accent discipline, hairline hierarchy, no shadow on dark, "the real UI is the hero" | Lavender-blue hue, near-black-only marketing |
| **Sentry** (`.../sentry/DESIGN.md`; [breadcrumbs changelog](https://sentry.io/changelog/improved-breadcrumbs-on-issues)) | The issue page is a forensic record: a breadcrumb timeline, a slide-out panel for full search/filter instead of inner scroll, and one shared design language for the timeline and replay. | The evidence-timeline pattern and slide-out evidence panel | Violet + lime, mascots, illustrated personality |
| **Playwright Trace Viewer** ([docs](https://playwright.dev/docs/trace-viewer)) | Time-travel: an action list, a duration timeline, before / action / after snapshots, and console/network filtered to the selected range. | Flow-lane evidence model: step list ↔ timeline ↔ before/after screenshot with click point | Its generic chrome |
| **Chromatic** ([docs](https://www.chromatic.com/docs/test)) | Baseline / new / diff with accept-or-deny per snapshot. Denied changes stay listed as a to-do. | **Heal review**: Argus heals are cache diffs, which should be accepted or rejected, not just logged | Storybook-centric framing |
| **CodeRabbit** ([walkthrough docs](https://docs.coderabbit.ai/pr-reviews/walkthroughs)) | A structured walkthrough comment with independent, collapsible sections, separate from inline comments. Every section is configurable. | Section independence, collapsed detail | The poem, emoji headers, and summary length. Argus should be shorter and blunter |
| **Vercel bot** ([changelog](https://vercel.com/changelog/improved-formatting-for-pull-request-comments)) | A single compact status table: Name / Status / Preview / Updated, with one status word plus an icon. | The one-table-first comment grammar | Avatar images |
| **Meticulous** ([what's new](https://app.meticulous.ai/docs/agents/whats-new.md)) | The PR comment links out to a diff viewer. Reviewers record reject reasons. | Comment = verdict + link to rich evidence (A17) | Hosted SaaS dependency |
| **ClickHouse** (`.../clickhouse/DESIGN.md`) | Numbers are the credibility moment: big stat figures in a confident face. | Spend figures set large in mono on README/social | Electric-yellow brand voltage |
| **lazygit / k9s / Charm** ([OpenReplay on Charm TUIs](https://blog.openreplay.com/build-terminal-uis-charm/)) | Panes, a persistent key-hint footer, alt-screen, a resize-aware layout, and dialog overlays. | TUI layout grammar (§7.5) | Rainbow theming |

### 4.2 The ceiling: what a "supreme" Argus feels like

1. **The comment is the product, and it is readable in 3 seconds.** You get a
   verdict word, how strong the proof is, how many lines need you, and what it
   cost. Then you stop reading unless you want detail. No emoji confetti.
2. **Every claim links to evidence you can look at.** You see screenshots with
   the click point, the before/after of a heal, and the probe test that
   reproduced a bug, all in one self-contained report (A17). File paths are
   never the evidence.
3. **Honesty has a visual language.** The eye-state glyphs make "skipped by
   choice", "couldn't run", "blocked by policy" and "inconclusive" look
   *different from each other*, not four shades of yellow.
4. **Money is typeset like money.** Tabular mono figures, fixed precision per
   context, and budget shown as a tally against its cap.
5. **The same grammar everywhere.** Comment, terminal, desk app and HTML
   report use the same order (verdict → lanes → evidence → ledger), the same
   glyphs and the same words. The view-model already guarantees the data. The
   design system has to guarantee the look.
6. **Keyboard-first operator tools.** Use `j/k` and arrows, `enter` to inspect,
   `/` to filter, `?` for help, and a command palette in the desk app. No mouse
   is required.

---

## 5. Design direction: "Ocellus"

### 5.1 Concept

**Argus is a forensic instrument, not a mascot.** It is the unsleeping witness
that writes everything down and hands you the bill. The visual language
borrows from measuring instruments and evidence ledgers, not from
"AI magic". Surfaces are neutral graphite in dark mode and cool paper in light
mode (cool, never cream). Hierarchy comes from 1 px hairlines and value steps,
not from shadows or cards. Prose is set in **Schibsted Grotesk**, a typeface
built for a Scandinavian newsroom: Argus *reports* a verdict, so it should read
like reporting. **Martian Mono** sets anything you could copy, count or diff:
SHAs, commands, model IDs, dollars, durations. Its narrow width axis lets dense
tables stay in mono without sprawling. One **cobalt** accent has exactly four
jobs: the mark, the focus ring, selection, and the single primary action. It is
never used for status. Status gets three restrained semantic hues
(passed / failed / caution), and the shape of the **eye-state glyphs** carries
meaning on its own. The memorable move is that each lane is literally an eye,
open, shut, half-lidded or barred, so Argus's honesty rule becomes something
you can see. The myth gives the brand a story without decoration.

### 5.2 Reference lock

```text
Primary reference/direction: Linear's product-UI system (dense, product-led,
  surface ladder, single restricted accent, hairline hierarchy), adapted to
  light + dark and to non-CSS surfaces.
Preserve: (1) single accent with fixed roles; (2) surface ladder + 1px
  hairlines instead of shadows/cards; (3) density 7 in product UI; (4) the
  real product (comment/report) is the hero image; (5) tight radii (4-6px).
Borrow only: (a) Sentry/Playwright evidence timeline + slide-out inspector
  (pattern, not visuals); (b) ClickHouse "numbers are the credibility moment"
  for spend figures on README/social only.
Role rules: cobalt = mark/focus/selection/primary action ONLY; passed/failed/
  caution = lane & finding status ONLY; mono = copyable/countable data ONLY;
  eye shapes (circles) = glyphs and mark ONLY, everything else square-ish.
Media strategy: real renders of real UI (Playwright from fixture manifests),
  scripted VHS terminal casts; hand-SVG marks/glyphs/empty states; no stock,
  no generated UI, no div mock-ups.
Reject: GitHub Primer palette; purple/violet; emoji as icons; peacock rainbow
  or feather illustration; glows, mesh/aurora gradients, glass; grid-texture
  backgrounds; serif or italic word-swap headlines; pill buttons; cards-for-
  everything; all-monospace UI.
Token commitments: canvas #F4F5F7 / #0C0E12; ink #0E1116 / #E8EBF0;
  accent #2343F5 / #7D91FF; radius 4 controls, 6 panels; no shadows except
  one overlay token; Schibsted Grotesk + Martian Mono.
```

### 5.3 Decision ledger

| Decision | Source | Role rule | Why |
|---|---|---|---|
| Cobalt accent, not lavender/purple | Linear (single accent), anti-slop "Lila rule" | Mark, focus, selection, primary action | One saturated accent reads as instrument. Purple is the AI default, and the current purple `◉` has no system role |
| Status hues separate from accent | Craft (semantic color must be semantic) | Status only | Today cyan is accent, number color and link color at once (`renderer.js`) |
| Shape-coded eye-state glyphs | Myth + existing "never color-only" rule in `viewmodel.ts` | All status displays | Six statuses can't be told apart by color alone, and three are "yellow" today |
| Schibsted Grotesk prose | Taste skill (avoid Inter default); newsroom provenance | Prose, headings, UI labels | A verdict is a report. Gives editorial clarity without a serif |
| Martian Mono data | Product: SHAs, $, models; width axis for density | Copyable/countable values only | The current all-mono UI flattens hierarchy. Mono becomes the data layer |
| Light + dark, light default for docs/report | Anti-slop tell #3; GitHub users in both modes | Theme lock per surface | The comment and README must work in both GitHub themes anyway |
| No cards in comment/report; hairline sections | Anti-slop tell #2; Linear | Grouping | Today there are seven bordered boxes for one-line contents |
| Comment = one table + one verdict line | Vercel bot, CodeRabbit | First screen | Answers "blocked? proven? what needs me? cost?" before any fold |
| Heal = accept/reject diff | Chromatic | Flow lane | A heal is a baseline change. It needs review, not a log line |
| Evidence report as HTML artifact | Meticulous, Playwright trace | Consumer evidence | Consumers can't run the dashboard (`files` field) |
| Spend set large in mono on marketing | ClickHouse | README/social only | "$0.000000 on cache hit" is the pitch |
| Hand-drawn glyph system | User brief (all custom) | Brand + semantic glyphs | Taste skill bans hand-rolled icons by default. The brief overrides that explicitly, limited to a strict grid spec (§6.7) |

### 5.4 Anti-averaging check

The references pull in different directions: Linear is near-black and
lavender, Sentry is violet with a mascot, ClickHouse is black and yellow. The
safe middle would be "dark slate + teal + soft cards". This direction refuses
that average:

- the accent is a pure, high-chroma cobalt and stays rare;
- light mode is first-class, not an afterthought;
- surfaces have no soft shadows;
- the distinctive carrier is the glyph system, not color atmosphere.

---

## 6. Design system spec

### 6.1 Color tokens

Contrast is measured with the WCAG 2.x relative-luminance formula against the
canvas and surface of the same theme.

**Light**

| Token | Hex | Role | Contrast vs canvas / surface |
|---|---|---|---|
| `canvas` | `#F4F5F7` | App/report background | n/a |
| `surface` | `#FFFFFF` | Panels, table bodies, inputs | n/a |
| `surface-sunk` | `#EAECEF` | Code wells, log stream, selected row base | n/a (ink-3 on it 4.98) |
| `raised` | `#FFFFFF` | Popovers, inspector. Same value as `surface`: light elevation is the overlay shadow (§6.4) | n/a (ink-3 on it 5.89) |
| `hairline` | `#D3D8DF` | Dividers (decorative, exempt from 3:1) | 1.31 / 1.43 |
| `control-border` | `#7E8693` | Input/button outlines (must meet 3:1) | 3.37 / 3.67 |
| `ink` | `#0E1116` | Primary text | 17.3 / 18.9 |
| `ink-2` | `#3A414C` | Secondary text | 9.4 / 10.3 |
| `ink-3` | `#5D6571` | Metadata, timestamps (minimum text tone) | 5.4 / 5.9 |
| `accent` | `#2343F5` | Mark, focus ring, selection edge, primary button, links | 6.0 / 6.6 (white on accent 6.6) |
| `accent-tint` | `#E6EAFE` | Selected row fill | n/a |
| `passed` / `passed-tint` | `#0F7A55` / `#E3F3EC` | Passed status | 4.9 / 5.3; on tint 4.65 |
| `failed` / `failed-tint` | `#C42B2F` / `#FBE7E6` | Failed status, bug severity | 5.2 / 5.6; on tint 4.73 |
| `caution` / `caution-tint` | `#946000` / `#FBF0D9` | inconclusive, budget warning, risk severity | 4.9 / 5.3; on tint 4.72 |

**Dark**

| Token | Hex | Role | Contrast vs canvas / surface |
|---|---|---|---|
| `canvas` | `#0C0E12` | Background | n/a |
| `surface` | `#14171C` | Panels | n/a |
| `surface-sunk` | `#090B0E` | Code wells, log stream (one step below `canvas`) | n/a (ink-3 on it 6.27) |
| `raised` | `#1B1F26` | Popovers, inspector, selected row base | n/a (ink-3 on it 5.26) |
| `hairline` | `#272C34` | Dividers | 1.38 / 1.28 |
| `control-border` | `#666E7A` | Control outlines | 3.75 / 3.49 |
| `ink` | `#E8EBF0` | Primary text | 16.2 / 15.0 |
| `ink-2` | `#B4BBC6` | Secondary | 10.0 / 9.3 |
| `ink-3` | `#8A929E` | Metadata | 6.2 / 5.7 |
| `accent` | `#7D91FF` | As light | 6.8 / 6.3 (canvas on accent 6.8) |
| `accent-tint` | `#1A2140` | Selected row fill | n/a |
| `passed` | `#3CCF94` | | 9.7 / 9.0; on tint 8.2 |
| `failed` | `#FF6E6A` | | 7.1 / 6.6; on tint 6.4 |
| `caution` | `#F0B03C` | | 10.1 / 9.4; on tint 8.4 |

**Status → color mapping.** There are only 3 chromatic statuses. The rest are
told apart by shape.

| Status | Glyph (A3) | Color | Terminal fallback |
|---|---|---|---|
| passed | open eye | `passed` | `●` green |
| failed | struck eye | `failed` | `⊘` red |
| inconclusive | half-lid | `caution` | `◐` yellow |
| blocked | barred eye | `ink` (policy stop, not an error) | `⊖` bold default |
| unavailable | dashed ring | `ink-3` | `◌` dim |
| skipped | closed lid | `ink-3` | `–` dim |

Never use pure `#000`. Never pair red and green as the *only* difference
(shapes differ by construction). The terminal palette maps to the 16 ANSI
slots so users' terminal themes stay in charge. Truecolor hexes are used only
when `COLORTERM=truecolor` and `--color=brand` are set.

### 6.2 Typography

| Role | Font | Size / line | Weight | Notes |
|---|---|---|---|---|
| display-1 (README/social only) | Schibsted Grotesk | 56/60 | 700 | -2% tracking, `text-wrap: balance` |
| display-2 | Schibsted Grotesk | 36/40 | 650 | -1.5% |
| title | Schibsted Grotesk | 20/28 | 600 | Screen titles, report header |
| heading | Schibsted Grotesk | 15/22 | 600 | Section heads (sentence case, **no uppercase eyebrows**) |
| body | Schibsted Grotesk | 14/21 | 400 | Product UI base |
| body-sm | Schibsted Grotesk | 13/19 | 400 | Dense tables, inspector values |
| caption | Schibsted Grotesk | 12/16 | 500 | Metadata, minimum UI text size |
| data | Martian Mono wdth 87.5 | 13/19 | 450 | SHAs, models, paths, `tnum` |
| data-sm | Martian Mono wdth 87.5 | 12/16 | 450 | Table cells, log lines |
| figure | Martian Mono wdth 100 | 28/32 (UI) · 64/64 (marketing) | 500 | Spend/totals, `tnum`, `zero` slashed |
| kbd | Martian Mono wdth 87.5 | 11/16 | 500 | Key hints in a 1px `control-border` box, radius `xs` |

Rules:

- Money always uses `data`/`figure` with tabular numerals. Use 6 decimals for
  per-call and per-lane values and 4 decimals for totals above $0.01. Never
  mix precisions within one table.
- Durations: `ms` below 1 s, `12.3s`, `4m 05s`, `2h 14m`. Ages: `3m`, `2h`,
  `5d`. Never `1366m`.
- No ALL-CAPS section labels. The current `.card h2` uppercase tracking is
  retired. Status words are lowercase everywhere, matching the manifest.
- No em-dash in product copy. Use a colon, a period or parentheses.

### 6.3 Spacing and layout

- 4 px base: `2, 4, 8, 12, 16, 24, 32, 48, 64, 96`.
- Product UI row height: 28 px (dense) or 32 px (default). Inspector key
  column is 96 px.
- Desk app layout: a 3-pane grid of `280px | minmax(480px,1fr) | 380px`
  (runs | lanes + evidence | inspector). At widths of 1100 px or less the
  inspector becomes an overlay sheet from the right, Sentry-style.
- HTML report: a single 880 px reading column with full-bleed evidence
  strips, plus a sticky ledger rail at 1280 px or wider.

### 6.4 Radius, borders and elevation

- **Shape lock:** `xs 2` for kbd/chips, `sm 4` for buttons/inputs/rows, `md 6`
  for panels/sheets/images. Circles only for glyphs, the mark and avatar-free
  status. No pills.
- Borders: 1 px `hairline` between regions, 1 px `control-border` on
  interactive controls, 2 px `accent` for focus (2 px offset) and for the
  selected-row leading edge. The edge marks selection, a real semantic meaning,
  so this isn't the decorative accent stripe.
- Elevation: dark mode uses value steps only (`canvas → surface → raised`).
  Light mode has one overlay token,
  `0 8px 24px -8px rgb(14 17 22 / 0.18), 0 0 0 1px rgb(14 17 22 / 0.06)`, for
  popovers, the palette and sheets only. Nothing else casts a shadow.

### 6.5 Motion

Motion has three jobs: feedback, continuity and status change. Anything else is
cut.

| Token | Duration | Easing | Use |
|---|---|---|---|
| `instant` | 100 ms | ease-out | hover, press, focus ring in |
| `state` | 180 ms | ease-out | row select, tab switch, ledger number roll |
| `panel` | 260 ms | ease-in-out | sheet/palette in/out, blink-to-state |
| `scan` | 1600 ms loop | ease-in-out | running lane only (A14a) |

- Press: `translateY(1px)` with no scale. Sheets slide 16 px and fade. They
  never travel across the full screen.
- New live-log rows fade from `accent-tint` to transparent over 600 ms with no
  slide (a log must never move under the reader).
- Polling refreshes never animate unchanged rows. Keep the current
  `verifyKey` fingerprinting.
- `prefers-reduced-motion: reduce` makes every duration 0 and every loop a
  static glyph (half-lid for "running").
- TUI: no animation except the spinner (A14c), and only while a child process
  runs. `ARGUS_NO_SPINNER=1` / non-TTY output prints line-based progress.

### 6.6 Iconography rules

- One hand: 24 px master grid with a 2 px live-area inset, 1.5 px stroke at 20
  px, round caps and joins, and optical size variants for 16 and 12.
- Circles are reserved for **eye semantics** (A1, A3). UI chrome icons (A7)
  are built from rectangles and lines so a refresh arrow never reads as a
  status.
- Icons never stand alone for status. Glyph + word, always. The only
  exception is the 16 px lane-matrix cell, which has a tooltip and accessible
  name.
- Terminal and markdown always use the fallback map (§6.1, A4, A5). No emoji
  in any surface.

### 6.7 Glyph fallback map (terminal and GitHub markdown)

| Meaning | Glyph | Notes |
|---|---|---|
| passed / failed / inconclusive / blocked / unavailable / skipped | `● ⊘ ◐ ⊖ ◌ –` | Chosen from Unicode blocks that default to text presentation (Geometric Shapes, Math Operators), unlike today's `⛔`/`⚠`. **To verify before shipping:** single-cell width in Martian Mono, JetBrains Mono, SF Mono and Cascadia, plus rendering in GitHub light and dark |
| proof: suspected → reproduced | `▱▱▱▱ ▰▱▱▱ ▰▰▱▱ ▰▰▰▰` | Paired with the word |
| severity bug / risk / nit / question | `◆ ◈ ○ □` | |
| verdict approve / needs changes / pass (no findings) | `● approve` / `⊘ needs changes` / `● clean` | Verdict reuses status glyphs, so there's no third vocabulary |

### 6.8 Component inventory and states

Every interactive component has default, hover, active (pressed), focus-visible,
disabled, loading and error states unless noted.

| Component | Surfaces | Variants / states | Notes |
|---|---|---|---|
| Button | desk, report | primary (accent fill, max one per view), secondary (outline), ghost, danger (failed outline) | Loading = inline scan glyph + label kept. Label 1-2 words |
| Spend-confirm dialog | desk, TUI | estimate shown, budget cap shown, "Run eval · ≤ $1.00" primary, Esc cancels | Replaces one-click spend (F6) |
| Run row | desk, TUI | aggregate glyph + status word, run id (mono, middle-truncated `run-2026…21-14`), calls, spend, relative age; selected, focus, stale (manifest older than head) | Middle truncation keeps the distinguishing suffix |
| Lane cell / lane row | all | 6 statuses × {selected, unselected-skipped}, running (scan) | Skipped lanes stay in canonical order, dimmed (parity with comment) |
| Inspector | desk, report | key/value list; groups: Result, Usage, Budget, Cache, Head, Evidence | Values in `data` type; copy button on SHAs/paths |
| Budget tally | desk, report, comment (text) | under cap, ≥80% (caution), exceeded (failed) | 20 ticks, no filled track. Text "spent $0.0042 of $1.00" always present |
| Proof-strength meter | all | 4 notches (A4) | Always followed by the word |
| Finding row | report, desk | severity glyph, file:line (mono, link), one-sentence message, proof meter, "suggestion available" | Expand shows suggestion diff + evidence |
| Evidence viewer | desk, report | step list ↔ timeline ↔ screenshot (before / action with click marker / after), video scrubber | Playwright trace pattern. Images lazy, fixed aspect ratio |
| Heal review card | desk, report | old target vs new target screenshot crops, fingerprint diff, Accept / Reject | Chromatic pattern. Accept writes the cache, reject marks the flow failed |
| Head-binding badge | all | match / mismatch / unknown | Mismatch is `caution` with the reason inline |
| Log stream | desk, TUI | levels debug/info/warn/error with source column; pause-on-scroll; filter | Monospace `data-sm`; max 400 rows kept |
| Degraded banner | desk, TUI, comment | corrupt manifest(s), stale build, no key | Full-width hairline-bordered strip, with a command to fix |
| Empty state | desk, report, TUI | 4 illustrations (A13) + one sentence + copyable command | Never "none"/"no runs" alone |
| Command palette | desk | `⌘K`/`Ctrl K`; runs, lanes, actions | Overlay token, `panel` motion |
| Toast | desk | transient success only (copied, refreshed) | Errors are never toasts |
| Kbd hint bar | desk, TUI | contextual keys | Bottom-aligned, `kbd` style |

---

## 7. Screen-by-screen plan

Each screen lists the pragmatic **first pass** and the **ceiling**.

### 7.1 Sticky PR comment (S1). P0

**Problems:** F2, F3, F15, plus too many folds and equal weight for everything.

**First pass:**

- One layout grammar for all three bodies: header → verdict line → lane table →
  findings summary → folds → ledger footer.
- Uses only the §6.7 glyphs. Codenames go and plain words take their place:
  "Jev" becomes "confidence model", "triage unadjudicated" becomes "risk
  triage unavailable", and HTTP codes move into a collapsed "Diagnostics" fold.

Target first screen (markdown, renders in both GitHub themes):

```markdown
<!-- argus-reviewer -->
### Argus: ⊘ needs changes

**2 bugs reproduced** in `src/discount.ts` · head `a1b2c3d` · $0.004210 · 38.1s

| | Lane | Result | Proof | Spend |
|:-:|---|---|---|--:|
| ⊘ | review | 3 findings, 2 reproduced | ▰▰▰▰ | $0.003100 |
| ● | flow | 4 of 4 journeys, 1 healed | ▰▰▰▱ | $0.000000 |
| ◐ | a0 | agent report is self-reported | ▰▱▱▱ | unmetered |
| – | app | not selected | | |

◆ 2 bugs · ◈ 1 risk · ○ 0 nits · 1 suggestion ready to commit

<details><summary>Findings (3)</summary> … </details>
<details><summary>Heals (1): review before merging</summary> … </details>
<details><summary>Spend ledger</summary> … </details>
<details><summary>Diagnostics</summary> … </details>

<sub>Argus 0.4.0 · [full evidence report](…) · self-hosted, BYOK</sub>
```

**Ceiling:** the header line becomes a tag-pinned SVG verdict strip (A16) with
`<picture>` light/dark, and the footer links into the HTML report (A17) with
anchors per finding. Fold state stays stable across updates, so content only
changes when results change.

### 7.2 Inline review comments (S2). P0

**First pass.** The body starts with the sentence:

```
◆ **bug** · ▰▰▰▰ reproduced
Loop bound `i <= len(events)` reads one past the end when `i == len(events)`.
```

- Show the suggestion block if there is one, then **one** evidence line, and
  only when there is evidence.
- Remove "argus-reviewer bug: L19: 🔴 bug:". GitHub already shows the author
  and line.
- "no repo index" moves to the sticky comment's Diagnostics fold, once.

**Ceiling:** the evidence line links to the report anchor (A17), including the
probe test source and the failing/passing output on head/base.

### 7.3 README, npm page, social, demo (S8-S11). P0

**First pass:**

- Remove `demo.gif` today (F1). Replace it with VHS casts (A12) and the
  `<picture>` hero (A11).
- The README order becomes:
  1. lockup (light/dark SVG);
  2. one-sentence pitch, 20 words or fewer;
  3. 60-second install;
  4. "What lands on your PR", using the real hero render;
  5. "Four lanes" table with lane glyphs;
  6. honesty/status legend (the 6 glyphs with plain definitions);
  7. cost section with a real figure;
  8. security;
  9. configuration.
- Remove the TUI/Electron claims, or mark them "contributor tools" until Q2
  is decided.
- Add `branding: { icon: eye, color: blue }` to `action.yml`.
- Replace the social card (A10).

**Ceiling:** a small static docs site (GitHub Pages) using the same tokens.
It would have per-page OG images generated from the A10 template, an
interactive "status glyph" legend, and a gallery of real comment renders.

### 7.4 Desk app (today: Electron dashboard S6). P1

**IA rebuild:**

- **Runs** is the home screen: left pane runs, center lane matrix + evidence,
  right pane inspector.
- **Heals** is a review queue.
- **Spend** is the ledger by model, lane and day.
- **Repo** is a secondary tab holding today's maintainer panels: PRs, workflow
  runs, evals, journals. Evals render as real tables, not `<pre>` text.
- Live log is a collapsible bottom drawer, as in Playwright UI mode.

**First pass:**

- New tokens, fonts, glyphs, and an app icon (A8).
- `app.setVersion` reads `package.json`.
- Spend confirm (F6).
- Relative ages, middle truncation, and a DPR-aware sparkline drawn with token
  colors.
- Empty states (A13).
- Keep the keyboard model and extend it: `j/k`, `[`/`]` lanes, `/` filter,
  `?` help.

**Ceiling:**

- Ship it to consumers as **`argus-reviewer desk`**, a local web UI served from
  `dist/` on `127.0.0.1` with no Electron. That fixes the `files` gap (F5) and
  removes the 100+ MB runtime. Electron stays as an optional wrapper.
- Add the evidence viewer with before/action/after screenshots and click
  markers, heal accept/reject that writes the cache, and the command palette.

### 7.5 TUI `watch` (S7). P1

**First pass:**

- Alternate screen buffer, diff-based redraw (cursor-home + per-line clear),
  and `process.stdout.columns`-aware width with a 72-column minimum layout.
- Section headers in bold instead of `── Title ───` rules, which saves noise.
  Keep one hairline between regions.
- The Verify pane comes first because it's the product, then Code review,
  PRs/runs and Live.
- A persistent key footer: `↑↓ run  ←→ lane  ⏎ inspect  r refresh  e eval…  ? help  q quit`.
- `e` opens an inline spend confirm (`Run eval against OpenRouter? budget $1.00 [y/N]`).
- §6.7 glyphs and relative ages. Respect `NO_COLOR` and `FORCE_COLOR`.

**Ceiling:** pane focus model like lazygit, a lane inspector overlay, a
log filter, and a resize-aware two-column layout at 140 columns or wider.

### 7.6 HTML evidence report (new, S5 extension). P2, highest-value ceiling

A self-contained `report.html` (A17):

- **Header:** verdict, proof strength, head binding, spend.
- **Lanes:** one section per lane.
- **Findings:** each with code excerpt, suggestion and evidence.
- **Flow:** timeline with screenshots.
- **Heals:** before/after pair.
- **Ledger:** spend breakdown.

It works offline from the artifact zip, honors `prefers-color-scheme`, and
prints cleanly. This is the screen that makes "reproduced, not suspected"
something you can see.

### 7.7 CLI (S4). P1

**First pass:**

- A TTY-aware styler (no dependency, about 40 lines) using ANSI-16 colors from
  §6.1. It is off for non-TTY output, `NO_COLOR` or `--no-color`.
- `run`/`verify` end with a 4-line summary block in the same grammar as the
  comment:

  ```
  ⊘ needs changes   head a1b2c3d   38.1s
    ⊘ review   3 findings, 2 reproduced      $0.003100
    ● flow     4/4 journeys, 1 healed        $0.000000
    total $0.004210 of $1.00 budget · report argus-reviewer-report/report.html
  ```

- Log prefixes become dim `warn` / bold `error` instead of `[warn]`.
- Help text is grouped by job (Review / Test / Operate / Setup) and lists the
  default command first.

**Ceiling:** add `--json` on every command and a `--plain` mode for CI logs.

### 7.8 `init` onboarding. P1

Keep the "What runs and what it costs" block, which is the best copy in the
repo. **First pass:** a 3-step checklist output with ✓ marks for files
written. The next command goes on its own line so it's easy to copy.
**Ceiling:** `init` detects the framework dev command and target URL and
offers a free dry-run (`verify --review --dry-run`, 0 provider calls) that
renders a sample comment into the terminal.

### 7.9 Commit status (S3). P1

The surface is a commit status, not a check run: `context: argus-reviewer`,
`target_url` = the workflow run page. A check run would need `checks: write`,
which fork tokens lack.

The description mirrors the comment's verdict line in compact form —
`<glyph> <verdict> · <n> findings · $<total>` — built from the same sources
as the sticky header. GitHub caps descriptions at 140 characters, so
trailing segments drop whole (` · `-joined), and a lone overflowing first
segment truncates on a code-point boundary with an ellipsis.

State mapping: a `failure` conclusion posts `failure`; everything else —
including `skip` — posts `success` with the label carrying the nuance.
Commit statuses have no `neutral`, and a `pending` skip would wedge a
required check forever.

---

## 8. Priorities summary

| Priority | Items |
|---|---|
| **P0** | Pull `demo.gif` (F1); comment grammar + glyph vocabulary + codename purge (F2-F4, F15); inline comment format; README truth fix (F5) + action branding; mark A1, wordmark A2, glyphs A3-A5; social A10; hero A11; VHS demos A12 |
| **P1** | Desk app reskin + IA + spend confirm + app icon A8 + empty states A13 + motion A14 + fonts A15; TUI rebuild; CLI styler + summary; init; check-run text; chrome icons A6/A7 |
| **P2** | HTML evidence report A17; `argus-reviewer desk` shipped to consumers; docs site + favicons A9 + per-page OG; comment SVG glyphs A16; heal accept/reject; command palette |

Suggested sequencing:

1. **Week 1:** P0 copy and grammar. These are pure text changes with no new
   dependencies. Parity tests in `tests/unit/comment.test.ts` and the
   cross-surface contract test must be updated together.
2. **Week 2:** brand masters (A1-A5) and README media.
3. **Week 3+:** desk and TUI.

---

## 9. Accessibility

- WCAG 2.2 AA minimum for every token pair listed (§6.1 contrast column).
  Text never uses a color below 4.5:1, and control borders/focus are 3:1 or
  better.
- Status is always **glyph shape + word**. Color is the third redundant cue.
  Glyph shapes are distinct in grayscale and under deuteranopia and protanopia
  simulation (verify with a simulator before sign-off).
- Focus: a 2 px `accent` outline with 2 px offset on every interactive
  element. Focus is never removed and never only a color change. Focus order
  follows the visual order of the panes.
- Keyboard: every desk action is reachable without a pointer, and `?` lists
  the keys. Keep the listbox semantics (`role="listbox"/"option"`,
  `aria-selected`) already in `renderer.js`. Add `aria-live="polite"` for
  "run finished" announcements and `aria-busy` while a lane runs.
- Targets are at least 24×24 px (WCAG 2.5.8), and 32 px row height by default.
- Motion: `prefers-reduced-motion` is respected everywhere (§6.5). No
  autoplaying video in the README. Use poster + controls.
- Markdown: lane tables have header rows. Glyph cells are always followed by a
  word in the same row. Images have meaningful `alt` (for example "Argus
  verdict: needs changes, 2 bugs reproduced", not "screenshot").
- Terminal: respects `NO_COLOR`, works in a 16-color palette and on
  light-background terminals (no reliance on bright white text). The non-TTY
  output is plain lines.

## 10. Performance budgets

| Surface | Budget |
|---|---|
| Desk app | First paint ≤ 500 ms (web) / ≤ 900 ms (Electron cold); idle CPU < 1%; DOM ≤ 3,000 nodes; poll diff keeps unchanged DOM untouched; log capped at 400 rows |
| Fonts | ≤ 110 KB WOFF2 total (Schibsted 2 files + Martian Mono 1 variable subset); `font-display: swap`; metric-matched fallbacks (`size-adjust`) so swap causes no layout shift (CLS < 0.02) |
| Icons/glyphs | Each SVG ≤ 2 KB optimized (SVGO), sprite ≤ 24 KB |
| README media | Hero SVG/PNG ≤ 250 KB per theme; social.png ≤ 300 KB; demo MP4/WebM ≤ 2 MB each, GIF fallback ≤ 3 MB |
| HTML report | ≤ 400 KB without screenshots; screenshots WebP q75, lazy-loaded, fixed aspect ratio |
| TUI | Render ≤ 8 ms per frame; no full-screen clears after the first paint; at most 1 render per 100 ms (coalesced) |
| Comment | ≤ 20 KB markdown per update (GitHub limit 65,536 chars); first screen ≤ 12 lines before the first `<details>` |

## 11. Open questions for the user

1. **Name.** Should the brand be just **Argus**, with `argus-reviewer` as the
   command and `argus-reviewer-e2e` only as the npm package name? (Recommended.)
2. **Operator tools.** Should the dashboard and TUI become shipped consumer
   features (`argus-reviewer desk`, `argus-reviewer watch` in `dist/`), or
   stay contributor-only tools? This decides whether P1 work is brand polish
   or product.
3. **Comment images.** Is it acceptable for the sticky comment to load
   tag-pinned SVGs from `raw.githubusercontent.com`? They go through GitHub's
   image proxy, so no reader IPs leak to you, but it adds a network dependency
   to a currently text-only comment.
4. **Commodity icons.** Should every UI icon be hand-drawn (about +2 days),
   or should refresh/search/chevrons come from Phosphor Regular 1.5 as the one
   documented exception?
5. **Default theme for the desk app.** System preference (recommended), or
   dark-first as today?
6. **Docs site.** Is a GitHub Pages docs/landing site in scope, or does the
   README stay the only marketing surface?
7. **Demo recordings.** May VHS casts use a pre-seeded cache hit ($0) only,
   or do you want one fresh paid call recorded once (about $0.0005 on the
   the dedicated eval billing key)?
8. **Fixture pages.** Confirm `tests/fixtures/*.html` stay visually frozen.
   They are vision-model targets, and restyling them would shift eval
   baselines.

## 12. Sources

- Argus Panoptes myth: https://en.wikipedia.org/wiki/Argus_Panoptes · https://theoi.com/Gigante/GiganteArgosPanoptes.html
- CodeRabbit walkthrough comment: https://docs.coderabbit.ai/pr-reviews/walkthroughs
- Playwright Trace Viewer: https://playwright.dev/docs/trace-viewer
- Chromatic visual review: https://www.chromatic.com/docs/test
- Meticulous diff review: https://app.meticulous.ai/docs/agents/whats-new.md
- Vercel PR comment format: https://vercel.com/changelog/improved-formatting-for-pull-request-comments
- Sentry breadcrumbs timeline: https://sentry.io/changelog/improved-breadcrumbs-on-issues
- GitHub light/dark images: https://github.blog/developer-skills/github/how-to-make-your-images-in-markdown-on-github-adjust-for-dark-mode-and-light-mode/
- Charm / TUI patterns: https://blog.openreplay.com/build-terminal-uis-charm/
- Martian Mono: https://evilmartians.com/products/martian-mono · https://fonts.google.com/specimen/Martian+Mono
- Schibsted Grotesk: https://fontalternatives.com/fonts/schibsted-grotesk/
- Local DESIGN.md corpus: `~/Documents/github/personal/awesome-design-md/design-md/{linear.app,sentry,clickhouse,warp}/DESIGN.md`
- Method: `~/.agents/skills/refero-design/SKILL.md` (+ `references/anti-ai-slop.md`, `motion.md`, `icons.md`), `~/.agents/skills/design-taste-frontend/SKILL.md`

## Appendix A. Pre-flight gates for implementation PRs

An implementation PR is not done until all of these hold:

- [ ] No emoji in any surface; only §6.7 glyphs (grep for the Unicode emoji range in `action/`, `src/report/`, `scripts/`).
- [ ] No em-dash in user-visible strings in changed files.
- [ ] Cobalt appears only in mark, focus, selection or primary action.
- [ ] Every status shows glyph + word; grayscale screenshot still distinguishes all six.
- [ ] Both themes screenshotted (desk, report, README hero) and compared to this spec.
- [ ] Parity tests updated so comment, TUI and desk agree on order, labels and glyphs.
- [ ] Empty, loading, error and degraded states rendered and reviewed.
- [ ] Reduced-motion verified; no animation on poll refresh.
- [ ] No paid model call in any test, screenshot or demo pipeline unless explicitly approved.
