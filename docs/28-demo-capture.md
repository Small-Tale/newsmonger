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
- **FR-28.2** *(Shipped, revised NEWS-376)* Both run the app in **`--demo` mode**, which serves the fixture stories in `src/demo.ts` (FR-4.x). `--demo` still implies `--ai-test` — no real AI call, no network — but **no longer means no pictures**, and that convenience is why the demos shipped for months with none.

  `--ai-test` nulls the image and favicon fetchers because the mock's URLs are fictional. `--demo` inherited that wholesale, so the demo could not show a lead image or a favicon *whatever* its stories pointed at. The old fixture also linked to `example.org`, which serves neither — two independent causes for one symptom, and fixing either alone changes nothing. `cli.ts` now tests `options.demo` **before** `options.aiTest`, so the demo's own fetchers win the ternary.

## Rules both pipelines follow

- **FR-28.3** *(Shipped)* **The port is read from the server's own readiness line**, never assumed. An early version of the hero hardcoded a port with `--strict-port`; a stray process was already on it, our server died with `EADDRINUSE`, and the capture carried on and photographed *whatever else was answering there*. Reading the URL the spawned process prints means it can only ever talk to the process it started. (The `running at ` marker is shared with `src-tauri/src/lib.rs` — see the note in `CLAUDE.md`.)
- **FR-28.4** *(Shipped)* **Never the real data directory.** Each run gets a fresh `mkdtemp` directory, because the capture creates topics and runs checks. Asserted by a unit test rather than left to care.
- **FR-28.5** *(Shipped)* **State is reached through the real UI or the real HTTP API**, never by writing to the database behind the server's back — topics are added with `POST /api/topics`, stories arrive from the check that firing that endpoint triggers (FR-1.12).
- **FR-28.6** *(Shipped)* **Trees are captured live and rendered to SVG after teardown.** domotion's macOS glyph-path extraction is flaky under contention and falls back *silently* to CSS `<text>`, which renders as tofu on any machine without the font. Rendering once the browser and server are gone makes it reliable, and an **`@font-face` assertion** on the output is what stops a silent regression.
- **FR-28.7** *(Shipped)* Both must run **outside the command sandbox** — Chromium needs Mach ports.
- **FR-28.24** *(Shipped, NEWS-376)* **Every image is inlined as a `data:` URI before the server is torn down.**

  domotion serialises an `<img src>` as `<image href>` carrying the page's *absolute* URL, which here is `http://127.0.0.1:<ephemeral port>/…`. That server is gone seconds later and the port differs every run, so a committed SVG referencing one can never resolve — it renders a blank box in Preview, QuickLook, a Finder thumbnail, and anywhere the file is served from disk.

  It shipped that way for months and was easy to miss: the only remote image was the wordmark, so it was one dead link per file, in a corner. Recording real stories (FR-28.23) put a lead image on most cards and a favicon on most sources, and the defect became most of the picture.

  **The ordering is the part that will break again.** `embedRemoteImages` turns URLs into bytes and therefore needs the server *alive* — which is the opposite requirement from FR-28.6's "render the SVG after teardown", and both are load-bearing. `tests/unit/stills.test.ts` fails on any `href="http…"` in the hero or any still, matching the scheme rather than a port, so it catches the next one rather than only this one.

  `resizeEmbeddedImages` follows, at **`hiDPIFactor: 2`, which is measurably the smallest output and is not the obvious answer**. On the hero: factor 2 gives 2.8 MB, factor 1 gives 3.1 MB, and factor 1 is byte-identical to running no resize at all — the pass does not act at 1. The recorder already caps sources at 900px (2x a ~430px card), so there is little headroom left to reclaim. Re-measure before "optimising" it.

### The capture photographs the app, not the machine (NEWS-315)

