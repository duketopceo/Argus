# Craft and Launch Research: quality bar, launch videos, launch-kit spec

Date: 2026-10-02. Research only: no repo was modified and no paid model or API was called.
Companion to `design-research.md` (same folder). That file already covers skills, references, the
asset pipeline (logos, icons, OG images, AI-image costs), typography, color, motion tokens,
WCAG 2.2, AI-native UX patterns and anti-slop tells. None of that is repeated here.

Inputs read: `Argus/DESIGN.md` ("Ocellus"), `orchestral/DESIGN.md` ("The Score"),
`Pace-Server/DESIGN.md` ("Master Clock"), `wisp/DESIGN-v2.md` ("Ember in the terminal").

**Verified on this machine (omarchy-max, aarch64):**
- **Remotion 4.0.532 renders on Linux arm64.** `npx remotion browser ensure` downloaded
  Chrome Headless Shell 149 for `linux-arm64` (88 MB, about 3 s). A 60-frame 1080x1080 at 60 fps
  spring-title composition rendered to H.264 in 13.8 s wall time, bundling included. I checked a
  frame and it was correct. The smoke project is in `scratchpad/remotion-smoke/`.
- **`vhs` 0.12.1 renders MP4 on aarch64** in about 3 s. One caveat: `Set Framerate 60` produced a
  25 fps MP4. Check the framerate and render the PNG-sequence output instead if you need 60 fps.
- Already installed: `ffmpeg` (libx264, ProRes, VP9), `wf-recorder`, `obs`, `gpu-screen-recorder`
  (the backend of Omarchy's `omarchy-capture-screenrecording`, which passes
  `-fallback-cpu-encoding yes` because Asahi has no hardware encoder), `chromium` 153, `ttyd`,
  `gifski`, `node` 26, `bun`.
- **Blender has no Linux arm64 build.** `mirror.blender.org/release/Blender5.2/` ships only
  `linux-x64`, `macos-arm64` and `windows-arm64`. AUR `blender-bin` is `arch=('x86_64')`, and Arch
  ARM has no `blender` package. Do 3D logo stings in `@remotion/three` (React Three Fiber) instead.
- `kooha` 2.3.2 is available in `extra` (aarch64). `wl-screenrec` is not packaged.

---

## Part A: How exceptional products get made

### A.1 What the best teams actually do

