# 3 — Web UI

A single-page kerfjs app served by the Node server; the same UI runs in the browser and in the Tauri webview.

- **FR-3.1** Header: app title, the global check-interval selector (presets 1h / 3h / 6h / 12h / 1d / 2d / 1w), and a "Check all now" button (disabled while any check runs).
- **FR-3.2** Topics panel: an add-topic form (submit via button or Enter), and a list of topics showing name, status (checking… / paused / checked \<relative time\> / not checked yet) and per-topic Check / Pause–Resume / Delete actions. Delete asks for confirmation.
- **FR-3.3** Feed: news items across all topics, newest first, each with topic tag, relative found-time, title, summary, and source links opening in a new tab (`rel="noopener noreferrer"`).
- **FR-3.4** Errors from user actions appear in an error banner; the most recent failed check (when no action error is showing) appears in a warning banner naming the topic and error.
- **FR-3.5** The client polls `/api/state` every 4 s while the tab is visible, so scheduled-check results appear without a reload.
- **FR-3.6** Empty states: a hint when there are no topics, and a "nothing found yet" hint when topics exist but no items do.
- **FR-3.7** The UI supports light and dark color schemes (`prefers-color-scheme`).
- **FR-3.8** In the Tauri webview, source links route through `POST /api/open-external` to open in the system browser (http/https only).

### kerf structural conventions (learned the hard way)

Two rendering rules this UI depends on — regression-tested by the E2E suite:

- Keep `each()` containers structurally stable: never conditionally swap a keyed-list container with another element (empty-state messages render *alongside* the list, not instead of it).
- Keep sibling structure ahead of keyed lists stable: conditional elements (banners) live inside an always-present container so their appearance doesn't shift unkeyed siblings, which kerf matches positionally.

See also: [1 — Topics and Scheduling](1-topics-and-scheduling.md), [5 — Desktop App](5-desktop-app.md).
