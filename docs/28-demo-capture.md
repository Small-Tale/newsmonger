# 28 — Demo Capture (the hero and the stills)

**Status: shipped.** The animated hero (NEWS-212) and the inline screenshots (NEWS-214) are both built and both regenerate from the running app.

The README's images are **photographs of the real application**, produced by driving the live UI with Playwright. Nothing in them is mocked up in a design tool, and that is the whole point: a screenshot that is assembled by hand is accurate on the day it is made and slowly becomes a lie, with nothing to catch it. These cannot drift from the product without the capture script breaking.

## The two pipelines, and why they are two

| | Hero | Stills |
|---|---|---|
| Script | `scripts/demo/capture-demo.ts` | `scripts/demo/capture-stills.ts` |
| Command | `npm run demo:capture` | `npm run demo:stills` |
| Output | `assets/demo.svg` + `.svgz` | `assets/stills/<scene>.png` + `.svg` |
| Shape | one animated, chrome-wrapped artifact, six beats, crossfades + one wipe | one flat image per feature, no chrome, no composition |

- **FR-28.1** *(Shipped)* They are **separate scripts on purpose.** The hero is a composed narrative — window chrome, captions, timing, transitions, an end card. The stills are single frames of individual features. Merging them would make every still carry the animation machinery and every hero beat carry the still machinery, for one shared `spawn` call. Glassbox keeps the same split for the same reason.
- **FR-28.2** *(Shipped)* Both run the app in **`--demo` mode**, which serves the fixture stories in `src/demo.ts` (FR-4.x). `--demo` implies `--ai-test`: no real AI call, no network, no lead-image fetching.

## Rules both pipelines follow

- **FR-28.3** *(Shipped)* **The port is read from the server's own readiness line**, never assumed. An early version of the hero hardcoded a port with `--strict-port`; a stray process was already on it, our server died with `EADDRINUSE`, and the capture carried on and photographed *whatever else was answering there*. Reading the URL the spawned process prints means it can only ever talk to the process it started. (The `running at ` marker is shared with `src-tauri/src/lib.rs` — see the note in `CLAUDE.md`.)
- **FR-28.4** *(Shipped)* **Never the real data directory.** Each run gets a fresh `mkdtemp` directory, because the capture creates topics and runs checks. Asserted by a unit test rather than left to care.
- **FR-28.5** *(Shipped)* **State is reached through the real UI or the real HTTP API**, never by writing to the database behind the server's back — topics are added with `POST /api/topics`, stories arrive from the check that firing that endpoint triggers (FR-1.12).
- **FR-28.6** *(Shipped)* **Trees are captured live and rendered to SVG after teardown.** domotion's macOS glyph-path extraction is flaky under contention and falls back *silently* to CSS `<text>`, which renders as tofu on any machine without the font. Rendering once the browser and server are gone makes it reliable, and an **`@font-face` assertion** on the output is what stops a silent regression.
- **FR-28.7** *(Shipped)* Both must run **outside the command sandbox** — Chromium needs Mach ports.

### The dark-mode beat (NEWS-263)

- **FR-28.16** *(Shipped, NEWS-263)* The hero ends its walkthrough by **switching to dark mode**, revealed by a left-to-right **wipe** rather than the crossfade every other beat uses.

  The wipe is the point, not decoration. The dark frame is captured at the *same scroll position and state* as the beat before it, so the two frames differ only in palette — and a crossfade between two identical layouts in different colours reads as one picture dimming, not as a theme changing. A wipe reads correctly precisely because the geometry underneath does not move. Anything that shifts between the two frames turns a theme switch into a scene change, so that beat must not scroll, click, or wait for new stories.

  Reached with `page.emulateMedia({ colorScheme: 'dark' })` because there is no theme toggle to click — the app follows `prefers-color-scheme` (FR-3.7), so emulating the media query *is* how a user gets there. `Beat.transition` is per-beat for this one case; everything else falls back to the shared crossfade.

  Two things checked while building it, worth not re-deriving: domotion renders the wipe as a `clip-path: inset(...)` keyframe (`@keyframes fr-<n>`), and `optimizeSvg` rewrites `inset(0 100% 0 0)` to `inset(0 100%0 0)` — which **is** still valid, because `%` terminates the percentage token. Verified in Chromium rather than assumed; both forms compute to `inset(0px 100% 0px 0px)`.

### The backup offer had to be suppressed (NEWS-263)

- **FR-28.17** *(Shipped, NEWS-263)* Both pipelines `PATCH /api/settings { backupPromptNever: true }` before driving the UI.

  The backup offer appears once a third topic exists (FR-27.4) and opens a modal whose backdrop swallows every click. `DEMO_TOPICS` has exactly three, so **the hero capture was broken**: the discover beat spent 30 seconds retrying a click against an invisible interceptor and the script died. Nothing caught it, because the capture is manual and run rarely — the same "no test, so it rotted" shape as the dock bounce in NEWS-261.

  Set through the real settings API rather than by dismissing the dialog, per FR-28.5 — this is the state a user who chose "don't ask again" is in. The stills were unaffected in practice but do it too, since they are one topic away from the same trap.

## The stills (NEWS-214)

