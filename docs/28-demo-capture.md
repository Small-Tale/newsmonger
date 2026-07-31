# 28 — Demo Capture (the hero and the stills)

**Status: shipped.** The animated hero (NEWS-212) and the inline screenshots (NEWS-214) are both built and both regenerate from the running app.

The README's images are **photographs of the real application**, produced by driving the live UI with Playwright. Nothing in them is mocked up in a design tool, and that is the whole point: a screenshot that is assembled by hand is accurate on the day it is made and slowly becomes a lie, with nothing to catch it. These cannot drift from the product without the capture script breaking.

## The two pipelines, and why they are two

| | Hero | Stills |
|---|---|---|
| Script | `scripts/demo/capture-demo.ts` | `scripts/demo/capture-stills.ts` |
| Command | `npm run demo:capture` | `npm run demo:stills` |
| Output | `assets/demo.svg` + `.svgz` | `assets/stills/<scene>.png` + `.svg` |
| Shape | one animated, chrome-wrapped artifact, five beats, crossfades | one flat image per feature, no chrome, no composition |

- **FR-28.1** *(Shipped)* They are **separate scripts on purpose.** The hero is a composed narrative — window chrome, captions, timing, transitions, an end card. The stills are single frames of individual features. Merging them would make every still carry the animation machinery and every hero beat carry the still machinery, for one shared `spawn` call. Glassbox keeps the same split for the same reason.
- **FR-28.2** *(Shipped)* Both run the app in **`--demo` mode**, which serves the fixture stories in `src/demo.ts` (FR-4.x). `--demo` implies `--ai-test`: no real AI call, no network, no lead-image fetching.

## Rules both pipelines follow

- **FR-28.3** *(Shipped)* **The port is read from the server's own readiness line**, never assumed. An early version of the hero hardcoded a port with `--strict-port`; a stray process was already on it, our server died with `EADDRINUSE`, and the capture carried on and photographed *whatever else was answering there*. Reading the URL the spawned process prints means it can only ever talk to the process it started. (The `running at ` marker is shared with `src-tauri/src/lib.rs` — see the note in `CLAUDE.md`.)
- **FR-28.4** *(Shipped)* **Never the real data directory.** Each run gets a fresh `mkdtemp` directory, because the capture creates topics and runs checks. Asserted by a unit test rather than left to care.
- **FR-28.5** *(Shipped)* **State is reached through the real UI or the real HTTP API**, never by writing to the database behind the server's back — topics are added with `POST /api/topics`, stories arrive from the check that firing that endpoint triggers (FR-1.12).
- **FR-28.6** *(Shipped)* **Trees are captured live and rendered to SVG after teardown.** domotion's macOS glyph-path extraction is flaky under contention and falls back *silently* to CSS `<text>`, which renders as tofu on any machine without the font. Rendering once the browser and server are gone makes it reliable, and an **`@font-face` assertion** on the output is what stops a silent regression.
- **FR-28.7** *(Shipped)* Both must run **outside the command sandbox** — Chromium needs Mach ports.

## The stills (NEWS-214)

- **FR-28.8** *(Shipped)* Seven scenes: `feed`, `topics`, `discover`, `tuner`, `review`, `settings-source`, `export`. Each is declared in one `SCENES` array with its name, its alt text, the navigation that reaches it, and optionally a crop.
- **FR-28.9** *(Shipped)* Every scene produces **both a PNG and a stand-alone SVG**. The README embeds the PNG; the SVG is crisp at any zoom and — the real reason to keep it — **diffable**, so a text diff shows what actually changed in the UI. No scene is PNG-only, because `--demo` implies `--ai-test` and no lead images are ever fetched.
- **FR-28.10** *(Shipped)* **One server, one data directory, per scene.** Scenes mutate real state — flagging a story off-topic, promoting a topic — so a shared server would make each screenshot depend on which scenes ran before it, and reordering the array would silently change the pictures. A few seconds per scene buys the property that any scene can be run, reordered or removed on its own.
- **FR-28.11** *(Shipped)* **Which topics are followed is per scene.** Discovery only ever suggests topics you are *not* already following, so the two discovery scenes hold one back; without that they photograph an empty result.
- **FR-28.12** *(Shipped)* **Crops are CSS selectors resolved at capture time**, not pixel rectangles. A hardcoded rectangle rots the moment the layout moves, and does it *silently* — the crop still succeeds, it just frames the wrong thing. Used for the topics sidebar (a fifth of a 1440px frame) and the export dialog (which opens over Settings → Data, so the full frame shows it stacked on another dialog).
- **FR-28.13** *(Shipped)* **Section and subject labels come from `BUILTIN_CATEGORIES`**, not from the demo topics' own `category`/`subcategory` strings. Those are free-text hints for the classifier and do not all name real chips — a fixture says `Climate`, the taxonomy says `Climate & Environment` — so clicking them by name finds nothing.
- **FR-28.14** *(Shipped)* **The README's alt text and the scene's alt text must be identical**, enforced by `tests/unit/stills.test.ts`. It also fails on a scene with no captured file, a captured file belonging to no scene (what a rename leaves behind), and a README `<img>` pointing at a file that does not exist. None of those break a build on their own; all of them ship a README with a hole in it.

### Not captured, and why

- **A dial mid-countdown.** The next-check ring drains from full over the check interval, so a topic checked moments ago shows a *full* ring — which is what every scene here has, since stories arrive from the check that adding a topic fires. Reaching a visibly part-drained ring means the minimum 5-minute interval plus minutes of waiting for a subtle difference, in a script otherwise measured in seconds. Filed rather than faked.
- **The terminal cast beat.** Glassbox opens its hero with a real `domotion term` recording and layers the app over its last frame (`casts.ts` + `popIn.ts`, ~260 lines). It is the most complex piece of that pipeline and buys the least here: Newsmonger's story is the app, not the CLI. Worth revisiting only if the install path becomes a headline feature.

See also: [3 — UI](3-ui.md) (the layouts being photographed), [4 — CLI, Server, and Storage](4-cli-server-storage.md) (`--demo`, `--ai-test`, the readiness line), [24 — Topic Discovery](24-topic-discovery.md) (the tuner the discovery scenes walk into).
