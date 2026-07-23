# 3 — Web UI

A single-page kerfjs app served by the Node server; the same UI runs in the browser and in the Tauri webview.

### Visual design

"The overnight briefing." Two-column layout (a sticky **Watching** rail + a **feed**), collapsing to one column under 860px. Bookish serif (`Iowan Old Style`/`Charter`/Georgia) for the stories themselves; quiet sans for controls; mono for the "clockwork" (eyebrows, timestamps, topic tags, meta). Cool porcelain paper in light mode, pre-dawn slate-green in dark; pine-green accent with a marigold "active" state.

**Signature element — the watch dial**: each topic carries a small SVG ring that fills clockwise as the fraction of the check interval elapsed since its last check (an at-a-glance "how close to the next check"). It spins marigold while a check runs and goes dashed when paused. Purely decorative/informational (`aria-hidden`), with a text `title`; the textual status line remains the source of truth.

- **FR-3.1** Header: serif wordmark, the global check-interval selector (presets 1h / 3h / 6h / 12h / 1d / 2d / 1w), and a "Check all now" button (disabled while any check runs).
- **FR-3.1a** Source block (top of the Watching rail): an AI-provider picker (Auto / Anthropic / OpenAI / Ollama / Mock), a model field (shown for non-auto/mock), and an endpoint field (shown for Ollama / OpenAI), persisted via `PATCH /api/settings`. A status line shows the selected provider's availability (from `GET /api/providers`, probed on demand) and the provider that ran the last check. When the selected provider doesn't live-search (Ollama, Mock), a marigold **NOT LIVE** badge appears above the feed explaining results come from the model's own knowledge, not a live web search. See [6 — AI Providers](6-providers.md).
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

See also: [1 — Topics and Scheduling](1-topics-and-scheduling.md), [5 — Desktop App](5-desktop-app.md).