- **FR-28.8** *(Shipped)* Seven scenes: `feed`, `topics`, `discover`, `tuner`, `review`, `settings-source`, `export`. Each is declared in one `SCENES` array with its name, its alt text, the navigation that reaches it, and optionally a crop.
- **FR-28.9** *(Shipped)* Every scene produces **both a PNG and a stand-alone SVG**. The README embeds the PNG; the SVG is crisp at any zoom and — the real reason to keep it — **diffable**, so a text diff shows what actually changed in the UI. No scene is PNG-only, because `--demo` implies `--ai-test` and no lead images are ever fetched.
- **FR-28.10** *(Shipped)* **One server, one data directory, per scene.** Scenes mutate real state — flagging a story off-topic, promoting a topic — so a shared server would make each screenshot depend on which scenes ran before it, and reordering the array would silently change the pictures. A few seconds per scene buys the property that any scene can be run, reordered or removed on its own.
- **FR-28.11** *(Shipped)* **Which topics are followed is per scene.** Discovery only ever suggests topics you are *not* already following, so the two discovery scenes hold one back; without that they photograph an empty result.
- **FR-28.12** *(Shipped)* **Crops are CSS selectors resolved at capture time**, not pixel rectangles. A hardcoded rectangle rots the moment the layout moves, and does it *silently* — the crop still succeeds, it just frames the wrong thing. Used for the topics sidebar (a fifth of a 1440px frame) and the export dialog (which opens over Settings → Data, so the full frame shows it stacked on another dialog).
- **FR-28.13** *(Shipped)* **Section and subject labels come from `BUILTIN_CATEGORIES`**, not from the demo topics' own `category`/`subcategory` strings. Those are free-text hints for the classifier and do not all name real chips — a fixture says `Climate`, the taxonomy says `Climate & Environment` — so clicking them by name finds nothing.
- **FR-28.14** *(Shipped)* **The README's alt text and the scene's alt text must be identical**, enforced by `tests/unit/stills.test.ts`. It also fails on a scene with no captured file, a captured file belonging to no scene (what a rename leaves behind), and a README `<img>` pointing at a file that does not exist. None of those break a build on their own; all of them ship a README with a hole in it.

- **FR-28.15** *(Shipped, NEWS-232)* A scene can declare a **soak** — a check interval and a minimum elapsed time — for state that only exists after time passes. The `topics` scene uses it: the next-check ring drains from full over the interval, so a topic checked moments ago shows a *full* ring, and every scene would otherwise get one, since adding a topic checks it immediately (FR-1.12).

  A soaking scene's server starts **before** the others and it is photographed **after** them, so the wait overlaps work that has to happen anyway. Be honest about the size of that: the other six scenes take about 15 seconds between them, so a two-minute soak still costs ~105 seconds of real waiting. It is the cheapest option, not a free one — the alternatives were a demo-only way to backdate `lastCheckedAt` (a product affordance existing purely for a screenshot, writing a false timestamp) or shipping a dial that never moves.

  The soak must stay **under** the interval: at the interval the scheduler checks again and the ring resets to full. The script warns rather than silently shipping a picture of the state the scene exists to avoid.

### Review captures (NEWS-263)

- **FR-28.18** *(Shipped, NEWS-263)* `npm run demo:stills -- --review` additionally captures each scene **in dark mode** (1440×900) and **narrow** (720×1000), uncropped, to `scripts/demo/.review/<scene>-{dark,narrow}.png`.

  These exist for `/design-review` (NEWS-262), whose critique is only as good as what it can see. The demo stills are light mode at desktop width — the two conditions a critique needs *least*, because they are the ones already known to work. Dark mode is a genuinely different palette and where contrast problems live; 720px crosses the 860px one-column collapse, where composition breaks if it is going to.

  **Uncropped on purpose**: the demo crops frame one feature, and a critique is judging the whole composition, which a crop would hide.

  **Not tracked, and elsewhere.** `assets/stills/` is committed because those seven images are in the README. Review captures are throwaway inputs regenerated whenever someone looks, so tripling the repo's tracked binaries to serve them is the wrong trade. `scripts/demo/.review/` is gitignored, named after the `.debug/` directory the hero already writes to.

  **Each variant gets its own freshly prepared server**, for the reason FR-28.10 gives: a scene's `setup` mutates real state, so running it three times against one server would compound those mutations and photograph the later variants in a state the first never saw — leaving the variants differing by more than the palette, which is the one thing a theme comparison must not do. A soaking scene's variants **skip the soak**: it costs minutes and buys a drained dial, which is a demo detail rather than a design one, so the ring reads full in those.

### Not captured, and why

- ~~**A dial mid-countdown.**~~ *(Now captured — NEWS-232.)* See FR-28.15 above.
- **The terminal cast beat.** Glassbox opens its hero with a real `domotion term` recording and layers the app over its last frame (`casts.ts` + `popIn.ts`, ~260 lines). It is the most complex piece of that pipeline and buys the least here: Newsmonger's story is the app, not the CLI. Worth revisiting only if the install path becomes a headline feature.

See also: [3 — UI](3-ui.md) (the layouts being photographed), [4 — CLI, Server, and Storage](4-cli-server-storage.md) (`--demo`, `--ai-test`, the readiness line), [24 — Topic Discovery](24-topic-discovery.md) (the tuner the discovery scenes walk into).