| Team | Practice | Takeaway for us |
|---|---|---|
| **Linear** | **Quality Wednesdays**: every engineer finds and fixes one "degrades the experience" flaw each week (not a bug), then demos it at the Wednesday meeting. Each fix takes 30 to 60 min. Over two years that added up to 1,000+ fixes under a `quality` label. The team says the main gain is pattern recognition: people now catch flaws while building ([linear.app/now/quality-wednesdays](https://linear.app/now/quality-wednesdays), Aug 2025). **Zero-bugs policy**: high-priority bugs are fixed in 48 h and low-priority ones in 7 days. Each bug is either fixed or marked "won't fix", with no backlog. To start, they paused feature work for 3 weeks to clear 175 bugs ([linear.app/now/zero-bugs-policy](https://linear.app/now/zero-bugs-policy)). Engineers pair tightly with designers and ship internal builds first ([Linear job post](https://jobs.accel.com/companies/linear/jobs/69522598-senior-staff-product-designer)) | Hold a weekly polish ritual with a label, and use the bug SLA as a forcing function |
| **Linear (writing)** | The changelog has a weekly cadence. Each entry has a benefit headline, 2 to 3 sentences, a real screenshot or video, and New / Improved / Fixed labels. It describes what changed for the user, not in the code ([linear.app/blog/startups-write-changelogs](https://linear.app/blog/startups-write-changelogs); [productlift roundup](https://www.productlift.dev/blog/best-changelog-examples/)) | A changelog is a product surface. Every launch-kit video doubles as a changelog asset |
| **Vercel** | Design engineers own the work from sketch to ship. They "sketch in Figma or code, socialize the change, incorporate feedback, then ship it", using preview links and short videos as the review medium. The bar is "polished interactions, no dropped frames, no cross-browser inconsistencies, and accessibility", under the principle "Iterate to Greatness" ([vercel.com/blog/design-engineering-at-vercel](https://vercel.com/blog/design-engineering-at-vercel), 2024). The **Web Interface Guidelines** turn taste into lintable rules ([raw command.md](https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md); installable as the `web-design-guidelines` agent skill, [skills.sh](https://www.skills.sh/vercel-labs/agent-skills/web-design-guidelines)) | Codify taste as a checklist an agent can audit (section A.3 borrows heavily from it) |
| **Rauno Freiberg** (Vercel) | "Invisible Details of Interaction Design" (2023) recreates and dissects great interactions to build a vocabulary. Ideas include **fidgetability** (delight without utility) and the sense that an interface is "an extension of ourselves" ([summary](https://construkt.beehiiv.com/p/invisible-details-interaction-design); [Design Lobster on fidgetability](https://designlobster.substack.com/p/150-fidgetability)). His later "Devouring Details" course continues it | Recreate the reference interactions in code before designing your own |
| **Emil Kowalski** (Linear, ex-Vercel; Sonner, Vaul) | Taste is a trained instinct, not a preference. Rules: keep animations **under 300 ms**, use `ease-out` for responsiveness, and **don't animate keyboard-initiated or high-frequency actions** (Raycast dropped its enter animations for this reason). Animate only `transform`/`opacity`, at 60 fps or better, interruptibly, and respect reduced motion ([emilkowal.ski/ui/great-animations](https://emilkowal.ski/ui/great-animations); course [animations.dev](https://animations.dev); his agent skill [emil-design-eng](https://claudepluginhub.com/plugins/emilkowalski-emil-design-skills)) | Ask "how often is this seen?" before adding any motion |
| **Raycast** | Treats about 50 ms as the perceptible threshold. Every interaction must feel instant. Extensions use the same form, action-panel and navigation primitives, so third-party UI looks native ([secondary analysis](https://blakecrosley.com/de/guides/design/raycast)) | A latency budget is a design token. Shared primitives keep surfaces consistent |
| **The Browser Company (Arc / Dia)** | A prototype-driven culture: ideas get iterated in 1 to 2 days until they feel good. They found that "what we thought would be cool and what turns out to be cool when using it every day barely overlaps", and early prototypes often felt awful. They prefer fingerprints over consistency ([Dive Club: fingerprints](https://dive-club.beehiiv.com/p/fingerprints); [Behind the Craft, Josh Miller](https://creatoreconomy.so/p/josh-miller-inside-ai-browser-product)) | Dogfood daily before polishing. Give each product one signature detail (its "fingerprint") |
| **Stripe** | **Friction logs**: a teammate takes on a persona and goal, then writes a stream of consciousness of every step, logging joys as well as pain. The log is sized S/M/L, objective in tone, and illustrated with screenshots ([developerrelations.com guide](https://developerrelations.com/guides/an-introduction-to-friction-logging); [Pragmatic Engineer on Stripe](https://newsletter.pragmaticengineer.com/p/stripe-part-2); [Lenny's, David Singleton](https://www.lennysnewsletter.com/p/building-a-culture-of-excellence); [sbensu's friction log notes](https://bensu.notion.site/Friction-logs-d6e0cf603a59493681ed6c1365ede16f)) | Write a friction log per product per release, especially for first-run and error paths |
| **Teenage Engineering** | Constraints as creative force. A "no fuzz" approach: as little design as possible, simple geometry, a basic palette, and a limited feature surface that is learnable by touch ([heyupnow essay](https://heyupnow.com/en-ca/blogs/heyup-trend-insight-lab/exploring-teenage-engineering-s-consumer-design-philosophy-in-2024); [dev.to on constrained interfaces](https://dev.to/james_lin/why-a-30-teenage-engineering-sale-is-really-about-constrained-interfaces-not-coupon-season-1gh4)) | Fits all three specs, which already pick one accent and instrument metaphors. Cut features before adding chrome |
| **Cultured Code (Things 3)** | Took years between majors to get every detail right, won two Apple Design Awards, and keeps content front and center with adaptive to-dos ([MacStories review](https://www.macstories.net/?p=48965)) | Take longer on the core loop rather than add breadth |
| **Zed** | Performance is the brand: GPUI renders every frame on the GPU, with a 120 fps target and frame-pipeline work published as blog posts ([zed.dev/blog/tagged/performance](https://zed.dev/blog/tagged/performance)) | Publish your performance budgets, and show speed in the launch video (real time, no speed-ramps) |
| **Warp** | Product principles: meet developers where they are, keep keyboard power but fix the UI, deliver a great out-of-the-box experience, build for speed ([warp.dev/blog/how-we-design-warp-our-product-philosophy](https://www.warp.dev/blog/how-we-design-warp-our-product-philosophy), 2021) | Argus and orchestral live in terminals, so they should honor existing muscle memory |
| **Figma** | Craftsmanship is a core engineering value; the company published "Practice", a book on craft, at Config 2025 ([figma.com/blog/the-making-of-practice](https://www.figma.com/blog/the-making-of-practice/)); an annual Maker Week ([paraform](https://www.paraform.com/blog/how-figma-s-hiring-strategy-reinforces-their-culture-and-product)) | Set aside time for play as well as polish |

### A.2 What they do differently, as repeatable mechanics

1. **One person owns from pixels to production** (the design-engineer model). For us, the agent plus the user play that role. The DESIGN.md is the sketch and the running build is the review medium. Review a live preview or a 20-second clip, never a static mock.
2. **Prototype the feel, not the layout.** Settle motion, latency and keyboard flow in a throwaway build within 1 to 2 days (`ce-prototype`), then design the chrome.
3. **Polish has a calendar slot.** Use a Linear-style weekly polish pass with a `quality` label. Agents can run the A.3 checklist and file one fix per surface per week.
4. **Bugs are SLA'd, not backlogged.** Fix or close them. Never let them wait.
5. **Friction logs at every release**, covering first run, the error path, and a return visit after a week away.
6. **Taste is written down.** Encode it in an agent-auditable checklist (Vercel's guidelines and Emil's skill both do this). Section A.3 is that list for our products.
7. **Performance is part of the design spec**, with budgets in the DESIGN.md (Pace's section 9.2 already does this; Argus and orchestral should add them).
8. **Every release ships a changelog entry with real media**, so the launch-kit pipeline in Part C pays for itself weekly, not just at launch.

### A.3 QUALITY BAR CHECKLIST (run on every screen, CLI command and comment template)

Each item is pass/fail. A screen ships only when every **P0** passes, and it needs 90% of the
whole list for "supreme". Tags: [W] web UI, [T] terminal/TUI/CLI, [G] GitHub comment/markdown, [D]
desktop overlay (wisp). Items without a tag apply everywhere.

**1. Purpose and hierarchy**
- [ ] P0. The screen's single job fits in one sentence, and the primary action is visually primary (Argus: cobalt; Pace: signal; orchestral: ink fill).
- [ ] P0. Squint test: blur to 4 px and you can still tell headings, numbers and the primary action apart.
- [ ] Operator litmus: headings, labels and numbers alone tell the story (from `design-research.md` 4.5).
- [ ] At most one accent use per viewport beyond focus rings. Status color never decorates.

**2. The five states** (each must be designed, not left as default)
- [ ] P0. **Empty**: explains what will appear here, why it is empty, and gives one action (for example orchestral's "rests", Pace's stopped dial, an Argus "no PRs reviewed yet" with an `init` command).
- [ ] P0. **Loading**: under 100 ms, show nothing. From 100 ms to 1 s, show a skeleton matching the final layout (no spinner, no layout shift). Over 1 s, show progress with a real meaning (steps or a determinate bar). Over 10 s, show elapsed time plus what is happening plus a cancel option.
- [ ] P0. **Partial**: some data loaded and some failed. Show what you have and flag the gap inline, never a blank page.
- [ ] P0. **Error**: see section 3.
- [ ] **Success / done**: confirm in place with an undo window where reversible (toast with Undo, 5 to 8 s, pauses on hover/focus).
- [ ] **Overflow**: test with 0, 1, typical, 1,000+ and very long strings (model IDs, branch names, emails). Truncate with a full-value tooltip or copy. Use `min-width: 0` on flex children.

**3. Error handling UX**
- [ ] P0. **Human-readable**: what happened, what it means for you, and what to do next (Pace voice rule, NN/g "recognize, diagnose, recover", [nngroup](https://www.nngroup.com/videos/efficient-error-messages/), [uxtigers heuristic 9](https://www.uxtigers.com/post/heuristic-9-error-messages)). No bare status codes, stack traces, slugs or vendor names for members. Put technical detail behind a "Details" disclosure with a copy button and a request ID.
- [ ] P0. **Inline validation**: validate on blur (not every keystroke), re-validate on input once an error has shown, and clear the error as soon as it is fixed. On submit, focus the first invalid field and announce it via `aria-live`. Keep the user's input. Never clear a form on error.
- [ ] P0. **Recoverable by default**: every error offers a next action (Retry, Edit, Reconnect key, Open settings, Copy diagnostics). A dead end is a P0 failure.
- [ ] P0. **Retry semantics**: transient failures (network, 5xx, 429) auto-retry with exponential backoff plus jitter (for example 1 s, 2 s, 4 s, max 3), then show a manual Retry. Retried actions must be idempotent (idempotency key on POSTs that cost money or post comments, which is critical for Argus posting PR comments and orchestral launching paid runs).
- [ ] P0. **Rate limits (429) and provider quota**: say which limit (for example "OpenRouter rate limit"), when it resets (countdown from `Retry-After`), and what continues working. For BYOK products, separate "your key is out of credit" from "the provider is down" from "our bug".
- [ ] P0. **Budget and cost guards** (Argus, orchestral): before any spend over a threshold, show the estimate and the remaining cap (orchestral's $50/mo key). When the cap is hit, the error names the cap, the spend to date and how to raise it.
- [ ] **Offline / disconnected** [W][D]: detect it (`navigator.onLine` plus failed fetch), show a persistent unobtrusive banner, queue or disable writes with an explanation, and auto-resume on reconnect with "Back online" plus a resync. For live streams (observatory SSE, wisp state), show a "Reconnecting… (attempt 3)" status, never a frozen UI that looks live.
- [ ] **Stale data** is labeled ("Updated 4 min ago", with a refresh).
- [ ] **Permission / auth expiry**: re-auth in place (modal or redirect back to the exact state), keeping unsaved work.
- [ ] **Destructive actions**: prefer undo to confirm. If you must confirm, name the object and its consequence ("Delete 3 runs ($1.84 of results)"). Never use "Are you sure?".
- [ ] [T] CLI errors: one-line summary in red or with the failed glyph, then the cause, then a fix command on its own line ready to copy. Exit codes are documented. `--json` errors are machine-readable with a stable `code`.
- [ ] [G] GitHub comment errors: the sticky comment degrades to an honest lane status (Argus "inconclusive" or "unavailable" glyph) with a reason, never a silent omission.
- [ ] 404 / unknown route has the brand state glyph, search and a way home.

**4. Interaction and motion**
- [ ] P0. Every interactive element has hover, active/pressed, `:focus-visible`, disabled and loading states. Disabled controls say why (tooltip or helper text).
- [ ] P0. The submit button stays enabled until the request starts, then shows an inline spinner with "Saving…" and blocks double-submit.
- [ ] Motion only on `transform`/`opacity`. UI durations 120 to 240 ms (under 300 ms). No animation on high-frequency or keyboard-repeat actions. Interruptible. `prefers-reduced-motion` honored. Never `transition: all` ([Vercel guidelines](https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md), [Emil](https://emilkowal.ski/ui/great-animations)).
- [ ] Optimistic UI for cheap reversible writes, with rollback plus an inline error if the server rejects.
- [ ] Each product's signature motion (Argus blink-to-state, orchestral staff ticks, Pace stop-to-go sweep, wisp ember) appears only where it carries state.
- [ ] Hit targets are 24 px or larger (WCAG 2.5.8), with no dead zones between checkbox and label.

**5. Performance as design** (budgets go in each DESIGN.md)
- [ ] P0. Input latency under 50 ms for local actions (Raycast bar), and route change under 100 ms perceived (skeleton or prefetch).
- [ ] 60 fps scroll on lists of 1,000+ rows (virtualize over 50 visible). No layout reads in render loops.
- [ ] LCP under 2.0 s and CLS under 0.05 on the marketing and hosted surfaces. Fonts subset and preloaded, with size-adjusted fallbacks (zero swap shift).
- [ ] [T] CLI cold start under 300 ms to first output. Long operations stream progress.
- [ ] [D] wisp overlay first paint within one frame of the hotkey.

**6. Keyboard and accessibility**
- [ ] P0. Every action can be reached by keyboard in a logical order, focus is never lost after a dialog closes or a list refreshes (Argus's poll fingerprinting is the model), and focus is never obscured by sticky UI (WCAG 2.4.11).
- [ ] Cmd/Ctrl+K palette and shortcut hints in tooltips and menus, and `?` opens a shortcut sheet.
- [ ] P0. WCAG 2.2 AA contrast in both themes. Status uses shape plus color (Argus eye glyphs, orchestral Okabe-Ito).
- [ ] `aria-live="polite"` for async results and streaming status, without announcing every token.
- [ ] URL reflects state (filters, tabs, selected run) and is deep-linkable. Back and forward work.

**7. Writing and copy**
- [ ] P0. Sentence case, active voice, specific verbs on buttons ("Post review", not "Submit"). No "seamless/unleash/supercharge/AI-native". No em or en dashes in UI text (the Pace rule, adopted across products).
- [ ] Numbers are specific, tabular and unit-labeled ("$0.000479", "3 waiting", "1.2 s").
- [ ] Use `…` in "Loading…"/"Saving…" and in truncation. Use curly quotes. Add a non-breaking space in "10 MB" and "Ctrl K".
- [ ] Agents are named by job, not "the AI". Cite provenance (model, prompt version, diff line).
- [ ] Empty-state and error copy pass a read-aloud test: it sounds like a competent colleague, not a system.

**8. Visual detail**
- [ ] P0. The screen matches the DESIGN.md tokens exactly (no stray hex, radius or shadow values). Lint for raw hex outside the token file.
- [ ] Optical alignment: icons are centered on their visual mass, and baselines align across adjacent controls.
- [ ] Adjacent buttons are the same height. The composer or editor does not jump when content changes (both are Linear Quality Wednesday examples).
- [ ] Both themes are checked by screenshot, including scrollbars, native selects, `color-scheme` and `theme-color`.
- [ ] No anti-slop tells (`design-research.md` 4.8).

**9. AI / agent surfaces** (Argus, orchestral, wisp, Pace agents)
- [ ] P0. Clear distinction between "working", "needs you" and "done/failed", and you can always see what it is doing and what it has cost so far.
- [ ] Intent preview before side effects. Audit log plus undo after.
- [ ] Streaming output never reflows content above the reading position.
- [ ] Model or provider failure falls back gracefully and says so (degraded mode), never as a silent quality drop.

**10. Ship gate**
- [ ] Friction log written for this surface (first run, error path, return visit).
- [ ] Screenshot set captured (both themes, 1440 and 390 widths, or terminal at 80 and 120 cols) and attached to the PR.
- [ ] Changelog entry drafted with real media (Part C pipeline).
- [ ] One "quality" fix filed for next week's polish pass.

---

## Part B: Launch videos on X

### B.1 What the top dev-tool launches have in common

Sources are the studies cited below, plus the publicly described launches (Linear, Warp 2.0, Raycast,
Remotion, Resend, Supabase). I did not frame-analyze these videos in this session, so treat the
style traits as category conventions, not measurements.

| Dimension | Convention (2025 to 2026) | Evidence |
|---|---|---|
| **Format** | **Dev tools go direct to demo.** The product appears within about 3 s, and there is no skit unless you accept the "skit tax" of 61 to 90+ s | Awesomic report, 250+ launches ([awesomic.com/launch-video-report](https://www.awesomic.com/launch-video-report)); [atomikgrowth formats](https://www.atomikgrowth.com/blog/the-tech-launch-video-formats-that-actually-work) |
| **Length** | Hero cut: just over 60 s for a new product, at most 90 s. Feature or changelog cut: **20 to 45 s**. Teaser: about 30 to 40 s (Raycast teaser 0:39, Dec 2025) | [Awesomic](https://www.awesomic.com/launch-video-report); [moonb.io, 12 launch videos](https://www.moonb.io/blog/product-launch-video) |
| **Founder presence** | 80% of top-decile launches show the founder on camera in the first 5 s (Flowreel index of 1,173 launches, Jul 2025 to Jun 2026). Linear keeps the UI full screen with the presenter in a corner bubble | [flowjam state of launch videos 2026](https://www.flowjam.com/blog/state-of-launch-videos-2026); [moonb.io](https://www.moonb.io/blog/product-launch-video) |
| **Teaser style** | Cropped, dark fragments of the real interface, with nothing to walk back later (Raycast). Real UI, never a mock | [moonb.io](https://www.moonb.io/blog/product-launch-video); [Raycast kinetic product motion case](https://contra.com/p/llNMeeMX-kinetic-product-motion-for-raycast-making-a-ui-feel-alive) |
| **Messaging** | "One product, one outcome." One sentence, then the demo, then one more sentence | [flowjam](https://www.flowjam.com/blog/state-of-launch-videos-2026); [Awesomic](https://www.awesomic.com/launch-video-report) |
| **Hook (0 to 2 s)** | Lead with the outcome or the problem, a bold 6 to 8 word headline, motion in frame 1. The first frame must carry meaning because autoplay shows it; the thumbnail is a separate asset | [atomikgrowth X guide, May 2026](https://www.atomikgrowth.com/blog/x-launch-video-strategy-guide-for-2026-specs-to-strategy); [launch-video skill notes](https://tessl.io/registry/skills/github/amplitude/builder-skills/launch-video) |
| **Sound** | X autoplays muted and 85%+ of feed views are muted, so **burn in all text**. Design for sound-off, but sound design still differentiates when tapped: "sound design matters more than most teams realize" | [Awesomic](https://www.awesomic.com/launch-video-report); [captions.ai, Apr 2025](https://www.captions.ai/blog-post/twitter-video-length-limit) |
| **Captions** | Captioned videos are about 33% more likely to be watched to completion. Use high-contrast, mobile-sized type, and put the product name early | [captions.ai](https://www.captions.ai/blog-post/twitter-video-length-limit); [atomikgrowth](https://www.atomikgrowth.com/blog/x-launch-video-strategy-guide-for-2026-specs-to-strategy) |
| **Aspect ratio** | X accepts 16:9, 1:1 and 9:16. **9:16 gets the Immersive viewer** (claimed up to 7x engagement for consumer). **16:9 stays the dev-tool default** because UI reads best wide and is reused on README/YouTube. 1:1 is a strong mobile-feed compromise | [atomikgrowth](https://www.atomikgrowth.com/blog/x-launch-video-strategy-guide-for-2026-specs-to-strategy); [kapwing vertical tab](https://kapwing.com/resources/how-to-post-videos-on-x-in-2025-vertical-video-tab) |
| **Distribution** | Upload natively, never as a link: 2.5x replies and 2.8x reposts. The first hour decides reach | [atomikgrowth](https://www.atomikgrowth.com/blog/x-launch-video-strategy-guide-for-2026-specs-to-strategy) |
| **Dogfooding** | Remotion's own launch video was made in Remotion | [echai.ventures](https://echai.ventures/videos/remotion-remotion-launch) |
| **Launch-week mechanics** | Resend and Supabase each run a microsite with its own art direction, one feature per day, and a daily video, post and blog | [Resend LW behind the scenes](https://www.plushcap.com/content/resend/blog/resend-launch-week-behind-the-scenes); [Supabase LW8](https://supabase.com/launch-week/8) |

**X technical specs**: MP4 H.264 + AAC-LC, max 1920x1200, 30 or 60 fps, max 25 Mbps, 512 MB,
140 s for non-Premium ([postfa.st X specs](https://postfa.st/sizes/x/video); [adaptlypost](https://adaptlypost.com/en/blog/uploading-videos-to-twitter-complete-walkthrough)).
Export a high-bitrate master, then encode a deliverable yourself so X's transcode has clean input.

### B.2 The "super techy, cool, high standard" style, made concrete

- **Pacing**: a cut or a meaningful motion event every 1.5 to 2.5 s, never a static hold over 3 s
  except the end card. Use the "stop-to-go" rhythm: a beat of stillness, then a decisive move. Avoid
  continuous floaty drift.
- **UI as hero**: the real product, rendered crisply at 2x, on a flat token-colored canvas (not
  gradients or glows). Use a "camera" that dollies into the region that matters (scale 1.0 to 1.8 or 2.5,
  spring with no overshoot, about 600 to 900 ms). Dim or blur everything outside the focus by about 30%. Crop
  aggressively and show fragments, not whole screens.
- **Cursor choreography**: an oversized synthetic cursor (about 1.5 to 2x) on eased bezier paths,
  with a click as a scale-down to 0.9 plus a ring, about 150 ms. The cursor leads the eye into the next
  zoom and causes each transition. It is "one of the cheapest high-yield motion sources" ([HyperFrames
  oversized-cursor skill](https://skills.sh/heygen-com/hyperframes/oversized-cursor)). Never record
  a real jittery cursor.
- **Kinetic type**: one statement per beat, at most 6 to 8 words, set in the product's display face
  with tight tracking. Reveal by word or line using a mask wipe or y+opacity at 40 to 60 ms stagger.
  Numbers count up in tabular mono. No serif italic accent words or gradient text (anti-slop).
- **Terminal scenes**: scripted, deterministic, in the product's terminal theme and mono font
  (Argus A12 already specifies VHS casts). Typing runs at a believable speed and output lands at once.
  Real values only (for example Argus's `$0.000000` cache hit).
- **Typography on screen**: minimum 48 px at 1080p for captions and 96 to 160 px for headlines, keeping
  a 10% safe margin and the bottom 15% clear of X's UI overlay.
- **Sound**: a minimal electronic or percussive bed at 100 to 128 BPM with cuts on the beat,
  plus UI foley (soft clicks, ticks, one whoosh per section). Silence before the reveal. Mix to
  about -14 LUFS integrated with a -1 dBTP ceiling.
- **End card**: mark plus wordmark, one line, one URL or command (`npx argus-reviewer init`), held for 2 s.
  The last frame works as a still.
- **What to avoid**: stock footage, AI avatars, emoji, fake UI, version numbers in the hero, a
  logo-first 3 s intro (the hook must come first), and music that drowns out the UI foley.

### B.3 Production tooling, with aarch64 / Asahi / Hyprland notes

| Need | Option | aarch64 status | Verdict |
|---|---|---|---|
| **Composition engine** | **Remotion 4** (React, DOM, declarative frame-based) ([docs](https://www.remotion.dev/docs/miscellaneous/chrome-headless-shell)) | **Verified working** (Chrome Headless Shell linux-arm64, CPU only, no GPU path on arm64). The official agent skill is `npx skills add remotion-dev/skills` ([remotion.dev/docs/ai/skills](https://www.remotion.dev/docs/ai/skills)). License is **free for individuals and companies of 3 or fewer people**; the Company license is $25/seat/mo (Creators) ([remotion.dev/docs/pricing](https://www.remotion.dev/docs/pricing)) | **Pick this** |
| | Motion Canvas (imperative, canvas, live editor) / Revideo (fork; in 2026 folded into the commercial Midrender) ([pkgpulse 2026](https://www.pkgpulse.com/guides/remotion-vs-motion-canvas-vs-revideo-programmatic-video-2026); [Remotion compare](https://www.remotion.dev/docs/compare/motion-canvas)) | Canvas-only, so it cannot use real DOM UI or CSS tokens | Skip. Fine for explainer diagrams only |
| | HeyGen **HyperFrames** (HTML + GSAP scenes, Apache-2.0, agent skills) ([github](https://github.com/heygen-com/hyperframes)) | Headless-Chrome based like Remotion. Unverified here | The fallback if the Remotion license becomes a problem (Pace as a 4+ person company) |
| **Screen capture** | `gpu-screen-recorder` (Omarchy default, portal capture, `-k auto -f 60`, CPU-encoding fallback), `wf-recorder`, OBS 32, Kooha | All aarch64. No hardware encoder on Asahi, so CPU x264, which is fine on M1 Max for 1080p60 and 1440p60 | Use `gpu-screen-recorder` for live captures. Record at **2x pixel density** (internal panel at scale 2, or `chromium --force-device-scale-factor=2` at scale 1 on the ultrawide) so 2x zooms stay sharp |
| **Screen Studio equivalent** | Screen Studio is macOS-only. Linux options are Screenix and ScreenArc (auto-zoom; [alternativeto](https://alternativeto.net/software/screenarc/?p=4)), with unverified Wayland/aarch64 support | Unverified | **Build it in Remotion instead**: drive the UI with Playwright, record clean video with no cursor, emit a JSON event timeline (click targets' bounding boxes plus timestamps), and let Remotion components synthesize the cursor and camera from that JSON. Deterministic and re-renderable |
| **Terminal** | `vhs` 0.12.1 (`.tape` scripts, uses ttyd + Chromium + ffmpeg) ([github](https://github.com/charmbracelet/vhs)) | **Verified working**, but it output 25 fps despite `Framerate 60`. Use PNG-sequence output for 60 fps | Use for all terminal scenes, imported into Remotion via `<OffthreadVideo>` |
| **Vector animation** | Rive (`@remotion/rive`), Lottie (`@remotion/lottie`) ([remotion third-party](https://www.remotion.dev/docs/third-party)) | JS runtimes render in headless Chrome | Rive for the stateful marks (Argus blink, wisp ember) that are reused in-product. Otherwise use plain SVG plus Remotion springs |
| **3D logo sting** | Blender | **No Linux arm64 build** (checked mirror plus AUR) | Use **`@remotion/three`** (R3F): extrude the SVG mark, add a studio light and a 1.5 s turn. It stays in the same pipeline |
| **Captions** | `@remotion/captions` + `@remotion/install-whisper-cpp` (local, free) ([docs](https://www.remotion.dev/docs/captions/transcribing)) | whisper.cpp builds on aarch64 (wisp already runs it) | Use only if there is voiceover. Otherwise the kinetic type is the captions |
| **Fonts** | Local WOFF2 via `staticFile` + `FontFace`, or `@remotion/google-fonts` | n/a | Schibsted Grotesk, Martian Mono, Instrument Sans, IBM Plex Mono and Mona Sans are all OFL |
| **Finishing** | `ffmpeg` (loudnorm, encode, cut-downs), `gifski` for README GIFs | Installed | See C.3 |
| **Music** | Epidemic Sound (about $10/mo Creator, all rights incl. social; [paste](https://www.pastemagazine.com/article/royalty-free-music-for-creators)), Artlist (universal license PDF), Uppbeat (free tier, about $5.59/mo, claims cleared; [toolradar](https://toolradar.com/alternatives/uppbeat)), Musicbed (premium) | n/a | **Uppbeat free/paid for v1** (cheapest with a clean license). Epidemic for a launch-week burst (1 month) |
| **SFX** | Kenney Interface Sounds (CC0, 100 sounds designed as a set; [godot asset lib](https://godotengine.org/asset-library/asset/794)), Sonniss GDC bundles (royalty-free commercial, 200+ GB; [cinevva guide](https://app.cinevva.com/game-assets/free-ui-sound-effects)), Freesound (check per-file CC0) | n/a | Kenney for UI foley, Sonniss for whooshes and impacts. Keep a `LICENSES.md` |

### B.4 Recommended pipeline (one)

**Remotion 4 + Playwright-scripted capture + VHS + local assets, rendered on omarchy-max.**

1. **Script** (`script.md`): one sentence, beats with seconds, and on-screen text per beat. Budget a 30 to 45 s hero.
2. **Capture** (deterministic, re-runnable):
   - Web UI: a Playwright script against a seeded local build at 2x DPR, recording video (or
     high-FPS screenshots per state), plus an `events.json` of every click/type target rect and timestamp.
   - Live desktop (wisp only): `gpu-screen-recorder` region capture at 60 fps, cursor hidden.
   - Terminal: a VHS `.tape` per scene in the product's theme, as PNG-sequence or MP4.
3. **Compose** in Remotion with shared components (Part C): `KineticType`, `UIZoom` (camera from
   `events.json`), `SynthCursor`, `TerminalScene`, `MarkSting` (three.js), `EndCard`. Brand tokens come from
   each product's DESIGN.md.
4. **Sound**: lay the music bed first and snap beat markers to frames, then add foley at event
   timestamps automatically (cursor click, then the `click.wav` asset).
5. **Render** three compositions from the same scenes with responsive layout, not crops:
   `hero-16x9` 1920x1080@60, `feed-1x1` 1080x1080@60, `vertical-9x16` 1080x1920@30 (optional).
   Add a 6 to 8 s `loop` cut for README/changelog (MP4 plus a gifski GIF fallback of 3 MB or less).
6. **Finish** with ffmpeg: loudness normalize, X deliverable encode, poster frame and thumbnail.
7. **QC** with the checklist in C.4, then post natively on X with the poster frame as first frame.

Why this one: it is verified on this exact machine and needs no macOS. Every frame is code, so an
agent can author and revise it. Re-renders are free when the UI changes. It uses the products' own CSS tokens, and
the same components produce changelog clips weekly. Cost: $0 under Remotion's individual license.

### B.5 Per-product video concepts (30 to 45 s, 60 fps, silent-first)

#### Argus: "The witness" (40 s)
- **Look**: graphite `#0C0E12` canvas, cobalt `#2343F5` used only on the mark and the one primary
  moment. Schibsted Grotesk headlines, Martian Mono for every number. The eye-state glyphs are the
  motion vocabulary (scan, blink-to-state).
- **Hook (0 to 2.5 s)**: a black frame, then the Argus eye opens (blink-to-state, 260 ms). Headline
  in kinetic type: **"Every PR gets a witness."**
- **Beats**
  1. 2.5 to 7 s. Terminal (VHS): `npx argus-reviewer init`, with the "What runs and what it costs" block
     landing. Type: "Your keys. Your models. Your runner."
  2. 7 to 15 s. A GitHub PR page (real render of the sticky comment, A11 hero). The camera dollies into the
     four lanes. Each lane's eye scans, then blinks to its state: passed, failed, caution,
     *inconclusive*. Type: "Four lanes. Honest when unsure."
  3. 15 to 22 s. Zoom to an inline review comment anchored to a diff line. The synthetic cursor hovers
     the provenance (model ID plus prompt version in mono). Type: "Every finding cites its source."
  4. 22 to 30 s. The cost ledger: a tally tick rolls `$0.000479`. Cut to a re-run on a cache hit and the
     number rolls to **`$0.000000`**. Type: "Re-reviews cost nothing."
  5. 30 to 36 s. Quick cuts (1.2 s each) of the HTML evidence report, `watch` TUI and Check run text, all
     in the same tokens. Type: "One witness, every surface."
  6. 36 to 40 s. End card: eye mark into the wordmark, then `npx argus-reviewer init`, then the repo URL.
- **Custom assets**: Rive or SVG eye-state glyph set with scan and blink animations, a VHS tape set
  (Argus A12), a seeded demo repo with a real PR, an HTML sticky-comment render at 2x, a Martian Mono
  tally-roll component, and SFX (a soft shutter for blink, a register tick for cost).

#### orchestral: "The Score" (45 s)
- **Look**: **paper** canvas `#F7F8F8`, ink `#121417`, monochrome. Color appears only as
  evidence (pass `#009E73`, fail `#D55E00`). Instrument Sans (condensed width for display) plus IBM
  Plex Mono numerals. Staff lines and the baton mark are the motion motif. Flat corners.
- **Hook (0 to 2 s)**: three staff lines draw across the frame, then the baton strikes the downbeat
  (the mark forms). Headline: **"Which model pair is actually worth it?"**
- **Beats**
  1. 2 to 8 s. Kinetic type over staves: "Orchestrator plans. Worker plays. We grade both." The words sit
     on the staff lines like notes.
  2. 8 to 18 s. Run detail timeline (real observatory UI, paper theme). The camera tracks the
     orchestrator lane and worker lanes over time like a score. Tool calls tick in, and the
     cost-to-date meter counts in mono.
  3. 18 to 26 s. The two axes: a mechanical pass tick (green note) and a judge score of 0.82 (with
     "advisory" label). Type: "Mechanical truth. Judge opinion. Never mixed."
  4. 26 to 35 s. Leaderboard strip plot: pairings as lanes, replicate outcomes as ticks. The camera
     settles on the winner, and cost per pass highlights. Type: "Cheapest pair that passes, with the sample size."
  5. 35 to 41 s. A published card (1200x675) slides in, the real artifact. Type: "Publish the receipts."
  6. 41 to 45 s. End card: baton mark plus wordmark on paper, then the install line or repo.
- **Custom assets**: an animated staff/baton mark (SVG, R3F optional for an engraved 3D sting), a seeded
  `runs/` fixture so no paid calls happen during capture, Playwright scripts for the observatory, a
  number-roll component in Plex Mono, and SFX (a pencil tick on staff notes, a soft timpani on the downbeat;
  avoid literal orchestral music because it is a cliché. Use a sparse pulse instead).

#### Pace-Server: "Master Clock" (35 s)
- **Look**: porcelain `#F3F4F3` / `#FCFCFB`, graphite ink `#16181A`, **signal vermilion
  `#D33C11`** only for "go / now". Mona Sans (expanded width for display) with tabular numerals. The
  motion rule is Hilfiker's **stop-to-go**: things wait about 1.5 s, then jump decisively. Use the
  60-tick rail for progress.
- **Hook (0 to 2 s)**: an SBB-style dial whose red disc second hand pauses at 12, and on the jump the
  frame cuts to an itemized wall of 11 SaaS logos rendered as neutral grey bills (no third-party marks;
  use generic labeled lines). Headline: **"11 tools. 11 bills. 11 logins."**
- **Beats**
  1. 2 to 8 s. The receipt (Instrument plate 2, "One bill") collapses line by line into one line:
     "$311.40 / mo". Type: "One company cloud."
  2. 8 to 16 s. The app shell: the sidebar, then the launcher grid of the 16 app glyphs drawn on the dial
     keyline. The synthetic cursor opens Vault, Sign and Files in succession, each with the M3 launch transition.
  3. 16 to 23 s. Identity: "Master clock" plate. One sign-in drives every app, and the ticks on
     the 60-tick rail fill as each app syncs. Type: "One identity. Every app in sync."
  4. 23 to 29 s. Agents by job: "Pace Guard flagged 3 shared passwords" toast, with the baton glyph
     working, then resolved. Type: "Agents with job titles, not magic."
  5. 29 to 35 s. End card: Pace mark (P with signal disc), wordmark, "Private cloud for 20 to 50 person
     teams", and the waitlist URL. The second hand completes the minute.
- **Custom assets**: an animated SBB-style dial (SVG, stop-to-go timing), the Pace mark plus 16 app
  glyphs (A1 to A3), Instrument plates 1 to 3 (A8) animated on reveal, a seeded demo tenant (no real
  customer data; `VITE_E2E_BYPASS_AUTH=true` build), and SFX (a clock tick plus a relay "clunk" on each jump).
  **Do not show real vendor logos** (trademark), and keep copy within the Pace voice rules (no dashes).

(wisp, for completeness: a 9:16 or 1:1 live desktop capture of `Super+D`, the ember listening, the ghost
cursor acting. It is the one product where live screen capture plus the real cursor is the point, so it
uses `gpu-screen-recorder` footage inside the same Remotion frame.)

---

## Part C: `launch-kit` spec (do not create yet)

### C.1 Repo and folder structure

Make it a standalone repo `duketopceo/launch-kit` (create via `~/bin/gh-new-repo`, private until the first
launch). It is a single Remotion project (bun workspace) with brand packages per product.
Product repos stay clean: they only expose a `demo/` capture script and fixtures.

```
launch-kit/
  package.json              # remotion, @remotion/{cli,three,rive,lottie,captions,google-fonts}, zod
  remotion.config.ts        # concurrency, codec defaults, chrome-headless-shell pinned
  .agents/skills/           # remotion-dev/skills (npx skills add remotion-dev/skills)
  AGENTS.md                 # rules: tokens only from brands/, no emoji, no stock, QC gate
  LICENSES.md               # every music/SFX/font file + license + source URL
  src/
    Root.tsx                # registers every <product>/<video>/<aspect> composition
    core/                   # shared, brand-agnostic components
      tokens.ts             # Brand type (zod): colors, fonts, motion, radii, glyphs
      timing.ts             # fps=60, beat grid helpers, bpm->frames, springs (no-overshoot, snappy)
      layout.ts             # aspect-aware safe areas (16:9, 1:1, 9:16), X UI overlay margin
      KineticType.tsx       # word/line mask reveal, stagger, count-up numerals (tabular)
      UIZoom.tsx            # camera: scale/translate keyed to events.json rects, focus dim
      SynthCursor.tsx       # oversized cursor, bezier paths, click ring, hover states
      TerminalScene.tsx     # frame for VHS footage or code-typed terminal, theme from brand
      ScreenFrame.tsx       # crisp 2x UI plate, no fake chrome unless brand specifies
      MarkSting.tsx         # SVG draw-on + optional three.js extrude (Blender replacement)
      EndCard.tsx           # mark + wordmark + one line + command/URL
      Captions.tsx          # @remotion/captions renderer (only when VO exists)
      Sfx.tsx               # auto-place foley at event timestamps
    brands/
      argus/   tokens.ts  fonts/  marks/  glyphs/ (eye states .riv/.svg)  sfx/
      orchestral/ ...  (paper + stage themes)
      pace/    ...  (dial, plates, app glyphs)
      wisp/    ...  (ember, Omarchy theme import)
    videos/
      argus/launch/   Scene01Hook.tsx ... index.tsx  script.md  storyboard.md
      argus/changelog/<yyyy-mm-dd>-<slug>/          # weekly 6-20s clips
      orchestral/launch/ ...
      pace/launch/ ...
  capture/
    argus/      tapes/*.tape  playwright/*.ts  fixtures/ (seeded repo/PR)
    orchestral/ playwright/observatory.ts  fixtures/runs/ (copied, no keys)
    pace/       playwright/shell.ts  fixtures/tenant.json
    wisp/       gsr-record.sh
    lib/        recordWithEvents.ts  (Playwright -> video + events.json)
  public/                   # staticFile() root; generated captures land here (gitignored, LFS for finals)
    captures/<product>/<scene>/{video.mp4,frames/,events.json}
    audio/{music,sfx}/
  scripts/
    capture.sh <product>    # runs tapes + playwright, writes public/captures
    render.sh <product> <video> [aspects]
    finish.sh <in> <out-prefix>   # ffmpeg loudnorm + X/README deliverables + poster
    qc.sh <file>            # ffprobe specs, loudness, black/freeze detection
  out/                      # gitignored renders
```

**Brand token source of truth**: each product's DESIGN.md front matter (Argus already has YAML
colors). Add `scripts/sync-tokens.ts` to read `../<repo>/DESIGN.md` YAML, or
`@google/design.md export` DTCG JSON, into `brands/<p>/tokens.ts`, so videos never drift from the product.

### C.2 Asset pipeline steps

1. **Tokens**: `bun scripts/sync-tokens.ts argus` produces `brands/argus/tokens.ts` (validated by zod).
2. **Brand assets**: copy the final SVG mark, wordmark and glyphs from the product repo (outlined, svgo'd,
   per `design-research.md` 3.1), and self-host the fonts as WOFF2 in `brands/<p>/fonts/`.
3. **Fixtures**: seed deterministic data (demo repo/PR, `runs/` copy, demo tenant) with **no API keys
   in env**, so captures cost $0 and are reproducible.
4. **Capture**: `scripts/capture.sh argus` runs the VHS tapes into PNG sequence or MP4 and the Playwright scripts at
   2x DPR into `video.mp4` plus `events.json`. wisp uses `gpu-screen-recorder -w region -f 60 -k h264`.
5. **Script and storyboard**: `videos/<p>/launch/script.md` (beats, seconds, on-screen text) is reviewed
   by the user before compose.
6. **Compose** in Remotion Studio (`bunx remotion studio`). Agents edit scenes with the Remotion skill loaded.
7. **Audio**: place the music bed with a beat map, then `Sfx.tsx` auto-places foley. Log every file in `LICENSES.md`.
8. **Render** with `scripts/render.sh argus launch 16x9,1x1` to ProRes 422 HQ or high-CRF H.264 masters:
   `npx remotion render src/index.ts argus-launch-16x9 out/argus-launch-16x9.mov --codec=prores --prores-profile=hq`.
9. **Finish** with `scripts/finish.sh`:
   - loudness: `ffmpeg -i in.mov -af loudnorm=I=-14:TP=-1:LRA=11 ...`
   - X deliverable: `-c:v libx264 -profile:v high -pix_fmt yuv420p -preset slow -crf 18 -maxrate 20M -bufsize 40M -r 60 -c:a aac -b:a 192k -movflags +faststart`
   - README loop: 6 to 8 s, `-an`, 960 px wide MP4 plus a `gifski --fps 30 --width 960` fallback of 3 MB or less
   - poster/thumbnail: `-ss <t> -frames:v 1` PNG at 1920x1080 and 1200x675 (also the OG and changelog hero)
10. **QC** (C.4), then post natively on X, upload to the GitHub README (video upload), and add to the changelog.

### C.3 Render budget on this machine
The 1080x1080@60 smoke test took 13.8 s for 60 frames, including about 5 s of bundling. Scenes with
real UI, video and three.js will be slower. Estimate 2 to 6 minutes per 45 s cut at 1080p60 on CPU
with `--concurrency` near 8 (10 cores). That is fine locally, and no cloud render (Lambda) is needed.

### C.4 Video QC checklist (gate before posting)
- [ ] The product (real UI) is visible within 3 s, and the hook headline reads in under 2 s with sound off.
- [ ] All meaning is carried by on-screen text. Muted playback is complete.
- [ ] Text is at least 48 px at 1080p, inside the safe area, with the bottom 15% clear for X overlays. Checked on a phone at 1:1 and 16:9.
- [ ] Only real UI and real numbers from seeded fixtures. No vendor logos without permission. No secrets, notifications or personal tooling in frame (Argus F1 lesson).
- [ ] Tokens match the DESIGN.md. No emoji, gradients, glows or stock footage.
- [ ] Motion: no static hold over 3 s before the end card, springs without overshoot on the UI camera, and the cursor never jitters.
- [ ] Audio: -14 LUFS / -1 dBTP, foley in sync within 1 frame, every asset logged in LICENSES.md.
- [ ] Specs: H.264 High, yuv420p, AAC 48 kHz, 60 fps, 1920 px or less on the long edge, 20 Mbps or less, `faststart`, under 140 s (`scripts/qc.sh` via ffprobe plus `blackdetect`/`freezedetect`).
- [ ] The first frame is meaningful as an autoplay still, and a separate thumbnail is exported.
- [ ] The end card shows one command or URL and is held for 2 s or more.

---

## Sources (primary, by part)
- Part A: linear.app/now/quality-wednesdays; linear.app/now/zero-bugs-policy; linear.app/blog/startups-write-changelogs;
  vercel.com/blog/design-engineering-at-vercel; raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md;
  emilkowal.ski/ui/great-animations; construkt.beehiiv.com/p/invisible-details-interaction-design;
  dive-club.beehiiv.com/p/fingerprints; creatoreconomy.so/p/josh-miller-inside-ai-browser-product;
  developerrelations.com/guides/an-introduction-to-friction-logging; newsletter.pragmaticengineer.com/p/stripe-part-2;
  zed.dev/blog/tagged/performance; warp.dev/blog/how-we-design-warp-our-product-philosophy;
  figma.com/blog/the-making-of-practice; nngroup.com/videos/efficient-error-messages
- Part B: awesomic.com/launch-video-report; flowjam.com/blog/state-of-launch-videos-2026;
  atomikgrowth.com/blog/x-launch-video-strategy-guide-for-2026-specs-to-strategy; moonb.io/blog/product-launch-video;
  postfa.st/sizes/x/video; remotion.dev/docs/miscellaneous/chrome-headless-shell; remotion.dev/docs/pricing;
  remotion.dev/docs/ai/skills; remotion.dev/docs/captions/transcribing; remotion.dev/docs/third-party;
  pkgpulse.com/guides/remotion-vs-motion-canvas-vs-revideo-programmatic-video-2026; github.com/heygen-com/hyperframes;
  github.com/charmbracelet/vhs; mirror.blender.org/release/Blender5.2/ (no linux-arm64); skills.sh/heygen-com/hyperframes/oversized-cursor
- Local verification: `scratchpad/remotion-smoke/` (Remotion 4.0.532 + Chrome Headless Shell 149 linux-arm64; vhs 0.12.1).