- **FR-28.23** *(Shipped, NEWS-376)* **The stories are recorded from real coverage, not written.** `npm run record:demo-data` runs a real provider and the real image pipeline once, and freezes what it learned into `assets/demo-data/`: the stories, the article-URL-to-lead-image mapping, the origin-to-favicon mapping, and the image bytes. `--demo` replays that with no network, so a capture renders the same thing next month on a machine with no subscription — the same bargain `tests/fixtures/cli-sessions/` strikes, for the same reason.

  The fixture used to be invented prose with `Illustrative …` source names, on the reasoning that attributing invented reporting to a real masthead puts words in a publication's mouth. That reasoning was sound and its consequence was not: the `example.org` links meant every shipped screenshot showed a news reader that cannot display a picture. A test now asserts the recording carries lead images and favicons, and that every hash it names is committed — the property whose absence was previously invisible.

  Two honest limits, both recorded rather than smoothed over:

  - **The first/second split is staged.** A second real check minutes after the first correctly finds nothing, so the recorder deals one capture across the two, holding the newest few back. The staging is the only fiction; every headline, link, outlet, date and picture is real.
  - **Roughly a third of real articles carry no usable `og:image`**, so some cards have no picture. That is the layout the feed has to handle anyway, and a fixture demanding one everywhere would assert something the web does not provide.

- **FR-28.21** *(Shipped, NEWS-315)* **`--demo` answers `GET /api/providers` and `GET /api/keys` from a fixture**, so a still does not depend on who regenerated it. `demoProbeProviders` reports `anthropic` available and everything else not; `demoKeysResponse` reports no key configured, a working credential store, and the label `Keychain`. Both are injected into `createApp` (`probe`, `demoKeys`) rather than switched on inside the routes, and **only** `--demo` gets them — `--ai-test` keeps the real probe, because the E2E suite asserts on provider availability and a canned answer would assert nothing.

  These were the last two things in `--demo` that read the capturing machine. `assets/stills/settings-source.png` said *"ready — via Claude subscription (Claude Code)"* on the owner's laptop and would say *"no provider is signed in or keyed"* on a machine with nothing configured; the two key rows and the sentence beneath them varied the same way, and the sentence names the OS's store, so it read "System Keyring" on Linux. A tracked binary that documents the UI cannot vary with the photographer, and a public repo should not carry a small statement about what its author has signed in to.

  **It was deterministic by accident until NEWS-308**, which is the reason nothing caught it: before then the status line rendered blank on the default `auto` setting, so there was nothing to vary. The property had held for a year with nothing asserting it, and stopped holding because of a change to a different file. `tests/unit/demo-determinism.test.ts` now asserts it directly — the same request answered identically with and without `ANTHROPIC_API_KEY` exported, plus the opposite direction, that an ordinary server still reports a real key as configured.

  `anthropic` rather than a signed-in CLI because it is this project's documented default, so the screenshot shows the ordinary case; and because the status line's most informative state — `auto` resolving to a *named* provider — needs exactly one entry of `AUTO_ORDER` available. Still a probe rather than a hardcoded route response, so the picker's shape, ordering and `mock` entry stay real.

### The dark-mode beat (NEWS-263)

- **FR-28.16** *(Shipped, NEWS-263)* The hero ends its walkthrough by **switching to dark mode**, revealed by a left-to-right **wipe** rather than the crossfade every other beat uses.

  The wipe is the point, not decoration. The dark frame is captured at the *same scroll position and state* as the beat before it, so the two frames differ only in palette — and a crossfade between two identical layouts in different colours reads as one picture dimming, not as a theme changing. A wipe reads correctly precisely because the geometry underneath does not move. Anything that shifts between the two frames turns a theme switch into a scene change, so that beat must not scroll, click, or wait for new stories.

  Reached with `page.emulateMedia({ colorScheme: 'dark' })` because there is no theme toggle to click — the app follows `prefers-color-scheme` (FR-3.7), so emulating the media query *is* how a user gets there. `Beat.transition` is per-beat for this one case; everything else falls back to the shared crossfade.

  Two things checked while building it, worth not re-deriving: domotion renders the wipe as a `clip-path: inset(...)` keyframe (`@keyframes fr-<n>`), and `optimizeSvg` rewrites `inset(0 100% 0 0)` to `inset(0 100%0 0)` — which **is** still valid, because `%` terminates the percentage token. Verified in Chromium rather than assumed; both forms compute to `inset(0px 100% 0px 0px)`.

### The backup offer had to be suppressed (NEWS-263)

