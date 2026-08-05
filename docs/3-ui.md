# 3 — Web UI

A single-page kerfjs app served by the Node server; the same UI runs in the browser and in the Tauri webview.

### Visual design

"The overnight briefing." Two-column layout (a sticky **Watching** rail + a **feed**), collapsing to one column under 860px. Bookish serif (`Iowan Old Style`/`Charter`/Georgia) for the stories themselves; quiet sans for controls; mono for the "clockwork" (eyebrows, timestamps, topic tags, meta). Cool porcelain paper in light mode, pre-dawn slate-green in dark; pine-green accent with a marigold "active" state.

**Signature element — the watch dial**: each topic carries a small SVG ring that **counts down** — full just after a check, draining as the next one comes due (NEWS-144). A ring that filled up read as progress toward something the user was waiting for, which is backwards: what is running out is the time left before the app acts on its own. A topic never checked, or paused, shows a full ring — a paused topic's interval isn't running down at all, and draining toward a check that will never fire would be a lie. It spins marigold while a check runs and goes dashed when paused. Purely decorative/informational (`aria-hidden`), with a text `title`; the textual status line remains the source of truth.

The `title` gives a **duration**, not a proportion — "Next check in 42m" (NEWS-202). It previously read "3% of the interval left before the next check", which asked the reader to do arithmetic from a number the tooltip never supplied: the interval itself. The ring already expresses the proportion, so the tooltip's job is the part the ring cannot show. `dialCountdownMs` and `formatCountdown` in `src/client/dial.ts` are pure and unit-tested; the string is assembled in `dialJsx`, which is why an E2E test asserts the rendered `title` too — the helpers could be correct while the component still stitched a percentage in.

Two deliberate choices in the wording. Durations **round down** (`23h59m` → "in 23h"), matching the "checked 23h ago" label beside it so one row never uses two rounding rules, and never promising more time than remains. And under a minute reads "in under a minute" rather than "due now", because with 30 seconds left the ring is visibly not empty and "due now" would contradict what is on screen. Paused and never-checked keep their own wording — a countdown toward a check that isn't scheduled would be a lie.

- **FR-3.1** Header: the wordmark (FR-3.58), the global check-interval selector (presets 1h / 3h / 6h / 12h / 1d / 2d / 1w), and a "Check all now" button (disabled while any check runs).
- **FR-3.1a** Source block (top of the Watching rail): an AI-provider picker (Auto / Anthropic / OpenAI / Mock), a model field (shown for non-auto/mock), and an endpoint field (shown for OpenAI), persisted via `PATCH /api/settings`. A status line shows the selected provider's availability (from `GET /api/providers`, probed on demand) and the provider that ran the last check. See [6 — AI Providers](6-providers.md).

  **The status line always says something** *(NEWS-308)*. It used to render nothing at all on the default settings, and the design review reported that as two findings — "roughly 90px of unexplained empty space" *and* "the provider status line is not visible" — which is what a blank row looks like from the outside. The cause was `auto`: `GET /api/providers` returns it with `available: null`, correctly, since the server cannot say whether auto is available without deciding which provider auto would pick. The lookup had no branch for `null`, so both spans stayed empty.

  So the client resolves it. `sourceStatus` in `src/client/source-status.ts` walks `AUTO_ORDER` over the probes already on the page — **the same rule `resolveProvider` uses server-side**, deliberately, because a line naming a provider the next check does not use would be worse than the blank it replaces. Four states, all of which render: `ready` (naming the resolved provider when the selection is `auto` — under a picker reading "Auto", "ready" alone leaves you not knowing which subscription or key the next check spends), `unavailable`, `none-usable`, and `unknown` → *"not checked yet"*, the resting state for the window before the probe answers.

  **The space was never the problem.** `.source-status` carries `min-height: 1.2em`, so the blank row occupied exactly the height the filled one does — 66.5px between the Effort field and the API-keys rule, before and after. The E2E therefore asserts the line has *content* and sits inside that band, not that the band is small; a gap ceiling would have passed on the broken build. The separate ceiling it does carry guards a different thing: `.source-fields` and `.effort-note` are always-present containers (FR-3.x, NEWS-99) that collapse via `:empty { display: none }`, and the first padding added to either would open a real hole.
