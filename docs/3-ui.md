# 3 — Web UI

A single-page kerfjs app served by the Node server; the same UI runs in the browser and in the Tauri webview.

### Visual design

"The overnight briefing." Two-column layout (a sticky **Watching** rail + a **feed**), collapsing to one column under 860px. Bookish serif (`Iowan Old Style`/`Charter`/Georgia) for the stories themselves; quiet sans for controls; mono for the "clockwork" (eyebrows, timestamps, topic tags, meta). Cool porcelain paper in light mode, pre-dawn slate-green in dark; pine-green accent with a marigold "active" state.

**Signature element — the watch dial**: each topic carries a small SVG ring that fills clockwise as the fraction of the check interval elapsed since its last check (an at-a-glance "how close to the next check"). It spins marigold while a check runs and goes dashed when paused. Purely decorative/informational (`aria-hidden`), with a text `title`; the textual status line remains the source of truth.

- **FR-3.1** Header: serif wordmark, the global check-interval selector (presets 1h / 3h / 6h / 12h / 1d / 2d / 1w), and a "Check all now" button (disabled while any check runs).
- **FR-3.1a** Source block (top of the Watching rail): an AI-provider picker (Auto / Anthropic / OpenAI / Mock), a model field (shown for non-auto/mock), and an endpoint field (shown for OpenAI), persisted via `PATCH /api/settings`. A status line shows the selected provider's availability (from `GET /api/providers`, probed on demand) and the provider that ran the last check. See [6 — AI Providers](6-providers.md).
- **FR-3.2** Watching rail: a list of topics — dial, name, status line (checking… / paused / checked \<relative time\> / not checked yet), and per-topic Check / Pause–Resume / Delete actions (revealed on hover/focus on the desktop layout, always shown on touch/narrow). Delete asks for confirmation. Below the list: the add-topic form (submit via button or Enter).
- **FR-3.3** Feed: news items across all topics, newest first, **grouped by local calendar day** with Today / Yesterday / "Mon D" headers. Each item has a topic tag, relative found-time, serif title + summary, and source links (prefixed with an arrow) opening in a new tab (`rel="noopener noreferrer"`). Items animate in on first render (respecting `prefers-reduced-motion`).
- **FR-3.4** Errors from user actions appear in an error banner; the most recent failed check (when no action error is showing) appears in a warning banner naming the topic and error.
- **FR-3.5** The client polls `/api/state` every 4 s while the tab is visible, so scheduled-check results appear without a reload.
- **FR-3.6** Empty states: an invitational hint when there are no topics, and a "no stories yet" hint when topics exist but no items do. Both render inside a stable `.empty-slot` wrapper so their appearance/disappearance can't disturb the keyed lists (kerf KF-377).
- **FR-3.7** The UI supports light and dark color schemes (`prefers-color-scheme`), plus visible keyboard focus and `prefers-reduced-motion`.
- **FR-3.8** In the Tauri webview, source links route through `POST /api/open-external` to open in the system browser (http/https only).

### kerf structural conventions (learned the hard way)

Two rendering rules this UI depends on — regression-tested by the E2E suite:

- Keep sibling structure around keyed lists stable: conditional elements (banners) live inside an always-present container (`#banners`). **This works around a confirmed kerfjs 2.0.0 bug (kerf KF-377)**: removing a conditional sibling rendered before a keyed `each()` list permanently empties the list (verified in a minimal standalone repro attached to that ticket).
- Keep `each()` containers structurally stable: empty-state messages render *alongside* the list, not instead of it. The pure container swap (`<p>` ↔ `<ul>{each(...)}</ul>`) tested OK in isolation on 2.0.0, so this one is defensive convention rather than a confirmed trigger — but the app's original failures involved the combination, and the stable shape is regression-covered here and flagged for a pinning test in KF-377.

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

Icons are inlined from `lucide-static@1.26.0` in `src/client/icons.tsx` rather than taken as a dependency: six icons is a few hundred bytes against a package that would be staged into the desktop sidecar's `node_modules`.

### Solo is deliberately ephemeral

Solo lives in memory and is cleared on reload. A solo that survived a restart would silently hide news days later, and "the app stopped finding anything" is a far worse failure than having to re-apply a filter. It is also cleared for any topic that no longer exists, so a deleted topic can't leave the feed filtered against nothing.

### Two structural gotchas this hit

**`each()` memoizes rows on object identity, and selection lives outside the topic object.** Without a `cacheKey`, selecting a row appeared to do nothing — the cached row HTML was reused, and the change only showed up seconds later when the poll happened to replace `topics` with fresh objects. The fix is `each()`'s third argument, a comparator over the external state the row renders:

```tsx
each(s.topics, (t) => topicRowJsx(...), (t) => `${selected.has(t.id)}|${solo.has(t.id)}|…`)
```

**The menu backdrop wraps the menu, so a shared close action swallows the item click.** `[data-action=close-menu]` matches by ancestor walk, so a click on a menu item also matched the backdrop; the menu closed and cleared `contextMenu` before the item handler could read it, and the action silently did nothing. The handler now closes only when the click landed on the backdrop element itself. This is the same trap the settings dialog hit — worth checking on any future overlay.

## Collapsible topics sidebar

- The topics sidebar (`#topics-panel`) collapses via a panel-glyph toggle at the left of the header. Collapsed, the grid drops to a single column and the feed reflows to the full width (measured: 652px → 1012px at a 1100px viewport).
- The choice persists **per device** in `localStorage` (`news:sidebar-collapsed`), not in `data.json` — how you've sized your own window is a view preference, not something belonging in the shared data file alongside topics and stories. Reads and writes are guarded so a non-browser import or disabled storage can't throw.
- The toggle carries `aria-expanded` / `aria-controls`, and its glyph reflects state (the panel divider thickens when the sidebar is showing) rather than only naming an action.
- Collapsing hides the Source status line and the add-topic form along with the list, since they live in the same panel. Expanding is required to add a topic — acceptable, and the toggle is always visible.

**Structural note:** the panel is *always rendered* and hidden with CSS, never unmounted. Removing it would drop a sibling ahead of the keyed `each()` topics list — exactly the KF-377 hazard below. The E2E test asserts both that the panel is hidden and that `#topics-panel` still exists, so a future refactor to conditional rendering fails loudly instead of silently emptying the list.

## Settings dialog

Settings (check interval, provider, model, endpoint, API keys) live in a modal opened from the header gear. The **source status** — whether the chosen provider can actually run, and which provider last ran a check — sits under the provider picker here rather than in the sidebar: the provider is chosen here, so this is where knowing whether it works is useful, and it doesn't repeat the provider's name because the picker directly above states it. A provider that can't run still surfaces on the page through the failed-check warning banner, so nothing is lost by not duplicating it in the sidebar — see [7 — API Keys and Settings Dialog](7-api-keys.md). Two structural points belong here:

- The dialog is a conditional sibling, so it renders inside an always-present `#settings-slot` container (the KF-377 rule below).
- The backdrop and the close button use **different** actions. Delegation matches against the target's ancestors, and the backdrop wraps the dialog — so a shared `close-settings` action made every in-dialog click (including Save) match a closing ancestor and dismiss the dialog mid-submit. Backdrop click-away fires only when the click landed on the backdrop element itself.


See also: [1 — Topics and Scheduling](1-topics-and-scheduling.md), [5 — Desktop App](5-desktop-app.md).