- **FR-28.17** *(Shipped, NEWS-263)* Both pipelines `PATCH /api/settings { backupPromptNever: true }` before driving the UI.

  The backup offer appears once a third topic exists (FR-27.4) and opens a modal whose backdrop swallows every click. `DEMO_TOPICS` had exactly three (four since NEWS-292, which only makes it fire sooner), so **the hero capture was broken**: the discover beat spent 30 seconds retrying a click against an invisible interceptor and the script died. Nothing caught it, because the capture is manual and run rarely — the same "no test, so it rotted" shape as the dock bounce in NEWS-261.

  Set through the real settings API rather than by dismissing the dialog, per FR-28.5 — this is the state a user who chose "don't ask again" is in. The stills were unaffected in practice but do it too, since they are one topic away from the same trap.

## The stills (NEWS-214)

- **FR-28.8** *(Shipped)* Eight scenes: `feed`, `topics`, `discover`, `tuner`, `review`, `thread`, `settings-source`, `export`. Each is declared in one `SCENES` array with its name, its alt text, the navigation that reaches it, and optionally a crop.
- **FR-28.9** *(Shipped)* Every scene produces **both a PNG and a stand-alone SVG**. The README embeds the PNG; the SVG is crisp at any zoom and — the real reason to keep it — **diffable**, so a text diff shows what actually changed in the UI. No scene is PNG-only. (That used to read "because `--demo` implies `--ai-test` and no lead images are ever fetched" — no longer true as of NEWS-376, though the conclusion stands on the diffability argument alone.)
- **FR-28.10** *(Shipped)* **One server, one data directory, per scene.** Scenes mutate real state — flagging a story off-topic, promoting a topic — so a shared server would make each screenshot depend on which scenes ran before it, and reordering the array would silently change the pictures. A few seconds per scene buys the property that any scene can be run, reordered or removed on its own.
- **FR-28.11** *(Shipped)* **Which topics are followed is per scene.** Discovery only ever suggests topics you are *not* already following, so the two discovery scenes hold one back; without that they photograph an empty result.
- **FR-28.12** *(Shipped)* **Crops are CSS selectors resolved at capture time**, not pixel rectangles. A hardcoded rectangle rots the moment the layout moves, and does it *silently* — the crop still succeeds, it just frames the wrong thing. Used for the topics sidebar (a fifth of a 1440px frame), the export dialog (which opens over Settings → Data, so the full frame shows it stacked on another dialog), and the expanded thread card (a detail inside one card of a two-column feed).
- **FR-28.13** *(Shipped)* **The discovery scenes click the section and subject the held-back topic actually files itself under.** The two labels are read off `BUILTIN_CATEGORIES` — those are the strings the tiles and chips render, and naming them any other way is how a walk clicks a chip that is not there — but *which* rows are read comes from that topic's own declared `category`/`subcategory` pair, resolved against the **active** table (a retired row still exists in the table and renders no chip).

  The pair has to be honoured on both levels, because the heading is the *request* and the group label is where the topic will actually file itself (FR-24.13), so a mismatch puts two contradicting labels a few pixels apart. Until NEWS-399 only the section was read from the fixture and the subject was `subcategories[0]` — a guess — which is why the shipped `discover` still shows a **"Business · Markets" heading over a group labelled "BUSINESS · OTHER"**. The UI does explain such a gap itself now, with a "closest matches" note (FR-24.12a), but that note exists for a classification the *model* placed elsewhere; spending it on a mismatch the capture manufactured is photographing our own bug. An unresolvable pair now throws rather than falling back, since a fallback is how the guess got there.

  The demo topics' strings are free-text hints for the classifier, matched by label and **dropped silently when they do not resolve** (FR-22.8). That silence is what let four of them rot: NEWS-388 moved Energy from Science to Environment and two fixtures kept claiming `Science ▸ Energy`, while `Science ▸ Climate` and `Business ▸ Technology` named rows that never existed. Repaired and pinned in NEWS-395 — `tests/unit/demo.test.ts` resolves every declared pair against the *active* taxonomy, and runs every topic through the real provider to check a subject survives, so the next taxonomy edit fails the gate rather than quietly stripping the subject off every pill in the stills.
- **FR-28.14** *(Shipped)* **The README's alt text and the scene's alt text must be identical**, enforced by `tests/unit/stills.test.ts`. It also fails on a scene with no captured file, a captured file belonging to no scene (what a rename leaves behind), and a README `<img>` pointing at a file that does not exist. None of those break a build on their own; all of them ship a README with a hole in it.

