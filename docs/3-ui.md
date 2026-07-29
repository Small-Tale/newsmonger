# 3 — Web UI

A single-page kerfjs app served by the Node server; the same UI runs in the browser and in the Tauri webview.

### Visual design

"The overnight briefing." Two-column layout (a sticky **Watching** rail + a **feed**), collapsing to one column under 860px. Bookish serif (`Iowan Old Style`/`Charter`/Georgia) for the stories themselves; quiet sans for controls; mono for the "clockwork" (eyebrows, timestamps, topic tags, meta). Cool porcelain paper in light mode, pre-dawn slate-green in dark; pine-green accent with a marigold "active" state.

**Signature element — the watch dial**: each topic carries a small SVG ring that **counts down** — full just after a check, draining as the next one comes due (NEWS-144). A ring that filled up read as progress toward something the user was waiting for, which is backwards: what is running out is the time left before the app acts on its own. A topic never checked, or paused, shows a full ring — a paused topic's interval isn't running down at all, and draining toward a check that will never fire would be a lie. It spins marigold while a check runs and goes dashed when paused. Purely decorative/informational (`aria-hidden`), with a text `title`; the textual status line remains the source of truth.

- **FR-3.1** Header: the wordmark (FR-3.58), the global check-interval selector (presets 1h / 3h / 6h / 12h / 1d / 2d / 1w), and a "Check all now" button (disabled while any check runs).
- **FR-3.1a** Source block (top of the Watching rail): an AI-provider picker (Auto / Anthropic / OpenAI / Mock), a model field (shown for non-auto/mock), and an endpoint field (shown for OpenAI), persisted via `PATCH /api/settings`. A status line shows the selected provider's availability (from `GET /api/providers`, probed on demand) and the provider that ran the last check. See [6 — AI Providers](6-providers.md).
- **FR-3.2c** *(NEWS-142, NEWS-143)* A topic **name wraps rather than truncating** — it is the question the app asks, so an ellipsis hides the part that tells two similar topics apart ("3D chip stacking and advanced…" vs "3D chip stacking in memory…"). Its **guidance shows as text** below the name, clamped to two lines, and to ten when that row is the *only* one selected — a sole selection is the one moment the user is asking about that topic in particular. This replaced an icon that conveyed only *that* a topic was steered, which is the less useful half of the fact.
- **FR-3.2** Watching rail: a list of topics — dial, name, status line (checking… / paused / checked \<relative time\> / not checked yet), and per-topic Check / Pause–Resume / Delete actions (revealed on hover/focus on the desktop layout, always shown on touch/narrow). Delete asks for confirmation. Below the list: the add-topic form (submit via button or Enter).
- **FR-3.2a** *(NEWS-63, NEWS-140)* A **sort dropdown** sits on the "Watching" header line (right side, shown once there's more than one topic): **A → Z** (default), **Recently added** (newest first), **Priority first** (high-priority topics on top, then A→Z), and **By section** — taxonomy order (not alphabetical, so it matches the filter bar), A→Z within each section, unclassified last, with a heading opening each group.

  **FR-3.54** *(Shipped, NEWS-154)* Those headings are **larger than the "Watching" eyebrow above them, and carry no rule.** At `0.68rem` a heading was a hair *smaller* than the label for the list itself, which is backwards — they are the structure the eye scans to find a topic. The underline went with the row rules (FR-3.52): once whitespace does the separating, an underlined heading is the one thing left fenced in. The E2E sizes the heading *against the eyebrow* rather than against a magic number, because that comparison is the complaint.

  The headings are entries in the **same flat list** as the topics rather than a nested structure. A nested list would mean an `each()` inside an `each()` row, which kerf never reconciles (see the delegate/morph section below), and grouping with `.map()` instead would give up the per-row memoization the topic rows rely on. Each heading is `role="presentation"`: a listbox may only contain options, so a heading claiming to be one would be selectable to a screen reader and would fail the axe suite. A topic whose stored slug is no longer in the taxonomy sorts *and* renders as unclassified — the heading and the rows beneath it must agree. Ordering is display-only (the scheduler keeps its own order) and persisted per device (`news:topic-sort`). `sortTopics` in `src/client/topic-sort.ts`; shift-range selection ranges over the *displayed* order.
- **FR-3.3** Feed: news items across all topics, newest first, **grouped by local calendar day** with Today / Yesterday / "Mon D" headers. Each item has a topic tag, relative found-time, serif title + summary, and source links (prefixed with an arrow) opening in a new tab (`rel="noopener noreferrer"`). Items animate in on first render (respecting `prefers-reduced-motion`).
- **FR-3.4** Errors from user actions appear in an error banner; the most recent failed check (when no action error is showing) appears in a warning banner naming the topic and error.
- **FR-3.5** The client polls `/api/state` every 4 s while the tab is visible, so scheduled-check results appear without a reload.
- **FR-3.6** Empty states: an invitational hint when there are no topics, and a "no stories yet" hint when topics exist but no items do. Both render inside a stable `.empty-slot` wrapper so their appearance/disappearance can't disturb the keyed lists (kerf KF-377).
- **FR-3.7** The UI supports light and dark color schemes (`prefers-color-scheme`), plus visible keyboard focus and `prefers-reduced-motion`.
- **FR-3.8** In the Tauri webview, source links route through `POST /api/open-external` to open in the system browser (http/https only).

### kerf structural conventions (learned the hard way)

Two rendering rules this UI depends on — regression-tested by the E2E suite:

- Keep sibling structure around keyed lists stable: conditional elements (banners) live inside an always-present container (`#banners`). Each error/warning banner carries a dismiss button (NEWS-41). The error banner clears `s.error`; the failure warning is *derived* from the runs list, so its dismissal is remembered by **run id** — a later, different failure has a new id and reappears, which is the intent. Two things make that dismissal robust across a relaunch (NEWS-41 follow-up): the warning is derived via `currentFailure(runs)` (`src/client/failure.ts`), which fires only for a topic whose **latest** run failed — a stale failure from a recovered topic no longer nags — and the dismissed run id is **persisted to `localStorage`** (`news:dismissed-run`), so closing a warning survives an app relaunch instead of resurrecting on the next load. **This was written to work around a confirmed kerfjs 2.0.0 bug (kerf KF-377)**: removing a conditional sibling rendered before a keyed `each()` list permanently emptied the list (verified in a minimal standalone repro attached to that ticket). **Fixed in kerfjs 3.0.0** — the morph now moves the shifted container up in place, keeping node identity. See "KF-377 status" below.
- Keep `each()` containers structurally stable: empty-state messages render *alongside* the list, not instead of it. The pure container swap (`<p>` ↔ `<ul>{each(...)}</ul>`) tested OK in isolation on 2.0.0, so this one was always defensive convention rather than a confirmed trigger — but the app's original failures involved the combination, and the stable shape is regression-covered here.

### KF-377 status (NEWS-98)

**Fixed in kerfjs 3.0.0**, along with a family of related morph defects: a conditional sibling *inside* a keyed list's parent no longer costs rows their DOM identity; a surviving list no longer renders a departed list's rows when the number of `each()` calls changes; and the morph no longer positionally adopts a `data-morph-skip` / `data-morph-preserve` node as a stand-in for an unrelated element.

### The always-present containers stay — for reasons that outlived the bug (NEWS-99)

kerfjs 3.0.0 went stable on 2026-07-27, so the "wait until it isn't a beta" deferral is spent. **Decision: keep every one of them**, and the justification below replaces "works around KF-377" — a comment pointing at a fixed bug is exactly what invites a later removal.

- **`#banners`** (`role="status" aria-live="polite"`) and **`#toast-slot`** (`aria-live="polite"`) are **live regions**, and a live region has to be in the DOM *before* the text lands in it. Assistive technology observes the region and announces subsequent mutations; a container created in the same render as its own content has nothing watching it, and the announcement is simply lost. Being always-present is the feature here, not a workaround.
- **`#topics-panel`** turns out to be the *least* removable, not the most — the opposite of what this was expected to conclude. The sidebar toggle carries `aria-controls="topics-panel"`, so unmounting the panel leaves that attribute pointing at nothing. **Verified rather than assumed**: pointing `aria-controls` at a non-existent id and running the suite fails `a11y.spec.ts` on an axe violation (`aria-valid-attr-value`), so the existing tests already defend this. Collapsing also sets `aria-hidden` on the panel, which is state a removed element cannot express.
- **The dialog slots** (`#settings-slot`, `#confirm-slot`, `#guidance-slot`, `#onboarding-slot`, `#schedule-slot`, `.empty-slot`) hold conditionally-rendered children. Removing the wrapper doesn't delete a conditional sibling — it *promotes* one, which is more structural churn for no gain. A stable slot is also a stable test target.

So the containers are no longer KF-377 scar tissue; they are ordinary good structure that happened to also dodge a bug. `docs/3-ui.md` and `CLAUDE.md` say so, so nobody re-derives the question from the changelog.

The topics list also now carries an explicit `key: 'topics'` (kerf 3.x). Unkeyed lists are identified by their position among a render's `each()` calls; this is the only `each()` in the app today, so the position cannot currently shift, but the key means adding a second list later can't silently rebuild this one.

### The morph preserves interactive nodes — measured, not assumed (NEWS-131)

A rare E2E failure raised the question of whether a poll-driven re-render can destroy a control the user is interacting with. It cannot, and this is worth recording because the answer was reached by probing rather than reasoning: an expando property set on a `<select>` **and on one of its `<option>`s** survives a full 4-second poll cycle, and a value the user changed survives a re-render after it. So kerf reuses those nodes rather than replacing them, and no interaction is lost to node replacement.

That also rules the morph out as an explanation for settings flakiness, alongside the `refreshState` sequence guard (NEWS-104) and the `<select>` attribute-vs-property trap. What remains is ordinary round-trip latency under a loaded serial suite, which is a timeout question rather than a product one.

### `each()` items must keep their identity, or focused rows are rebuilt (NEWS-140)

Adding section headings to the sidebar meant the list could no longer be plain topics, and the obvious shape — wrap every entry in `{kind, key, …}` — quietly broke keyboard access to the topic menu.

`each()` memoizes per row on **item identity**. Wrapping each topic in a fresh object every render made every row a permanent cache miss, so rows were rebuilt rather than morphed in place, and **a focused row lost focus the moment anything re-rendered**. The visible symptom was two steps removed from the cause: press Enter to select a row (fine), then Shift+F10 for its menu and nothing happens, because focus had already moved to `<body>`.

The fix is to pass topics through **unwrapped** — `TopicRow = Topic | TopicHeading` — so they keep the identity they arrive with, and only headings are new objects each render. A heading has no focus or selection to lose.

The rule generalises: before putting anything between state and an `each()`, check that items which represent the same thing across renders are still the *same objects*. `data-key` governs DOM matching; identity governs whether the row is re-rendered at all, and the two are not interchangeable.

Caught by `a11y.spec.ts`'s keyboard test, which is exactly what it is for — nothing about the change looks wrong in the source, and the rail renders correctly.

### Privacy lives at the foot of the sidebar (NEWS-138)

The privacy link was in the page footer, below both columns — so reaching it meant scrolling past the entire feed. It now sits at the foot of the **Watching** rail, which is `position: sticky` and therefore stays in view.

The rail is also bounded to the viewport (`max-height: calc(100vh - 48px)`, a flex column with the topic list scrolling internally), because a long topic list would otherwise run off the bottom and put the link back out of reach — the exact thing being fixed.

The page footer remains, but is **only filled when the sidebar is collapsed** (`display: none` hides the rail entirely in that state). One entry point on screen at a time, never zero; `.app-footer:not(:empty)` carries the rule and padding so an empty footer leaves no stray line across the page.

### New controls must reuse the established classes (NEWS-133/134/135)

Three visual bugs shipped in the discovery dialog at once, and all three were the same mistake: inventing markup instead of reusing what the rest of the app already has.

- The close button used a class (`icon-btn`) that **does not exist in the stylesheet**, so it fell back to browser-default button chrome — a white chip on the dark panel. Every other dialog's close button is `btn icon`, which is transparent and borderless.
- The search field was never styled. There is **no global `input` rule** in this app — every text field is styled by its own container — so a new one renders browser-default white and looks broken in dark mode. That style is now a `%text-field` placeholder extracted from the add-topic field; **any new text input should `@extend` it.**
- The depth controls used `⌄` and `≈` as icons. Icons come from `icons.tsx`, with Lucide path data inlined verbatim.

Regression-tested two ways. `discover.spec.ts` compares the **computed background lightness** of each control against the dialog's own panel in emulated dark mode, so any control that renders near-white fails whatever the cause — verified by removing the input's style and watching it report a lightness of 1. And the depth controls are asserted to contain an `<svg>`, not a glyph.

### Two delegates must never match nodes the morph can turn into each other (NEWS-126)

The discovery dialog's section grid and its subcategory chips are both `<button>`s in the same position of the same container. When the pane switches, the morph does what it is supposed to do — **reuses the node** and rewrites its attributes — so the tile *becomes* the chip.

That broke a rule nobody had written down. `delegate()` registers one listener per selector on the shared root, and they all run for the same click. The first handler (`[data-discover-section]`) re-rendered synchronously; by the time the second handler (`[data-discover-sub]`) walked up from the very same `e.target`, that node was carrying the chip's attribute — so it fired too. **One physical click ran two different actions**, jumping the user from "Sports" straight into results for whichever subcategory happened to land under the cursor.

The fix is one delegate on one attribute (`data-discover-nav`), branching on its value. The rule generalises: when two interactive states can occupy the same position in the same container, **give them one action attribute and one handler** — because the morph reusing the node is the whole point of the morph, and a handler that re-renders before its siblings run is unavoidable.

Caught by the E2E suite, which is the only place it *could* be caught: the mistake typechecks, lints, and looks right in the source.

### Enumerated attributes take keyword strings (kerf 4.0.0, NEWS-123)

`draggable`, `spellCheck`, `contentEditable`, `translate` and `autocorrect` are HTML **enumerated** attributes, not boolean ones: they carry keyword strings (`"true"` / `"false"`, `"yes"` / `"no"`, `"on"` / `"off"`), and *omitting* them selects a third state — inherit-from-parent — rather than "off". kerf ≤3 accepted the boolean JSX form and rendered nothing for `{false}`, which is why the API key field's `spellcheck={false}` compiled cleanly and never reached the browser. kerf 4 makes the boolean form a type error; write `spellcheck="false"`.

Real boolean attributes (`hidden`, `checked`, `disabled`, `autofocus`, `required`, `inert`) are unchanged and still take `{true}` / `{false}`. The distinction is which spelling the HTML standard gives the attribute, not how it reads in English. The rendered value is asserted in `keys.spec.ts` — a silently-absent attribute is exactly the failure that got through the first time, so the test checks the value rather than the element.

Two other kerf 4 breaks don't apply here but are worth knowing before writing new markup: `<select value>` / `<textarea value>` no longer typecheck (neither element has a `value` content attribute — use `<option selected>` and `<textarea>{draft}</textarea>`, which is already how the guidance dialog seeds its draft), and lowercase `autofocus` no longer accepts `"true"` / `"false"`.

## Bookmarking stories (Saved)

Each story card has a bookmark button (NEWS-42). Saving sets `item.saved` in the store — a persistent property of the story, so it survives restarts but goes with the story if its topic is deleted. The toggle is `PATCH /api/items/:id { saved }`.

A **Saved filter** (bookmark toggle in the header, next to the gear) filters the feed to saved stories only, with a "Showing N saved" banner and a Show-all button — the same shape as the Solo filter. The filter itself is a **view state, ephemeral** (cleared on reload); only the saved flags persist. Solo and Saved compose: Saved filters within the current Solo set.

## Confirmations (never `window.confirm`)

Destructive actions — deleting topics, removing a stored key — confirm through an **in-app dialog** (`confirmDialogJsx` + the `confirm()` promise helper in `app.tsx`), never `window.confirm`.

`window.confirm`, `window.alert`, and `window.prompt` are **silent no-ops in the Tauri WKWebView**: the webview returns a falsy value without ever showing anything. Because delete was guarded by `if (!window.confirm(...)) return;`, that made **delete (and key removal) do nothing at all in the desktop app** while working fine in a browser — the NEWS-39 bug. The same trap hit the sibling glassbox/hotsheet projects, which is where the pattern is documented.

The in-app dialog uses the same `delegate()` click handling as every other control, so it works identically in a browser and in Tauri. It lives in an always-present `#confirm-slot` (KF-377), cancels on backdrop-click and Escape, and its backdrop uses a distinct action from its buttons for the reason spelled out under the context menu above.

**Never reintroduce `window.confirm/alert/prompt`.** An E2E test registers a native-dialog listener and asserts it never fires during a delete — a stray `window.confirm` fails it. Note that Playwright *auto-accepts* native dialogs in headless, so a native confirm would pass every headless test while being broken in the actual app; the in-DOM dialog is what makes the test exercise the real path.

## Icons

**Every icon comes from `src/client/icons.tsx`. No emoji, and no hand-drawn glyphs.** An emoji renders as someone else's artwork at someone else's weight and colour, and no amount of CSS brings it into line with a stroked icon set — the gear, the close ✕, and the source-link arrow were all previously text characters and all three sat visibly wrong next to real icons.

Path data is copied verbatim from [`lucide-static@1.26.0`](https://lucide.dev) rather than taken as a dependency: the set is a few hundred bytes against a package that would be staged into the desktop sidecar's `node_modules`. Re-copy from the same version when adding icons so the set stays visually consistent.

The one exception is the **watch dial** on each topic row, which is a data visualisation — its arc encodes progress toward the next check — rather than an icon.

`icon(name, size)` renders at the requested pixel size; `.icon` in `styles.scss` sets `stroke` to `currentColor` so icons inherit the colour of whatever they sit in. Lucide's 24×24 grid assumes a 2px stroke, which reads as a blob at 12–15px, so the stroke is scaled down there.

An E2E test scans the rendered DOM for arrow/dingbat/symbol/emoji codepoints and fails if any appear in a text node — typographic punctuation (em dash, curly quotes, ellipsis, middle dot) is deliberately excluded, since that's prose rather than iconography.

## Topic selection, context menu, and solo

Topic actions used to be three buttons per row, revealed on hover. They were invisible most of the time yet always reserved their width, so every topic name was truncated to pay for controls nobody could see. They now live in a right-click menu.

- **Selection** — click selects; **Cmd/Ctrl-click** toggles a row; **Shift-click** selects a contiguous range anchored on the last plain click. Clicking anywhere else, or pressing **Escape**, clears it. Both `metaKey` and `ctrlKey` are accepted rather than sniffing the platform: no OS gives them conflicting meanings here.
- **Context menu** — right-click opens Check now / Pause / Solo / Delete, with [Lucide](https://lucide.dev) icons and separators. Right-clicking *inside* the selection acts on all of it; right-clicking *outside* selects that row first, so the menu never acts on rows the user can't see are targeted. Labels reflect the count ("Check now 2 topics") and mixed selections resolve toward the action that changes the most rows.
- **Delete key** — deletes the selection after a confirmation naming what's about to go. Ignored while a text field has focus, so Backspace in the add-topic box can never delete a topic.
- **Solo** — shows only the solo'd topics' stories. Additive, with a "Showing N of M topics · Show all" banner and the non-solo'd rows dimmed, so a short feed is always explained.
- **FR-3.40** *(Shipped, NEWS-95)* **Double-clicking a topic row toggles solo**, without going through the menu — the one topic action common enough to earn a gesture. It acts on the double-clicked row alone: the two clicks making up the gesture have already collapsed the selection to that row, so acting on a wider selection would target rows the user can no longer see are targeted. Both routes call `toggleSolo` in `src/client/solo.ts`, so the gesture and the menu item cannot drift apart — including the additive behaviour, where soloing a second topic widens the filter rather than replacing it. `.topic` is `user-select: none`, so the gesture leaves no stray text selection (asserted in E2E, since it's the kind of thing a later style change would quietly undo).

- **FR-3.51** *(Shipped, NEWS-149)* **Both context menus are clamped into the viewport.** They are `position: fixed` at the raw cursor point, which is right until the cursor is near an edge — at which point the menu simply runs off it, and because it is fixed inside a full-screen backdrop, *scrolling cannot bring it back*. The topic menu has eight items with **Delete last**, so the bottom edge took the most destructive action out of reach first. Measured at 520px in a 420px-tall window: 100px of menu, including Delete, past the fold.

  **Clamped, not flipped.** A flipped menu jumps to the other side of the cursor, moving the item under the pointer somewhere else at the moment the user is reaching for it; nudging it just far enough to fit keeps every item roughly where it appeared. `placeMenu` (`src/client/menu-position.ts`) is a pure function of the anchor and the viewport, so the arithmetic is unit-testable without a browser.

  Placement uses an *estimated* menu height, which is safe because it is not the safety net: the same function returns a `max-height` derived from the space actually left, and `.menu` is `overflow-y: auto`. A menu taller than the estimate — or a viewport shorter than the menu — scrolls rather than overflowing, and pins to the top-left rather than being pushed off the opposite edge by the clamp meant to rescue it.

Icons are inlined from `lucide-static@1.26.0` in `src/client/icons.tsx` rather than taken as a dependency: six icons is a few hundred bytes against a package that would be staged into the desktop sidecar's `node_modules`.

### Solo is deliberately ephemeral

Solo lives in memory and is cleared on reload. A solo that survived a restart would silently hide news days later, and "the app stopped finding anything" is a far worse failure than having to re-apply a filter. It is also cleared for any topic that no longer exists, so a deleted topic can't leave the feed filtered against nothing.

### Two structural gotchas this hit

**`each()` memoizes rows on object identity, and selection lives outside the topic object.** Without a `cacheKey`, selecting a row appeared to do nothing — the cached row HTML was reused, and the change only showed up seconds later when the poll happened to replace `topics` with fresh objects. The fix is `each()`'s third argument, a comparator over the external state the row renders:

```tsx
each(s.topics, (t) => topicRowJsx(...), (t) => `${selected.has(t.id)}|${solo.has(t.id)}|…`)
```

**The menu backdrop wraps the menu, so a shared close action swallows the item click.** `[data-action=close-menu]` matches by ancestor walk, so a click on a menu item also matched the backdrop; the menu closed and cleared `contextMenu` before the item handler could read it, and the action silently did nothing. The handler now closes only when the click landed on the backdrop element itself. This is the same trap the settings dialog hit — worth checking on any future overlay.

## Icons (NEWS-115)

Source art lives in `assets/`, in two shapes — rounded and full-bleed — and which one a surface wants depends on whether the platform applies its own mask.

| File | Used for |
|---|---|
| `logo-full-bleed.svg` | Desktop app icon (`npx tauri icon assets/logo-full-bleed.svg`) **and** manifest `purpose: "maskable"` |
| `favicon.svg` | Tab icon, and manifest `purpose: "any"` |
| `logo.svg` | Nothing — the rounded variant, kept as source art |
| `mask-icon.svg` | Nothing — see below |

**The desktop icon is deliberately the full-bleed square, and it is the owner's call rather than the platform convention.** macOS renders `.icns` exactly as authored — it applies no mask — so a square icon stays square beside the rounded neighbours in the Dock. The rounded `logo.svg` would match macOS convention more closely. This was chosen with that trade-off on screen, so it is a decision, not an oversight: don't "fix" it by swapping the source.

- **FR-3.43** *(Shipped)* The page serves an **SVG favicon only**. Every browser this app runs in — and the Tauri webview — supports it, so one vector file beats a ladder of PNG sizes.

- **FR-3.44** *(Shipped)* A **web app manifest** is served at `/manifest.webmanifest`, from a route rather than as a static file. A file would need copying by `build:client` *and* by the sidecar staging; the favicon demonstrated that a client asset with two build paths is an asset with two chances to be forgotten. A route has none.

  It advertises two icons, and the distinction is the reason to have a manifest at all: `favicon.svg` as `purpose: "any"` is drawn as-is, while `logo-full-bleed.svg` as `purpose: "maskable"` is cropped by the platform to a circle, squircle or rounded rect — so it must bleed to the edges with the mark inside the safe zone. Handing the rounded `logo.svg` to a maskable slot gets its corners cut off twice.

  The same full-bleed file serves both the maskable slot and the desktop icon. They want the same thing for different reasons: a maskable icon is cropped by the platform, and the desktop icon is square by choice (see above).

  A unit test reads the manifest href out of the served page, fetches it, and asserts **every icon path it names is actually served** — nothing but a string links the manifest to the client build, and a maskable icon that 404s is invisible until someone installs the app.

- **`mask-icon.svg` remains unused.** Its name points at a Safari pinned-tab icon, but Safari tints *every painted area* of a mask icon and this file is an opaque white square with the mark on top — wired as one it renders as a solid green block, not the "N". A pinned-tab icon would need a transparent ground with only the mark painted, which is what `favicon.svg` already is.

## Card and sidebar text layout

- **FR-3.41** *(Shipped, NEWS-112)* A relative timestamp (`57m ago`, `checked 3h ago`) **never wraps**. The card header is a flex row, so a long topic pill beside the timestamp squeezed it until it broke across two lines — which reads as two facts rather than one. `flex: 0 0 auto` stops the timestamp being the item that gives way; the pill wraps instead, which it can afford to.

- **FR-3.42** *(Shipped, NEWS-113)* A source link's arrow aligns with the **first line** of the link text, not the vertical middle. Once a headline wrapped, a centred arrow pointed at the gap between two lines; it is a bullet for the first line, so it belongs beside the first line. `align-items: flex-start` plus a 2px nudge, so a 13px glyph sits on the first line's optical centre rather than riding its very top.

- **FR-3.57** *(Shipped, NEWS-163)* The dial sits on the **first line of the topic name**, and the badges stack **beneath it** in the same gutter.

  The row was `align-items: center`, so on a two-line name the dial drifted to the row's middle — beside the *second* line, where it stopped reading as a marker for that topic and started reading as a stray dot. The badges were pinned to the row's right edge, a long way from anything they described once the name wrapped; under the dial they read as one column of status.

  `.topic-name`'s line-height is **declared** (`$topic-line`) rather than inherited, and the dial's box is sized from the same variable — the two must derive from one number or they drift apart the first time the body's line-height changes. This is FR-3.49's lesson applied before the bug rather than after.

  The E2E deliberately uses a name that **wraps**: on a single-line row the first line's centre and the row's centre are the same point, so the old layout and the new one agree and the test would assert nothing. It checks both that the dial is on the first line *and* that it is well above the row centre, so the second condition can't quietly lapse.

- **FR-3.56** *(Shipped, NEWS-152)* The flag slot **leaves the layout when it is empty**. `min-width: 13px` plus the row's 10px flex gap reserved **23px of every row's 320** for a high-priority star most topics don't have — 7% of the rail, taken from the topic name, which is the one thing in the row that needs the width. Measured: the name column goes from 255px to 278px.

  The slot stays *in the DOM* and is dropped with `:empty { display: none }`, not rendered conditionally — it is the always-present container the badge appears inside, and removing it conditionally is the structural hazard described above. The E2E also toggles high priority and asserts the slot returns, since hiding the star outright would satisfy a one-sided test.

  **Superseded in part by FR-3.57**: the slot now stacks under the dial rather than sitting beside the name, so a badge costs the name *no* width instead of 23px. The E2E asserts the column is unchanged with a badge showing — it originally asserted the opposite, which was right for the horizontal layout and wrong for this one.

- **FR-3.58** *(Shipped, NEWS-175)* The masthead is the **wordmark asset**, not styled text. It was `Newsmonger` set in the body serif at 34px with the period tinted `--pine` — a good imitation of a wordmark, but an imitation, drifting from the real mark every time either changed.

  `assets/wordmark-light.svg` and `assets/wordmark-dark.svg` are two-path vector marks (`News` + `monger.`, the period included) with no embedded raster, so they stay sharp at any size and cost ~25 KB each. They reach the client through the same `build:client` copy step as `favicon.svg` and `logo-full-bleed.svg` and are served from `/static/`.

  The theme swap is a **`<picture>` with `media="(prefers-color-scheme: dark)"`** — no JS. Dark mode here is purely `prefers-color-scheme` (there is no manual toggle), so a scripted swap would buy nothing and could flash the wrong mark before hydration. The `<h1>` stays and the image carries `alt="Newsmonger"`, so the document outline and the accessible name are exactly what they were.

  Sizing is by **height** (30px) with `width: auto`; the intrinsic `width`/`height` attributes still reserve the correct box before decode, so the header cannot shift. `.wordmark` gets `line-height: 0` and the image `display: block` — an inline image sits on the text baseline and would otherwise carry a descender's worth of gap, pushing the mark off-centre from the sidebar toggle beside it.

  The E2E asserts the **decoded** image (`decode()` then `naturalWidth > 0`) rather than just the markup: `alt` is present whether or not the file is, and the asset reaches `dist/client` only via that copy list — precisely the step a later change forgets.

- **FR-3.55** *(Shipped, NEWS-153)* The dial's track is drawn in **translucent ink, not a fixed grey**. `--line` is mixed for the *page* background, so the ring was faint everywhere (1.18:1 in light against the page) and on a selected or hovered row — filled with `--pine-soft` — it all but vanished: about **1.01:1** in light and **1.02:1** in dark. Invisible, and precisely when the user had singled that topic out.

  `--ink` at `stroke-opacity: 0.24` composites over whatever is behind it, so the ring keeps its contrast against any fill the row ever gains rather than against the one background someone had in mind when they chose the grey. Now 1.61–1.97:1 across light/dark × selected/unselected.

  The E2E **composites the stroke over the row itself** and computes a WCAG ratio, because the computed colour is no longer what lands on screen — that is the whole point of the fix, so asserting the declaration would test the wrong thing.

- **FR-3.52** *(Shipped, NEWS-151)* Sidebar rows are separated by **whitespace, not rules**. A row is already a visual block of its own — name, timestamp, section pill, guidance preview — so a hairline between every pair drew a ladder down the rail and competed with the pill borders *inside* each row. The hover and selected fills mark a row's extent at the moment that matters; the rest of the time nothing needs to.

Both are measured in `tests/e2e/layout.spec.ts` rather than eyeballed, and both measurements guard against a vacuous pass — see the note there.

## The settings dialog

- **FR-3.45** *(Shipped, NEWS-118)* Settings is **tabbed**: Schedule, Source, Data, App, each with a Lucide icon from `icons.tsx`. It had grown to about two screens of unrelated controls in one column — scheduling next to API keys next to export links — so nothing was findable except by scrolling past everything else. Each tab answers a different question: *when* does it check, *who* does it ask, *what* is kept and how do I get it out, and everything about the app itself.

  Standard ARIA tabs: `role="tablist"`/`tab`/`tabpanel`, only the selected tab in the tab order, **arrow keys move between them** and wrap at both ends. Without the arrow keys the unselected tabs would be unreachable from the keyboard entirely, since they carry `tabindex="-1"`.

  Reopening always starts on the first tab. A dialog that remembers where you left off is a dialog that opens somewhere surprising.

- **FR-3.46** *(Shipped, NEWS-120)* **Diagnostics is collapsed and on the App tab** — two deliberate steps to reach. A bug-report bundle is an advanced, rarely-used tool, and an always-open run log was the loudest thing on the screen while being the least often wanted. It stays a `<details>` rather than a hidden gesture so support can talk someone into it: "open Settings → App and expand Diagnostics".

- **FR-3.47** *(Shipped, NEWS-121)* **Privacy is its own dialog**, reached from a footer link under the main content rather than from Settings. It was the wrong place twice over: nothing on it can be changed, so it isn't a setting, and burying "what leaves this machine" under two screens of configuration is the opposite of how a privacy note earns trust. Escape and a backdrop click close it, like every other dialog.

- **FR-3.49** *(Shipped, NEWS-147)* A settings row aligns its label and its control on the **text baseline**, not on the tops of their boxes. The two carry different font metrics and line-heights, so `align-items: flex-start` lined up the *boxes* and left the label's text sitting visibly below the control's — worst on the row whose control is tallest ("Keep stories for"). The previous fix for this was a `padding-top: 8px` on the label, a number correct for exactly one combination of font, size and control height; baseline alignment states the thing actually wanted, and keeps stating it if any of those change.

- **FR-3.50** *(Shipped, NEWS-148)* A field hint sits **below** its field with a positive margin. Its top margin was `-4px`, deliberately pulling it up under the control, which read as a caption crushed against the thing it explains rather than a separate line of guidance.

  Both are pinned in `tests/e2e/app.spec.ts` twice over: the computed **outcome** (label/control offset under 3px on every field of every tab; hint gap at least 4px, where the bug measured `-4`) and the **declaration** (`align-items: baseline`), because the point of FR-3.49 is that alignment no longer depends on a hand-tuned number — reintroducing one fails the test even on a machine where the pixels happen to land well. Verified non-vacuous by restoring each original value and watching the matching test fail.

- **FR-3.48** *(Shipped, NEWS-117)* The high-priority interval is labelled just **"High-priority"**. It read "High-priority topics every", which restated the column it sits in — directly under "Check every" — and wrapped to a second line to do it.

## Section filter bar (NEWS-97)

The bar under the masthead is documented in [docs/22-topic-categories.md](./22-topic-categories.md) (FR-22.9–22.12). Two structural points belong here with the other kerf conventions:

- The sub-row is **always in the DOM**, empty when no section is selected, rather than conditionally rendered — it sits above the keyed topics list, and the E2E suite runs with `invariants: 'throw'` (NEWS-100), so a conditional sibling there would fail at the render that caused it. It also stops the bar's height jumping as you select.
- The topic row's memo key includes `category`/`subcategory`. The pill is part of the row now, so a topic classified by a background check would otherwise keep its stale row until something else about it changed.
- **FR-3.53** *(Shipped, NEWS-155)* The bar carries **no rule beneath it**. The masthead above already has one, and a second hairline 40px below it read as a boxed-in strip rather than as a newspaper's section line. The bar's own two rows — small-caps sections over italic subsections — are unlike enough to read as structure without being fenced in.

## Feed grid on wide displays (NEWS-64, NEWS-96)

Stories lay out in a **responsive CSS grid** (per day group), not a single column: `repeat(auto-fill, minmax(min(100%, 400px), 1fr))`. Column count follows the available width, with no JS and no media query. Grid rows **stretch every card to the tallest on that line**, so a row reads as one unit. The day header and a flagged one-liner span all columns (`grid-column: 1 / -1`).

- **FR-3.36** *(Shipped, NEWS-96)* The shell has **no max-width** — it fills the window at every size, flush to the padding. It was previously capped at 1060px and centred, which fixed the feed at ~650px however large the display, so a wide monitor bought nothing but margins.
- **FR-3.37** *(Shipped, NEWS-96)* Reclaimed width becomes **columns, not wider cards**. The sidebar stays a fixed 320px; everything gained goes to the feed. Measured: 1 column at 1100px of window, 2 at 1440, 3 at 1920, 5 at 2560, 6 at 3000.
- **FR-3.38** *(Shipped, NEWS-96)* The column minimum is **400px**, lowered from 460 in the same change. Once the shell stopped being capped, this number became what decides how soon extra room turns into another column; 400 breaks into two columns at ~1200px of window rather than ~1340, which is where most laptops sit.
- **FR-3.39** *(Shipped, NEWS-96)* A card's **title and prose are capped at 74ch** while the card itself still fills its column. The widest a single column can get is just under twice the minimum, so on a window between the one- and two-column thresholds the summary would otherwise run to ~100 characters a line — wider than the layout it replaced, which is the opposite of the point.

Dialogs keep their own max-widths; only the app shell became full-bleed.

## Collapsible topics sidebar

- The topics sidebar (`#topics-panel`) collapses via a panel-glyph toggle at the left of the header. Collapsed, the grid drops to a single column and the feed reflows to the full width (measured: 652px → 1012px at a 1100px viewport).
- The choice persists **per device** in `localStorage` (`news:sidebar-collapsed`), not in the store — how you've sized your own window is a view preference, not something belonging in the shared data file alongside topics and stories. Reads and writes are guarded so a non-browser import or disabled storage can't throw.
- The toggle carries `aria-expanded` / `aria-controls`, and its glyph reflects state (the panel divider thickens when the sidebar is showing) rather than only naming an action.
- Collapsing hides the Source status line and the add-topic form along with the list, since they live in the same panel. Expanding is required to add a topic — acceptable, and the toggle is always visible.

**Structural note:** the panel is *always rendered* and hidden with CSS, never unmounted. Removing it would drop a sibling ahead of the keyed `each()` topics list — exactly the KF-377 hazard below. The E2E test asserts both that the panel is hidden and that `#topics-panel` still exists, so a future refactor to conditional rendering fails loudly instead of silently emptying the list.

## Settings dialog

Settings (check interval, provider, model, endpoint, API keys) live in a modal opened from the header gear. The **source status** — whether the chosen provider can actually run, and which provider last ran a check — sits under the provider picker here rather than in the sidebar: the provider is chosen here, so this is where knowing whether it works is useful, and it doesn't repeat the provider's name because the picker directly above states it. A provider that can't run still surfaces on the page through the failed-check warning banner, so nothing is lost by not duplicating it in the sidebar — see [7 — API Keys and Settings Dialog](7-api-keys.md). Two structural points belong here:

- The dialog is a conditional sibling, so it renders inside an always-present `#settings-slot` container (the KF-377 rule below).
- The backdrop and the close button use **different** actions. Delegation matches against the target's ancestors, and the backdrop wraps the dialog — so a shared `close-settings` action made every in-dialog click (including Save) match a closing ancestor and dismiss the dialog mid-submit. Backdrop click-away fires only when the click landed on the backdrop element itself.


See also: [1 — Topics and Scheduling](1-topics-and-scheduling.md), [5 — Desktop App](5-desktop-app.md).

## Accessibility (NEWS-90)

The UI grew mouse-first: right-click menus for every topic and story action, Cmd/Shift-click selection, hover-revealed controls. Icon-only buttons already carried `aria-label`s, so what axe could see was largely fine — the real gaps were the ones a scanner can't see.

- **FR-3.20** *(Shipped)* **The topics list is a multi-select listbox.** Rows are `role="option"` with `tabindex="0"` and `aria-selected`; **Enter/Space** selects (honouring Cmd/Ctrl and Shift, as clicking does) and **Shift+F10 / the Menu key** opens the same context menu the right-click does. Before this, check / pause / priority / guidance / solo / delete were reachable only with a mouse — the entire topic action set.

  The menu is anchored to the row's own box when opened by keyboard: the mouse path positions at the cursor, and a keyboard has no cursor, so a shared `openTopicMenuFor` keeps the selection rules identical between the two.

  Every row is tabbable rather than using a roving `tabindex` — the list is a short sidebar, and roving focus would need arrow-key handling the app doesn't otherwise have.

- **FR-3.21** *(Shipped)* **Escape closes dialogs innermost-first** (confirm → guidance → settings → onboarding), then falls through to closing menus and clearing selection. Previously only the confirm dialog listened.

- **FR-3.22** *(Shipped)* **Tab is trapped inside the frontmost dialog.** Focus outside it (including on `<body>` right after it opens) is pulled to an end of the cycle. The focusable set is read from the DOM rather than mirrored in the store — what is actually focusable is a DOM question (a disabled Save button isn't), and a second model of it would drift.

- **FR-3.23** *(Shipped)* The banner container is `role="status" aria-live="polite"`, and the check-all button announces its `Checking…` state. Banners appear in response to background events — a failed check, a blown budget — so they have to announce rather than wait to be found. (The toast slot was already `aria-live`.)

- **FR-3.24** *(Shipped)* A visible focus ring on every interactive surface via a `:focus-visible` rule, including those with no default one.

### Regression net

`tests/e2e/a11y.spec.ts` runs **axe-core** (`wcag2a/2aa/21a/21aa`, failing on serious/critical) against the main view in **both light and dark** — contrast is theme-specific, so a single-theme scan proves half the point — and, since NEWS-159, against the settings dialog on **all four tabs in both schemes**. It had been scanned once, in light, on whichever tab opens first; each tab is a different set of controls, and the dialog holds most of the app's. Currently **0 violations**, which also validates the listbox structure (`aria-required-parent` / `aria-required-children` are among the rules that pass).

**Two limits of the axe scan, both learned the hard way.**

- **It cannot scan a dialog opened over another dialog.** Both backdrops are `position: fixed; inset: 0` at the same z-index, so axe's overlap detection composites the lower one *over* the upper dialog's opaque panel and reports colours that are not on screen — measured, `#b5b8b6` for a button on `rgb(251,252,251)`, failing contrast that is really ~14:1. `AxeBuilder.include()` makes it worse, not better. NEWS-158's export dialog is therefore checked by asserting the properties axe would have checked, rather than by scanning.
- **NEWS-159 was filed off those invented numbers** and turned out to be no bug at all. "Check all now" measured **6.43:1**, not the 1.35:1 reported, and the settings tabs **5.65:1**, not 4.1:1 — both comfortably past AA. The lesson is not to distrust axe generally, but to distrust any reading taken while a second dialog is open, and to confirm against `getComputedStyle` before believing a contrast number.

The same spec covers what axe cannot: focus + Enter + Shift+F10 on a topic row, Escape closing each dialog, and 40 consecutive Tab presses never escaping an open dialog.

## Diagnostics (NEWS-88)

The store has kept the last 200 `CheckRun` records all along — status, timing, provider, error text — and the UI showed a spinner and one dismissable failure banner. For anyone who isn't the author, "it stopped working" had nowhere to go.

- **FR-3.25** *(Shipped)* A **Diagnostics** section in Settings lists the ten most recent checks: when, topic, and either the outcome (new items, duration, estimated cost) or the error text. Failures are coloured, and a deleted topic reads as "deleted topic" rather than a bare id.

- **FR-3.26** *(Shipped)* **Copy diagnostics** puts a Markdown bundle on the clipboard: app version, user agent, provider/model/interval settings, topic and spend counts, and the recent run outcomes with **verbatim error text** — the error is the whole point, so it is never truncated.

- **FR-3.27** *(Shipped)* **Topic names are redacted by default**, behind an explicit opt-in checkbox: a topic name is user content (see [7 — API Keys](7-api-keys.md) FR-7.13) and a bug report usually gets pasted somewhere public. The bundle says which mode produced it, and — when redacted — warns that **error text is verbatim and may still mention a topic**. Honest beats reassuring.

- **FR-3.28** *(Shipped)* The endpoint setting is reported as `set: yes/no`, never as its URL (it may be an internal gateway). **API keys cannot leak here by construction**: no key value exists in client state at all (`KeyStatusSchema`), so there is nothing to filter.

The bundle is built by a pure function (`src/client/diagnostics.ts`) so it is unit-testable without a browser.

## Source attribution (NEWS-82)

`NewsSourceSchema` was `{ title, url }`. Readers judge news by *when* and *who*, and neither was on screen — while the feed's day headings group by the day the story was **found**, which after a catch-up check files week-old articles under today.

- **FR-3.29** *(Shipped)* Sources carry an optional `outlet` and `publishedAt` (`YYYY-MM-DD`), both defaulting to null so existing data files load unchanged. The prompt asks for both and says explicitly that **a guessed date is worse than no date** — recency is exactly what the reader is judging.

- **FR-3.30** *(Shipped)* Both parse with `.catch(null)`: a model that writes "last Tuesday" costs one date, not the whole batch of stories. `outlet` goes through `stripMarkup` like every other prose field.

- **FR-3.31** *(Shipped)* The outlet shown is the model's answer when it gave one, otherwise **the URL's registrable domain minus `www.`** — close enough to be useful and never wrong in a misleading way, which a guess would be.

- **FR-3.32** *(Shipped)* The date is shown **only when it differs from the day the story was found**, which is exactly when the day heading is misleading. Same day → nothing (the heading already says it). Under a week → "published 3 days earlier". A week or more → the absolute date, because "published 23 days earlier" is arithmetic the reader shouldn't have to do. A date *after* the found date is nonsense from the model and renders as nothing rather than a negative count.

`outletFor` and `publishedLabel` live in `src/client/attribution.ts` rather than `app.tsx` — they are pure, and `app.tsx` touches `document` at import time, so keeping them there would make them untestable outside a browser (same reason `search.ts` / `share.ts` / `schedule.ts` are separate).

## kerf development diagnostics (NEWS-100)

kerf 3.x no longer infers dev mode — installing diagnostics is the app's decision. We make it with a compile-time flag rather than a runtime check.

- **FR-3.33** *(Shipped)* `__KERF_DEV__` is substituted by esbuild: `false` in `build:client`, `true` in `build:client:dev`. It cannot be kerf's documented `process.env.NODE_ENV` form — this is an IIFE browser bundle, `process` doesn't exist, and the read would throw at startup. (That is the same defect kerf's own changelog describes for its previous inference.)

  With `false`, esbuild proves the `import('kerfjs/dev')` unreachable and **the dev module is not bundled at all** — verified: zero occurrences of `installDevHooks`/`DEV_HOOKS` in the production bundle, ~30 KB smaller unminified. The `if (false)` husk itself remains only because the build doesn't minify; it is inert.

- **FR-3.34** *(Shipped)* `npm run dev`, `dev:server` and the **E2E web server** all build the dev bundle, which calls `enableWarnings()` with the whole family and `invariants: 'throw'`. `enableWarnings()` rather than the `KERF_DEV_WARN_*` env vars, which cannot be reached from a browser at all.

- **FR-3.35** *(Shipped)* A `pageerror` listener in the E2E `page` fixture collects uncaught page errors and asserts there were none at the end of every test. This is what makes the invariants meaningful: kerf's audit throws inside a render, and without the listener that throw is swallowed and the suite stays green while the DOM is quietly wrong.

  The guard is verified non-vacuous — a spec whose body passes but which injects an uncaught error does fail.

**Why `invariants` is the valuable one:** it audits kerf's list bookkeeping against the live DOM after every render and fails *at the render that broke it*, rather than leaving a wrong picture to be found several interactions later. That is precisely the shape KF-377 had. The full 76-test suite passes with it active, which is also independent corroboration that the kerf 3 upgrade is clean.