- **FR-3.2c** *(NEWS-142, NEWS-143)* A topic **name wraps rather than truncating** — it is the question the app asks, so an ellipsis hides the part that tells two similar topics apart ("3D chip stacking and advanced…" vs "3D chip stacking in memory…"). Its **guidance shows as text** below the name, clamped to two lines, and to ten when that row is the *only* one selected — a sole selection is the one moment the user is asking about that topic in particular. This replaced an icon that conveyed only *that* a topic was steered, which is the less useful half of the fact.
- **FR-3.2** Watching rail: a list of topics — dial, name, status line (checking… / paused / checked \<relative time\> / not checked yet), and per-topic Check / Pause–Resume / Delete actions (revealed on hover/focus on the desktop layout, always shown on touch/narrow). Delete asks for confirmation. Below the list: the add-topic form (submit via button or Enter).
- **FR-3.2a** *(NEWS-63, NEWS-140)* A **sort dropdown** sits on the "Watching" header line (right side, shown once there's more than one topic): **A → Z** (default), **Recently added** (newest first), **Newest stories** (FR-3.60), **Priority first** (high-priority topics on top, then A→Z), and **By section** — taxonomy order (not alphabetical, so it matches the filter bar), A→Z within each section, unclassified last, with a heading opening each group.

  **FR-3.54** *(Shipped, NEWS-154)* Those headings are **larger than the "Watching" eyebrow above them, and carry no rule.** At `0.68rem` a heading was a hair *smaller* than the label for the list itself, which is backwards — they are the structure the eye scans to find a topic. The underline went with the row rules (FR-3.52): once whitespace does the separating, an underlined heading is the one thing left fenced in. The E2E sizes the heading *against the eyebrow* rather than against a magic number, because that comparison is the complaint.

  The headings are entries in the **same flat list** as the topics rather than a nested structure. A nested list would mean an `each()` inside an `each()` row, which kerf never reconciles (see the delegate/morph section below), and grouping with `.map()` instead would give up the per-row memoization the topic rows rely on. Each heading is `role="presentation"`: a listbox may only contain options, so a heading claiming to be one would be selectable to a screen reader and would fail the axe suite. A topic whose stored slug is no longer in the taxonomy sorts *and* renders as unclassified — the heading and the rows beneath it must agree. Ordering is display-only (the scheduler keeps its own order) and persisted per device (`news:topic-sort`). `sortTopics` in `src/client/topic-sort.ts`; shift-range selection ranges over the *displayed* order.
- **FR-3.3** Feed: news items across all topics, newest first, **grouped by local calendar day** with Today / Yesterday / "Mon D" headers. Each item has a topic tag, relative found-time, serif title + summary, and source links (prefixed with the outlet's favicon where one resolved, else the arrow glyph — FR-8.14) opening in a new tab (`rel="noopener noreferrer"`). Items animate in on first render (respecting `prefers-reduced-motion`).
- **FR-3.4** Errors from user actions appear in an error banner; the most recent failed check (when no action error is showing) appears in a warning banner naming the topic and error.
- **FR-3.5** The client polls `/api/state` every 4 s while the tab is visible, so scheduled-check results appear without a reload. It also refreshes **on becoming visible again**, so returning to the app does not show what was true when you left it until the next tick (NEWS-238). The scheduling lives in `src/client/poll.ts` with its dependencies injected, because a rule about *when* to ask cannot be tested through a real 4-second timer.
- **FR-3.5a** *(Shipped, NEWS-238)* **A `<select>` follows the server even after the user has touched it.** HTML sets an option's *dirtiness flag* the moment its selectedness is set by the user or by script, and from then on the `selected` content attribute — which is what a morph writes — no longer moves the selection. kerf bypasses that by setting the property whenever it changes the attribute; the gap is when the attribute **doesn't** change, because the render agrees with the DOM. Then nothing is written and the drift is permanent, since every later render agrees too.

  Observed as: shorten the default check interval below the high-priority one and the high-priority dropdown keeps showing the old value although the server has clamped it — the stored setting correct, the control lying about it. `src/client/select-sync.ts` closes it by making the rendered attribute authoritative after every render: no per-control wiring, inert whenever the two agree, and it cannot disagree with what was just rendered. Guarded by a unit test on the rule and an E2E that dirties a control deliberately, since the interleaving that produces it in the wild cannot be scheduled.
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

### The settings dialog has one control column (NEWS-268)

`$field-label-w` (132px) and `$field-gap` (12px) in `styles.scss`, with `$field-control-x` **derived** from them — that last part is what stops them drifting again.

They were three separate copies of one measurement with three different answers: `.field-label` at 132px with a 12px gap put controls at 144; `.key-provider` at 120px with a 10px gap put the API key inputs at 130; and `.source-status` declared `margin-left: 132px` **above** a `margin: 8px 0 0` shorthand that reset it to zero, so its indent had never once applied and it sat flush with the dialog's edge. The comment above it claimed it "sits under the provider picker", describing an intent the next declaration silently overrode.

The visible symptom was small — Settings → Source showed its two field groups 14px apart on both edges, the kind of misalignment nobody names and everybody registers — and the third element was only found by fixing the first two and measuring again.

**The guard measures the browser, not the stylesheet.** `keys.spec.ts` asserts the three left edges are equal. Asserting against the SCSS variables would have passed the whole time this was broken, since the values were right and a shorthand was eating one of them.

### A cleared topic reads as never checked (NEWS-273)

The sidebar status is a four-state ladder — `checking…` / `paused` / `checked <relative time>` / `not checked yet` — and after clearing every story a topic still read **"checked 1d ago"** beside an empty feed. Every word of that was true and the sentence was misleading: it implies the app is holding what the check found, so a reader takes it for the clear having failed.

**This took two attempts, and the first one is worth recording because its reasoning was half right.**

The first fix qualified the sentence: `checked 1d ago · no stories`. The check time stayed on the grounds that the topic *was* checked then and the timestamp is what the dial counts down from (NEWS-144) — and, decisively, that nulling `lastCheckedAt` would make every topic *due*, so a clear would kick off a full sweep on the next minute tick, contradicting NEWS-271, which had just made clearing **stop** checks.

That scheduling objection was correct. The conclusion drawn from it was not: it treated one field as having to serve both display and due-ness, and so traded the honest sentence away to protect the schedule. The owner rejected the result — a cleared topic should read as one we have never checked, because that is what it now is.

**Both are satisfied by splitting the field, not by choosing between them** (NEWS-291, FR-1.15). Clearing resets `lastCheckedAt` to null and records `clearedAt`; the UI reads the former and shows `not checked yet`, while the scheduler reads `lastCheckedAt ?? clearedAt` and waits a full interval. Nothing in this file needs to know about the second field — the row's four-state ladder is unchanged, and the state it renders after a clear is simply the one a brand-new topic renders.

**`· no stories` stays**, for the case it is actually right about: a topic that has genuinely been checked and found nothing (a quiet week, or the mock's "empty" topic). That is a real state, distinct from a cleared topic, and it deserves the sentence it was given. What changed is that a clear no longer produces it.

Presence is read from `newestItemAtByTopic`, which the state payload already carries for the most-recent sort — and it had to be added to `topicRowCacheKey`, because `each()` memoizes a row against that string and anything the row renders has to be in it. Keyed on **presence, not the timestamp**: keying on the value would invalidate the memo on every new story and re-render the sidebar for a sentence that did not change.

**Three surfaces speak about checking, and they do not all answer the same question.** The complaint named "labels per item", so all three were audited:

| Surface | After a clear | Why |
|---|---|---|
| `.topic-meta` text | `not checked yet` | a claim about the **past**, and it is true — we hold nothing and asked nothing |
| the dial ring + tooltip | drains from the clear; `Next check in 23h` | a claim about the **future**, and a check really is coming one interval after the clear. Left on `lastCheckedAt` it would have shown a full ring and "Waiting for first check" for a whole day while one silently approached — the same species of lie as the original bug, pointing the other way. `dial.ts` mirrors the server's `scheduleBaseline` for this |
| Diagnostics run rows | unchanged | the run history survives a clear on purpose (FR-2.13); it is a record of what the *app* did, not a claim about the topic |

The "falling behind" banner is deliberately quiet about a cleared topic: `isBehindSchedule` already excludes never-checked topics ("they're new, not behind"), and a cleared topic is new by construction.

**The feed had its own copy of the problem**, and it is the general shape rather than one oversight: the client owns per-story state the server refresh cannot reach, so every such field has to be dropped explicitly. `clearStoryOverlays` is that one place, and it drops four things:

- **`recentlyFlaggedItems`** — an overlay of stories flagged this session, merged into the feed so a misclick stays undoable (NEWS-61). `refreshState` cannot empty it, because the server does not know it exists, so a clear left any just-flagged story rendering over an emptied feed.
- **`reviewTopicIds`** — review shows *only* flagged stories, so staying in it would strand the user behind a banner explaining why an unfillable feed is filtered.
- **`expandedItemId`** + `threadShowAll` (NEWS-281/282) — it would name a story that no longer exists. Every other view change in the store already nulls it, and a clear is the most drastic view change there is.
- **`threadPanes`** (NEWS-282) — a per-story cache of fetched threads whose invalidation rule is the thread's *size*. A clear does not change a size, it removes the thread, so nothing about that rule would ever evict these. No visible bug (story ids are UUIDs, so a new story cannot collide with a cached entry) — dropped because the store should not go on holding fetched data about deleted stories.

Called **before** the request, so there is no frame in which the refreshed empty feed renders with the stale overlay still merged in.

### A mode's exit must look pressable (NEWS-266)

`.btn.subtle` was `background: none; border-color: transparent; color: var(--ink-soft)` — at rest it was indistinguishable from the prose beside it, and only grew a border on hover. That is a reasonable treatment for a tertiary action and the wrong one for **the only way out of a mode**, which is what it was being used for in all four places the app has one: the saved-filter banner, the solo banner, the review banner, and the tuner's *Done*. (The variant itself has since been fixed — next section — but the weight argument stands: an exit outranks the quiet variant either way.)

The weight was backwards. Skip and Keep inside the tuner read as buttons while the escape from a six-round flow read as a caption; the review banner filtered the entire feed and offered a text-coloured exit. All four are now plain `.btn`, which has a border and a panel background — clearly pressable, still not `.btn.primary`, so *Keep* stays the loudest thing in the tuner.

**All four, not the two that were reported.** Promoting some would have left the app less coherent than leaving them alone, and "the exits are quiet" was the finding — a pattern, not two bugs.

Two decisions worth keeping:

- **Placement did not change.** Every banner in the app is `icon · text (flex:1) · action`, so the action sits at the right edge. The distance from the sentence is real but it is the app's own convention, and one banner breaking rank is worse than a long gap. A bordered button at a banner's edge is not hard to find.
- **The tests assert computed style, not the class.** `class="btn"` passing is not the point — a visible edge is. A future change to `.btn` that dropped its border would sail through a class assertion while reintroducing exactly this bug.

### Quiet is a hairline, not nothing (NEWS-305)

NEWS-266 promoted four call sites out of `.btn.subtle`. It did not touch the variant, so everything still on it kept the same defect — and the design review found it again on **Settings → App**, where `Send a test notification` and `Show the setup guide again` were unbordered, unfilled `--ink-soft` text sitting among unbordered, unfilled `--ink-soft` prose. Two features whose only entrance read as a caption.

Promoting call sites one at a time is how a variant nobody can press survives, so the fix is the variant:

- **A resting edge.** `border-color: var(--line)` at rest, `--pine` on hover. Still no fill, so the hierarchy the variant exists for is intact — it reads as secondary beside `.btn`, not as a demoted one.
- **Disabled keeps the edge and only fades.** `.btn:disabled` is `opacity: 0.5`, which is right for a filled button and takes a hairline below legibility in dark mode, so `.btn.subtle:disabled` fades to `0.65` instead. "A control that is currently off" is information; "slightly greyer text" is not.

`Send a test notification` is **not** disabled and should not be — it asks *will the OS take one*, which is a different question from *do I want one per story*, and it works with the toggle off (NEWS-260, pinned in `app.spec.ts`). The review read the two buttons' brightness difference as a disabled state; there was never a `disabled` on it.

Tested in two places because the two halves live in different worlds: the resting edge by computed style in `layout.spec.ts` (a class assertion would pass while the border was gone), and the disabled rule in `tests/unit/subtle-button.test.ts` against the stylesheet — every subtle control that *can* be disabled is desktop-only, so the browser E2E build has none to point a camera at.

### A variant the stylesheet never defined (NEWS-304)

`class="btn danger"` was on the restore-backup control, and **`.btn.danger` did not exist**. The extra class is inert, so the button rendered as a plain `.btn`.

Nothing failed, and nothing could: the markup expressed the intent, the browser ignored it, and the *design review* then recorded the app as already having a danger variant — citing that call site as the evidence — while looking at a neutral button. A class name that reads as a decision in the JSX and is a no-op on screen is worse than the NEWS-133 `icon-btn` case, where the fallback was at least visible.

There are now three weights, and the middle one is the new part:

| | |
|---|---|
| `.btn` | neutral |
| `.btn.danger` | marked — red ink, tinted hairline, no fill. For controls that *open* a confirm |
| `.btn.danger-solid` | filled red. The confirm dialog's point of no return |

`danger` is outline rather than fill on purpose: both its users open a confirm, so matching the weight of the irreversible button on the other side of that dialog would flatten the escalation to nothing. The ink lifts to a lighter tint in dark mode, the same value `.menu-item.danger` already used.

**`tests/unit/button-variants.test.ts` reads the variants out of `app.tsx` and requires each to be styled somewhere it can reach a button.** "Appears in the stylesheet" is the obvious check and is wrong in exactly the way that hid this: `danger` *did* appear — as `.menu-item.danger`, and as `&.danger` inside `.chip`. Both style a `danger` that is not a button's. The test is pinned against the pre-fix stylesheet, where it fails on `danger` and passes on all five other variants.

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

## The expandable story card (NEWS-281)

Left-click on a story card was the last unclaimed gesture in the feed, and the obvious thing to do with it — open the first source link — is explicitly **not** what this does. The sources already open a browser (`data-external="1"`, FR-3.8); a card that also did would make the whole surface one big link and leave the app with nowhere to put content of its own. **Clicking a card expands it in place**, and the pane that opens is where app-native detail lives. NEWS-282 fills it with the story's thread (see [29 — Story Threads](29-story-threads.md) FR-29.28–29.35); NEWS-281 built the shell first, so the interaction, the accessibility and the morph-stability could be reviewed on their own.

- **FR-3.63** *(Shipped, NEWS-281)* Clicking a story card's **body** — the title, the summary, the picture, the whitespace — toggles a detail pane at the foot of that card. It never navigates and never opens a browser. The pane is a drawer inside the card's own edges (`--paper` inside a `--panel` card, which is an inset well in both schemes), so the expansion reads as the card growing rather than as something appearing next to it.

- **FR-3.64** *(Shipped, NEWS-281)* **One card at a time — an accordion, not a set.** Two reasons, neither of them "it was simpler": cards lay out in a grid whose rows stretch every card to the tallest on the line (FR-3.37), so a second open pane grows a row that has already grown; and the pane is *reading* surface, which is something you do to one story at a time. Expansion is **ephemeral and view-scoped** — every action that replaces the list (Solo, Saved, search, the section filter, entering review) collapses it, for the same reason Solo itself doesn't persist: a pane pinned to a story no longer on screen is state with nothing left to close it. **Escape collapses**, on its own rung of the ladder in FR-3.21: after every dialog *and* after the menus, since a menu opens over a card, but before the clear-selection rung, so one press does one thing.

- **FR-3.65** *(Shipped, NEWS-281)* **The expander is a real button**, in the card header beside bookmark and share, carrying `aria-expanded` and `aria-controls` pointed at the pane. An `<article>` with a click handler is focusable by nobody and fails the axe suite, and wrapping the card *in* a button was not available — that would nest the source links inside a button, which is invalid HTML. So the button is the affordance and the body click is a convenience on top of it; Enter and Space both work, and the disclosure chevron rotates off `aria-expanded` rather than off a second class, so what is drawn cannot disagree with what is announced. This is the same wiring as the sidebar toggle → `#topics-panel`.

  **Which is why the pane is an always-present container that fills and empties**, exactly like `div.item-media` beside it and `#banners` / `#toast-slot` above: a conditionally-rendered pane would restructure the card on every toggle, *and* it would leave `aria-controls` pointing at nothing half the time — which the axe suite already fails on (NEWS-99). `.item-pane:empty { display: none }` is what makes it invisible while collapsed.

- **FR-3.66** *(Shipped, NEWS-281)* **A flagged one-liner and a review-mode card do not expand.** A dimmed `flagged-row` is on its way out of the feed and giving it a disclosure control would hand more chrome to a demoted story than to the ones around it; review mode is triage — "is this story about my topic?", answered by the title — and its header carries the off-topic pill where the expander would be. Neither variant renders an expander, and **the click handler keys off the button's presence** (`el.querySelector('[data-expand-item]')`) rather than re-deriving the variant from the DOM, so the affordance and the gesture cannot drift apart. Flagging the story you are reading collapses it in the same action, since the card it belonged to is about to become a one-liner.

- **FR-3.67** *(Shipped, NEWS-283)* **The card header is `topic · time · bookmark · share · expander`, and the expander is the only *control* in it that carries text.** A story in a thread needs to *say* so on the collapsed card — otherwise the timeline behind the click is undiscoverable — and the badge that says it is the expander's own label rather than a sixth element ([29 — Story Threads](29-story-threads.md) FR-29.36). One control, so its accessible name covers both the action and what it reveals, and no new per-story control in a row that has none to spare.

  **The label is the count alone ("4th update"); the date lives in its tooltip and accessible name.** This is the NEWS-71 crowding constraint measured rather than assumed: the widest a feed column gets is ~430px (two-column layout), and "· since Jun 12" on the end pushed the topic pill from one line onto **three**. The topic pill is the header's designated shrink target — `.item-time` and the actions are all `flex: 0 0 auto` (FR-3.2c, NEWS-112) — so a longer label does not truncate, it reflows the pill, which is the same failure NEWS-71 fixed. Every other header rule stands: the button stays `flex: 0 0 auto` and its label `white-space: nowrap`, mono at 10.5px like the rest of the "clockwork", taking the accent only on hover/focus. It is findable because it is the only *text* in the action cluster, not because it is loud.

### The click has to lose every fight it picks

A card contains a bookmark button, a share button, and a list of external links. `delegate()` matches by walking up from the event target, so **the card's handler runs for a click on any of them** — and the first handler to fire re-renders, moving the DOM under the ones that follow (the NEWS-126 lesson). Two decisions come out of that:

- **One delegate, one attribute.** The expander button is handled by the *same* `[data-item-id]` click handler that the body uses, not by a second delegate of its own. Two handlers matching the same click would each have to guess whether the other had already re-rendered.
- **The handler bails on `closest()`.** Inside `.item-actions` (bookmark/share), inside `ul.sources` (a link would otherwise open a tab *and* move the card — the regression that matters most, and the one the E2E pins hardest), and inside `.item-pane` itself, because clicking content the pane will grow must not close the pane it is in. It also bails when the click ended a **text selection**: dragging across a summary finishes with a click on the card, and collapsing the paragraph someone is copying out of is the worst available reading of that gesture.

`contextmenu` is untouched — right-click still opens the story menu, and a right-click never produces a `click` event.

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

- **FR-3.58a** *(Shipped, NEWS-174)* Each mark's accent **is** its theme's `--pine` — `#17604f` light, `#4da88e` dark — and this is gate-enforced rather than remembered.

  Nothing structurally connects an SVG file to a stylesheet: the mark's green is baked into the asset, the app's green lives in `styles.scss`, and a change to either is invisible to the other. That gap produced the same bug twice. First the dark mark shipped carrying the *light* green (2.39:1 on the dark page); then both files were set to the *dark* green, which moved the failure to light mode (2.60:1) rather than fixing it. Both rounds were caught by eye, which is not a mechanism.

  `tests/unit/brand-assets.test.ts` reads the real files and asserts the relationship: the accent equals the theme's `--pine`, and both halves clear a legibility floor against that theme's `--paper` (3:1 for the accent as a graphic mark, 4.5:1 for the ink). It also pins that the two accents *differ* and that each fails on the other theme's page — so a straight swap of the two files, which is how this went wrong the first time, cannot pass.

  **This is a legibility gate, not an accessibility one.** WCAG explicitly exempts logotypes from contrast minimums (SC 1.4.3 / 1.4.11), so the axe suite neither enforces this nor is affected by it. The reason to hold the line anyway is that the mark sits inches from the "Check all now" button and the section pills: two greens that are merely *similar* read as a mistake, and one that fails 3:1 reads as washed out.

  Fills are read **positionally** (first path = `News`, second = `monger.`) rather than by `id`, because the drawing tool has already renamed one — `monger` became `monger.` when the period was folded into the mark.

- **FR-3.59** *(Shipped, NEWS-183)* The feed's **day heading** — Today / Yesterday / "Jul 20" — is **larger than the eyebrow base it inherits, and carries no rule**. This is FR-3.54's correction applied to the other half of the app, for the same two reasons.

  At 11px it was the *smallest* type in the feed while being the structure the eye scans to find a day, which is backwards in exactly the way the sidebar's section headings were. Matched to `.topic-section`'s `0.8rem` so the app's two grouping headings read as one device rather than two unrelated ones.

  The rule went for a reason specific to the feed: the story cards below **already carry their own borders**, so a hairline under the heading fenced the group off from a page that separates by whitespace everywhere else — and it sat only a few pixels above the first card's own top edge, reading as a doubled line rather than as a divider. The margin it vacated became whitespace, so the heading still separates from the cards, by air.

  The E2E sizes the heading **against the eyebrow** rather than against a number, because that comparison is the complaint; and asserts the computed `border-bottom-width` is 0 rather than checking the declaration, since the rule could return through any selector.

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

- **FR-3.68** *(Shipped, NEWS-307)* **Every group on every tab carries a section eyebrow, and the first one carries no rule.**

  Three tabs used to open with an anonymous cluster of controls and only *start* labelling at the second group — Data went unnamed → `BACKUP` → `FEED`, Source unnamed → `API KEYS`, App unnamed → the Diagnostics disclosure. That says "the first group is not a group" about a group, and it costs the reader the one landmark they most need: the controls at the top of a tab are the ones most people came for, and they were the only region with no name to scan back to. Schedule had no eyebrows at all, which made it internally consistent and externally the odd one out.

  The groups are now: Schedule → **Cadence** / **Concurrency**; Source → **Provider** / **API keys**; Data → **Stories** / **Export** / **Backup** / **Feed** / **Reset** (FR-27.11); App → **Notifications** / **Setup** / **Updates** (desktop only) / Diagnostics.

  Naming them settled two things that had been hiding inside the anonymous clusters. Data's opening group was **two** groups — how long stories are kept and how to take a copy out are unrelated questions. So was Schedule's *Check at once*: how often to check and how many to run at a time are different decisions, and only one of them is a cadence.

  **Source's eyebrow repeats its first field's label**, considered and kept. Every alternative was either a synonym this project uses nowhere else — the vocabulary is "provider", in `PROVIDER_NAMES` and [6 — AI Providers](6-providers.md) — or a phrase too long for a mono eyebrow. A section named after the control it is built around is an ordinary pattern; inventing a word for it is not.

  **The `Updates` eyebrow lives inside the `isTauri()` conditional**, not above it. Outside, the browser build would render a heading over nothing — which is the defect NEWS-309 reports for `DIAGNOSTICS`, and there is no reason to add a second instance of it while fixing the class.

  **No rule above the first heading.** Every later eyebrow has a `border-top` separating it from the group before; the first has nothing above it to separate from, and a border there sits a few pixels under the tab bar's own and reads as a doubled line. Same correction FR-3.54 and the day headings made, for the same reason.

  **Eyebrows take no icon** — the other half of the report. `DIAGNOSTICS` was the only heading-ranked thing in the dialog carrying one (a bug glyph), which read as arbitrary decoration on one of five headings. But it is not an eyebrow: it is a `<summary>`, and `list-style: none` had already removed its disclosure marker, so deleting the icon would have left a control with no affordance at all. It now carries a **chevron** that rotates on open, matching the story card's expander (FR-3.63) — so the one heading-shaped thing that is really a control says so, and the app has one disclosure gesture rather than two. The `bug` icon was the only user of that entry in `icons.tsx` and was removed with it.

  Pinned per tab in `tests/e2e/app.spec.ts` — positionally, since the defect was that a heading existed but was not *first*. A count of headings would have passed on all four tabs while three of them opened anonymously.

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

- **FR-3.62** *(Shipped, NEWS-256)* **The Source panel reads provider → model → effort, with every note and status line below them.** That is the order the settings are decided in and, since NEWS-253/254, the order they *depend* on each other: the provider decides which models are offered, and the model decides which effort levels are — and whether the control is usable at all. The old layout put effort between the provider and the model, asking a reader to hold a dependency the page was contradicting.

  A **reorder, not a flatten**: every conditional keeps its always-present wrapper. Those containers outlived the kerf bug that prompted them (NEWS-99) — `#banners`/`#toast-slot` are ARIA live regions that must exist before their content, and removing an `aria-controls` target fails the axe suite — so moving a block means moving its wrapper with it.

  Pinned by document position in the E2E rather than by eye, since a reorder is exactly the kind of change a later edit undoes without anyone noticing.

Settings (check interval, provider, model, endpoint, API keys) live in a modal opened from the header gear. The **source status** — whether the chosen provider can actually run, and which provider last ran a check — sits under the provider picker here rather than in the sidebar: the provider is chosen here, so this is where knowing whether it works is useful, and it doesn't repeat the provider's name because the picker directly above states it. A provider that can't run still surfaces on the page through the failed-check warning banner, so nothing is lost by not duplicating it in the sidebar — see [7 — API Keys and Settings Dialog](7-api-keys.md). Two structural points belong here:

- The dialog is a conditional sibling, so it renders inside an always-present `#settings-slot` container (the KF-377 rule below).
- The backdrop and the close button use **different** actions. Delegation matches against the target's ancestors, and the backdrop wraps the dialog — so a shared `close-settings` action made every in-dialog click (including Save) match a closing ancestor and dismiss the dialog mid-submit. Backdrop click-away fires only when the click landed on the backdrop element itself.


## Sidebar: what each topic has produced

- **FR-3.60** *(Shipped, NEWS-241)* A **Newest stories** sort orders topics by the timestamp of their most recent story, newest first. **Topics that have never produced one sink to the bottom**, in A→Z order among themselves — a missing timestamp is *absent*, not empty, and treating it as an empty string would sort those topics **first** under a descending compare, which is the exact opposite of what the option promises. Ties fall back to A→Z so the order is stable between polls.

- **FR-3.61** *(Shipped, NEWS-242)* Each topic row carries a **count of the stories found today**, in the left gutter under the dial beside the priority star.

  Three decisions, none of them forced:

  - It counts on **`foundAt`**, not the published date, because the feed's day headings already group on `foundAt` — a badge counting anything else would disagree with the list it sits next to, reading "3 today" above two visible rows.
  - It **excludes off-topic stories**, exactly as the feed does. The badge is a promise about what you will see if you click it.
  - **Zero renders nothing**, rather than a `0`. A column of zeros down a quiet sidebar is noise that teaches you to stop reading the badge, which costs you the one day it matters.

  "Today" is the **server's local midnight**, which is the user's: the app runs on their machine and is reached over loopback. Both this and FR-3.60's timestamps ride the existing `/api/state` poll as `todayByTopic` and `newestItemAtByTopic`, computed in one query (`store.itemStatsByTopic`) rather than two scans of `items`.

  The count is part of the topic rows' `each()` **memo key**. It lives in `todayByTopic`, not on the topic object, so a badge going 2 → 3 changes nothing `each()` can see by identity and the row would keep its cached HTML until some unrelated field happened to move (the same hazard the category field has).

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