- **FR-28.22** *(Shipped, NEWS-292)* **The `thread` scene photographs a real thread**, which required a fixture that forms one. The demo's other topics are deliberately sets of *unrelated* developments — that is what makes the feed look like a feed — so the demo produced **no threads at all**, and the "story so far" timeline and the "4th update" badge (NEWS-282/283) were invisible in every README image despite being what the whole NEWS-280→283 sequence exists for.

  `Renewable energy buildout` is the one topic whose stories are one subject unfolding: sixteen instalments of the Coastal Virginia Offshore Wind project, real reporting about a real thing that really unfolded — which is what a thread *is*. The timeline is only worth photographing past `THREAD_ROW_CAP`; "Show all N stories" is half of what the pane does, and a thread at or under the cap never shows it. The scene runs a second check in `arrange`, crops to `.item.expanded`, and finds its topic **by shape** (`first + second > THREAD_ROW_CAP`) rather than by index, so reordering the fixture list cannot silently photograph the wrong topic.

  **Real coverage of a broad beat does not thread, and the recording had to be steered** (NEWS-376). The first capture returned five offshore-wind stories about five unrelated projects, and `planThreadIds` correctly made five threads of one — so the topic carries a `captureGuidance` steer, used only while recording, narrowing it to a single project's chronology.

  **The topic's name must not contain the series' own words**, and with a recorded fixture this stopped being a caution and became a rename. A topic's words are stopwords inside it (FR-29.10), and real outlets call the project "Coastal Virginia Offshore Wind" in every headline — so under a topic named `Offshore wind` the shared words "offshore" and "wind" were subtracted, leaving two, which fails the 40% ratio against headlines that long: seven stories, six threads. Renaming the topic so it does not contain them left those words in play and the *same stories, unchanged*, became one thread of seven. The old invented fixture obeyed this rule by accident, by writing its saga about "Dogger Bank" under "Offshore wind"; a recording does not get to choose what the outlets call things.

  That is also a finding about `threads.ts` itself rather than only about the demo, and it is the first real-headline evidence NEWS-286 was waiting for: the 40% ratio is what real, long, deliberately-varied headlines fail. `tests/unit/demo.test.ts` asserts all of it through `planThreadIds`, the same function the check pipeline uses: exactly one topic threads, it threads into one, it outgrows the cap, its name shares no word with its headlines, and every other topic stays entirely unthreaded. An innocent rewording is the realistic way this breaks, and it would otherwise break silently in a pipeline nobody runs.

  Scene counts are no longer `topics × 2` either — `DEMO_FIRST_CHECK_STORIES` sums the fixtures, because the arithmetic that held for three symmetric topics under-counted the moment a fourth arrived, and a capture that waits for too few stories photographs a feed still filling in.

- **FR-28.15** *(Shipped, NEWS-232)* A scene can declare a **soak** — a check interval and a minimum elapsed time — for state that only exists after time passes. The `topics` scene uses it: the next-check ring drains from full over the interval, so a topic checked moments ago shows a *full* ring, and every scene would otherwise get one, since adding a topic checks it immediately (FR-1.12).

  A soaking scene's server starts **before** the others and it is photographed **after** them, so the wait overlaps work that has to happen anyway. Be honest about the size of that: the other six scenes take about 15 seconds between them, so a two-minute soak still costs ~105 seconds of real waiting. It is the cheapest option, not a free one — the alternatives were a demo-only way to backdate `lastCheckedAt` (a product affordance existing purely for a screenshot, writing a false timestamp) or shipping a dial that never moves.

  The soak must stay **under** the interval: at the interval the scheduler checks again and the ring resets to full. The script warns rather than silently shipping a picture of the state the scene exists to avoid.

### Review captures (NEWS-263)

- **FR-28.18** *(Shipped, NEWS-263)* `npm run demo:stills -- --review` additionally captures each scene **in dark mode** (1440×900) and **narrow** (720×1000), uncropped, to `scripts/demo/.review/<scene>-{dark,narrow}.png`.

  These exist for `/design-review` (NEWS-262), whose critique is only as good as what it can see. The demo stills are light mode at desktop width — the two conditions a critique needs *least*, because they are the ones already known to work. Dark mode is a genuinely different palette and where contrast problems live; 720px crosses the 860px one-column collapse, where composition breaks if it is going to.

  **Uncropped on purpose**: the demo crops frame one feature, and a critique is judging the whole composition, which a crop would hide.

  **Not tracked, and elsewhere.** `assets/stills/` is committed because those seven images are in the README. Review captures are throwaway inputs regenerated whenever someone looks, so tripling the repo's tracked binaries to serve them is the wrong trade. `scripts/demo/.review/` is gitignored, named after the `.debug/` directory the hero already writes to.

  **Each variant gets its own freshly prepared server**, for the reason FR-28.10 gives: a scene's `setup` mutates real state, so running it three times against one server would compound those mutations and photograph the later variants in a state the first never saw — leaving the variants differing by more than the palette, which is the one thing a theme comparison must not do. A soaking scene's variants **skip the soak**: it costs minutes and buys a drained dial, which is a demo detail rather than a design one, so the ring reads full in those.

### Checked by CI, since nothing else ran them (NEWS-264)

- **FR-28.19** *(Shipped, NEWS-264)* `npm run demo:stills -- --only <scene>` captures a single scene, and CI runs `--only feed` on every push.

  The hero sat **broken** for weeks (FR-28.17) because nothing ever ran it: the captures are manual, wanted rarely, and need Chromium outside the sandbox. A deliberately *smoke*-sized run closes that — one non-soaking scene boots the real server and drives the real UI in about fifteen seconds, which is enough to catch a modal eating a click, a selector that stopped matching, or a changed readiness line. A full run is minutes, most of it the `topics` soak, and buys little more.

  Two assertions beyond a zero exit, because a script that "succeeds" while writing nothing is the failure a smoke test exists to catch: the PNG and SVG must exist and the PNG must clear 20KB (a blank frame is far smaller), and **the scenes the run did not capture must be untouched**.

  That second one is there because the first version of `--only` broke it. `main()` wipes the output directory — that wipe is what removes a renamed scene's stale file, which `stills.test.ts` fails on — and with `--only` it deleted the other six. `git status` caught it locally; CI catches it next time.

- **FR-28.20** *(Shipped, NEWS-264)* **`scripts/` is typechecked and linted** like the rest of the tree.

  It was in neither: `tsconfig.json`'s `include` covered `src` and `tests` only, and `eslint.config.mjs` listed `scripts/**` under `ignores`. So `npm run typecheck` and `npm run lint` both passed while saying nothing about the ~950 lines here — during NEWS-263 a clean `tsc --noEmit` after editing `capture-demo.ts` was completely meaningless.

  Turning it on surfaced 17 problems, and the interesting thing is that **none were bugs**:

  - **`no-unnecessary-condition` on the readiness wait.** `base` and the exit flag are assigned by `stdout`/`exit` handlers, and TypeScript narrows them to their initial literal values because control-flow analysis cannot see a callback run. Annotating the declarations does not help — the *narrowed* type at the point of use is still the literal — so this is a scoped `eslint-disable` with the reason written down.
  - **`no-unnecessary-condition` on the discovery-scene guards.** `BUILTIN_CATEGORIES[0]` is typed as definitely present because this project does not run `noUncheckedIndexedAccess`, which made a real guard look dead. Fixed properly with `.at(0)`, which returns `T | undefined` — the truth — so the guard and the linter now agree.
  - **`strictTypeChecked` on the plain `.mjs` build utilities** produced 87 "unsafe any" errors, because there are no types to be safe about. That is the ruleset being wrong for the file, not 87 bugs, so those files get `disableTypeChecked` plus the two Node globals they use, and keep the rules that still mean something.

### Not captured, and why

- ~~**A dial mid-countdown.**~~ *(Now captured — NEWS-232.)* See FR-28.15 above.
- **The terminal cast beat.** Glassbox opens its hero with a real `domotion term` recording and layers the app over its last frame (`casts.ts` + `popIn.ts`, ~260 lines). It is the most complex piece of that pipeline and buys the least here: Newsmonger's story is the app, not the CLI. Worth revisiting only if the install path becomes a headline feature.

See also: [3 — UI](3-ui.md) (the layouts being photographed), [4 — CLI, Server, and Storage](4-cli-server-storage.md) (`--demo`, `--ai-test`, the readiness line), [24 — Topic Discovery](24-topic-discovery.md) (the tuner the discovery scenes walk into).
