# Requirements Summary (AI summary)

Status markers: **Shipped** · **Partial** · **Design only** · **Deferred**. Source docs win on conflict.

## [27 — Where Data Is Stored](../27-data-location.md) — **Partial** (NEWS-192)

- **Decided A vs B in favour of B**, plus the owner's added requirement that the snapshot carry the config (topics, settings) but **never API keys**.
- **Shipped (FR-27.6–27.9):** a `backupDir` setting (`''` = off, Settings → Data); one file `newsmonger-backup.json` holding **topics + items + settings + runs**, written temp-then-rename so a sync client never sees a torn file; written at **startup and after a successful check**, throttled to **once an hour** (throttle reads the file's mtime, so it survives restarts); **"Back up now"** (`POST /api/backup`) bypasses the throttle. Failures are logged and swallowed — never fail a check.
- **The format is `DataFileSchema`, deliberately** — the shape the legacy `data.json` importer already reads (FR-4.8a), so **restore needs no restore code**: drop it into an empty data dir as `data.json`.
- **API keys are structurally absent** (keychain, not `Settings` — FR-7.x); asserted on the serialised bytes in both a unit test and an E2E test anyway.
- Why not A (relocate the live data dir): a **live WAL-mode SQLite database inside a directory a sync daemon rewrites** is a documented corruption route — WAL maintains an invariant across `.db`/`-wal`/`-shm` and a sync client moves them independently. FR-4.9's `backupUnreadableDb` exists because corruption already happens. `--data-dir` on a synced path is still possible for anyone who wants it; the UI just doesn't offer it.
- **Not built:** the prompt (FR-27.2–27.5) — offer after the **3rd topic**, no outside-click dismiss, **"Not now"** (re-ask in a day) / **"Don't ask again"**, OS-appropriate suggestions probed for on disk. Today the setting is only findable by opening Settings → Data.
- **Still open:** the path is **typed, not picked** — the browser build cannot produce a filesystem path the Node server can open (File System Access yields a sandboxed handle) and the desktop shell has no dialog plugin yet.

## [24 — Topic Discovery](../24-topic-discovery.md) — **Shipped** (variation D deferred, NEWS-129)

- FR-24.1–24.18, NEWS-116. Approved shape: **two doors into one result list** — a free-text box (FR-24.3) and a grid of the 11 NEWS-97 sections (FR-24.2) — with a **keep/skip tuner as the depth control**, not a third door (FR-24.5–24.9). Reached from beside the add-topic field and from onboarding's Topics step, replacing its six hard-coded chips.
- Variation **D** (persistent newsstand view) deferred: it is the only shape that spends on a schedule rather than on a click, and it reuses everything this builds.
- FR-24.35 **Shipped** (NEWS-137): the wait shows an estimated progress bar paced against the median of the last ten real call durations (30 s default, clamped 2–90 s, cache hits excluded). Reaches ~85% at the estimate then creeps to a ceiling it never touches; CSS-paced, so no timer and no per-frame re-render. `aria-hidden` — an estimated percentage is not a truthful claim.
- NEWS-138: privacy moved from the page footer to the foot of the sticky sidebar; the footer is now filled only when the sidebar is collapsed.
- FR-24.34 **Shipped** (NEWS-136): "More suggestions" appends a batch; already-shown names go up as `seen`, which *adds* to the server-side exclusions rather than replacing them. Exhausted state is stated rather than left as a button to press again.
- NEWS-133/134/135: the dialog now uses the app's established classes — `btn icon` for the close button, a `%text-field` placeholder for the search input (there is no global `input` rule), and real Lucide icons instead of `⌄`/`≈` glyphs. Guarded by a computed-background-lightness check in dark mode.
- FR-24.33 / FR-6.12 **Shipped** (NEWS-132): discovery runs on `claude-haiku-4-5` / `gpt-5-mini` with 3 searches and 4k output (a check gets 8 and 16k). Defaults only — an explicitly chosen model still wins. Haiku predates adaptive thinking *and* `web_search_20260209`, so the request shape varies by model (`usesLegacyRequestShape`).
- FR-24.19–24.21 **Shipped** (NEWS-124): `NewsService.suggestTopics` across all five providers, prompting in `src/ai/suggest-prompt.ts`, CLI JSON Schema passed as a runner parameter, and a deterministic mock keyed off a request seed. The mock **deliberately suggests an already-followed topic** when exclusions are present, so FR-24.11's second layer stays testable.
- FR-24.22–24.24 + 24.14/24.15 **Shipped** (NEWS-125): `POST /api/discover` (zod discriminated union → 400 on a mixed-up scope, 502 carrying the provider's message), `GET /api/discover/usage`, `src/discovery.ts` with the request cache, both exclusion layers and classification validation.
- FR-24.14's log is surfaced in the diagnostics bundle (NEWS-130); it records the scope *kind* only, never the free-text query.
- **FR-24.14 corrected**: it said discovery calls are "counted against the spend cap", but NEWS-119 removed the cap, the budget and the price table. There is nothing to count against — calls are *recorded* for visibility, and the real cost protection is structural (round ceiling + cache + user-initiated-only). The log is in memory: persisting would mean reusing the topic-shaped `runs` table, which drives the failure banner and falling-behind detector.
- FR-24.1–24.4, 24.12, 24.17, 24.25–24.28 **Shipped** (NEWS-126): the dialog with both doors, grouped result cards with ongoing/evergreen badges, and Add creating the topic with its guidance + classification in **one** request (a follow-up PATCH would land after the immediate first check had already run unsteered).
- FR-24.5–24.9, 24.29–24.32 **Shipped** (NEWS-127): the keep/skip tuner as a *depth control* reached from a card or the whole set, bounded rounds with a visible count, skips fed back as steer, and Done merging keeps into the list **uncreated**. State machine is pure and tested as sequences.
- FR-24.18 **Shipped** (NEWS-128, reworked NEWS-146): onboarding's Topics step opens **this dialog**, via the same `data-action=open-discover` as the sidebar compass — one attribute, one delegate, one implementation. It previously had its own smaller describe-box-and-chips discovery, missing the section grid, reasons, ongoing/evergreen labels, narrower/similar and More. Consequence: Add creates immediately there too, so the step's count reports "chosen" and "added already" separately (FR-20.6a). Starter chips kept as the documented fallback when no provider would resolve; the gate mirrors `resolveProvider`, and `AUTO_ORDER` moved to `src/ai/types.ts` so the client shares one definition.
- Cost is the governing constraint: every call recorded and capped like a check (FR-24.14), in-memory cache per request (FR-24.15), nothing on a timer (FR-24.16).

## [25 — Topic Editing](../25-topic-editing.md) — **Shipped** (NEWS-139)

- FR-25.1a **Shipped** (NEWS-162): the menu item is **"Edit topic…"** and the dialog *Edit "…"* / **Save** — "Rename" promised a cosmetic change to the one field where that's exactly wrong. Internals keep the `rename` name; `PATCH { name }` is precisely what it does.
- FR-25.1–25.4 rename from the topic menu; unique case-insensitively (renaming to the same name is a no-op, not a self-collision); a duplicate is a **409, not a 404**, and the dialog stays open so the name can be corrected in place.
- FR-25.5–25.9 optional clearing of that topic's stories, offered only when there are any and unticked by default. Clearing also resets `coveredThroughAt` — stories alone would leave the topic looking fresh while still behaving as covered, so the next check would report nothing. Run history is kept (it is about the app, not the topic). `clearItems` requires `name`, and the rename is applied **first** so a 409 can never land after the stories are gone.
- Deliberately unchanged by a rename: the **category** (re-classifying would move topics in the filter bar as a side effect of fixing a typo; FR-22.7 says a manual choice survives) and **guidance**.

## [1 — Topics and Scheduling](../1-topics-and-scheduling.md) — Shipped

- FR-1.14 **two schedule modes** — `interval` (default) or `daily` at fixed local times — NEWS-84: **Shipped**. A missed slot stays outstanding rather than skipping to tomorrow; before the first slot the obligation is yesterday's last; high-priority topics stay on their interval.
- FR-1.13 optional per-topic free-text guidance — see [18](../18-topic-guidance.md)

Add/delete/pause topics (unique, case-insensitive); global interval (default 1 day, min 5 min); minute-tick scheduler + startup sweep; sequential, non-overlapping checks; failures advance `lastCheckedAt` (retry next interval); manual per-topic and check-all triggers; **adding a topic checks it immediately** (manual-semantics, background-fired — FR-1.12, NEWS-54). All shipped and covered by unit + E2E tests.

## [16 — Feed Pagination](../16-pagination.md) — Client-side shipped; server-side deferred

- FR-16.1/16.2/16.3 client cap of 100 + "Show more" + reset-per-view — NEWS-62: **Shipped**
- FR-16.4 virtualized scrolling — evaluated and **rejected** (cap makes it unnecessary)
- Server-side pagination + filtering (feed on `/api/items`, `/api/state` slimmed, debounced search) — NEWS-74/75/76: **Shipped** — see [17 — Server-Side Pagination](../17-server-pagination.md)

## [21 — Export and Feed](../21-export-and-feed.md) — Shipped (off-machine reach deferred)

- FR-21.1–21.2 shared `scope=all|saved|topic` selection, newest-first, capped at 2000; off-topic stories excluded — NEWS-85: **Shipped**
- FR-21.3–21.5 Markdown (grouped by topic), JSON (topic names, not ids), and **Atom** at `/feed.xml` — entries keyed on item id, everything XML-escaped: **Shipped**
- FR-21.6 same-origin guarded; the "absent Origin is allowed" rule is what lets an RSS reader subscribe while a web page still gets 403: **Shipped**
- FR-21.11 **Shipped** (NEWS-161): the Export button is filled (`primary`) and uses a new `download` icon — it shipped with `share-2`, which names the wrong action — with its glyph flex-centred on the label rather than sitting on the text baseline.
- FR-21.9 **Shipped** (NEWS-158): one **Export stories…** button → one dialog asking *what* (all/saved) × *format* (md/json). Replaced three fixed buttons that covered three of the four — **saved-as-JSON had no way to be asked for**. Always reopens on All + Markdown. The Export control stays an `<a href>` so the NEWS-157 Tauri routing still applies. (FR-21.10, NEWS-160) **One topic** is now the third scope, with a picker — `scope=topic` had been server-only since NEWS-85. `exportHref` (`src/client/export-url.ts`) returns null when no topic is picked, and the dialog disables Export rather than silently falling back to `scope=all`.
- FR-21.8 **Shipped** (NEWS-157): `<a download>` is a **no-op in the Tauri WKWebView** — clicks were silently swallowed and all three export buttons looked dead. A `data-export` handler routes them through `/api/open-external` to the system browser (which saves them, since every export sends `Content-Disposition: attachment`). Reads the anchor's `href` **property**, not the attribute — the attribute is relative and the route rejects it. Same class as the `window.confirm` (NEWS-39) / `navigator.share` (NEWS-43) gaps.
- FR-21.7 reaching the feed from **another device**: **Deferred** — needs a bearer token + non-loopback bind, coupled to the NEWS-46 mobile line

## [26 — Undo](../26-undo.md) — **Shipped** (NEWS-145)

- FR-26.1–26.14 clearing a topic's stories is undoable for 60s from an Undo in the toast. Restores the stories **and** `coveredThroughAt` together, under the **original item ids** with `saved`/`offTopic` intact. `ClearUndoBuffer` (`src/undo.ts`) is in-memory and per-topic — deliberately not soft-delete, so a reload forfeits the undo (stated, not hidden). `POST /api/topics/:id/restore-cleared`; **410** when the offer expired, **404 + zero inserts** if the topic was deleted (items have no FK on `topic_id`, so a restore would orphan rows).
- Inline rename from the sidebar row was considered with this and **dropped** — worth doing only if renaming proves frequent, and the dialog is the right shape for the clear choice anyway.

## [20 — First-Run Onboarding](../20-onboarding.md) — Shipped

- FR-20.1–20.3 auto-opens only with no topics **and** no provider, only after both `/api/state` and `/api/providers` answer; dismissal remembered per device — NEWS-78: **Shipped**
- FR-20.4–20.8 four skippable steps (welcome → source → topics → schedule); a detected subscription CLI is offered **first**, since it needs no key at all: **Shipped**
- FR-20.6a/20.6b **Shipped** (NEWS-146): the Topics step opens the real discovery dialog, so topics can now arrive two ways — ticked (created at Finish) and added in discovery (created immediately). The count names both; wording is `src/client/onboarding.ts`. Escape gained a discovery rung above onboarding, or it closed the wizard *underneath* the dialog.
- FR-20.9–20.11 keys checked with the vendor before saving (models-list probe, not a completion); **only 401/403 blocks the save** — offline is "unknown", not "wrong key"; verifier injected, null under `--ai-test`: **Shipped**
- Auto-open on a genuinely fresh install is **manual** — the shared E2E server can never be in that state

## 19 — Cost Visibility — **Removed (NEWS-119)**

Spend estimation, the monthly budget cap and the updatable price table are gone, along with `docs/19-cost-visibility.md`. Settings shows nothing about money; `/api/state` carries no `spend` or `prices`; `monthlyBudgetUsd` and `priceManifestUrl` are no longer settings (the settings blob is zod-parsed, so stored copies are simply dropped on read — no migration needed).

**Token usage is still captured** on each `CheckRun` and is now unread. Kept deliberately as telemetry: it is the raw material if spend ever returns, and removing the column would be a schema migration for no visible gain.

## [18 — Topic Guidance](../18-topic-guidance.md) — Shipped

- FR-18.1–18.4 optional `guidance` on the topic (trimmed, capped at 1000, defaulted on load) — NEWS-80: **Shipped**
- FR-18.5–18.8 edited from the topic menu (single target only), muted sidebar badge, "applies from the next check" toast: **Shipped**
- FR-18.9–18.11 injected into the prompt as an instruction that outranks the model's own newsworthiness judgement, placed **ahead of** the off-topic examples; applies from the next check only: **Shipped**
- `checkTopic`'s 4th parameter is now a `TopicContext` object (guidance + offTopicTitles) rather than a bare title list

## [15 — Off-Topic Flagging](../15-off-topic-flagging.md) — Shipped

- FR-15.1/15.2 `offTopic` flag on items; story right-click menu (bookmark/share/flag) — NEWS-61: **Shipped**
- FR-15.3/15.4 just-flagged collapses to a dimmed pill row (hover ×, click to unflag); hidden on reload: **Shipped**
- FR-15.5 topic-menu "Review Flagged" (count badge) → review mode with exit banner: **Shipped**
- FR-15.6 flagged titles (capped 10) fed to the prompt as negative examples: **Shipped**

## [14 — Feed Search](../14-search.md) — Shipped

- FR-14.1 live header search box; case-insensitive match on title/summary/topic name — NEWS-60: **Shipped**
- FR-14.2 composes with Solo/Saved; ephemeral query: **Shipped**
- FR-14.3 compact box that animates wider on focus/non-empty, with a clear button: **Shipped**
- FR-14.4 "no stories match" empty state: **Shipped**
- Live on-demand web search: **Deferred** (feed-filter only for now)

## [13 — Scheduling Under Load](../13-scheduling-under-load.md) — Shipped

- FR-13.1 overrun cycle restarts immediately (scheduler drains; `checkDue` returns a count) — NEWS-57: **Shipped**
- FR-13.2 due topics serviced most-overdue-first, high-priority ahead (`byCheckOrder`) — NEWS-58: **Shipped**
- FR-13.3 dismissible "falling behind" banner when cadence lags ≥2× the interval — NEWS-59: **Shipped**
- FR-13.4–13.7 **bounded-concurrency sweeps** (`checkConcurrency`, default 3, 1 = old behaviour); shared cursor so a slow topic doesn't block a worker; `byCheckOrder` still decides who *starts*; attendance still stamped per topic — NEWS-81: **Shipped**

## [12 — Topic Priority](../12-topic-priority.md) — Shipped

- FR-12.1 single high-priority tier (`highPriority` boolean on the topic): **Shipped**
- FR-12.2 separate high-priority interval; `effectiveInterval` selects per topic: **Shipped**
- FR-12.3 high-priority interval kept ≤ default by bidirectional clamping (on update AND on load): **Shipped**
- FR-12.4 cadence only — not sweep ordering (NEWS-58), not the attendance gate: **Shipped**
- FR-12.5 marked via right-click menu; star indicator in the sidebar: **Shipped**

## [2 — News Checks and Deduplication](../2-news-checks-and-dedup.md) — Shipped (real-API path untested)

- Prompt window wording scales with the gap (first check / hours / 1 day / ≥2 days catch-up): **Shipped**
- Model output sanitized (citation markup stripped) on both write and read: **Shipped**
- Digest-size bound in the shared system prompt (wider span, not longer list) — portable across all providers, since only `anthropic` has a tool-level cap: **Shipped**
- FR-1.10 `coveredThroughAt` separate from `lastCheckedAt` so a failure can't discard pending news: **Shipped**
- FR-2.6–2.10 **citation verification** (HEAD → ranged GET, dedup'd + bounded, SSRF-vetted): dead sources pruned, story dropped only if nothing resolves, run **before** dedup so a dropped story can't burn its key; best-effort — NEWS-83: **Shipped**

Default Anthropic provider (`claude-opus-4-8` + web search), prompt-level exclusion of known stories, fenced-JSON result parsing, URL/title dedupe keys, per-topic scope, mid-check-deletion safety, `--ai-test` mock — now behind the provider abstraction (see [6 — AI Providers](../6-providers.md)). **Caveat:** the live Anthropic/OpenAI request paths have not been exercised against the real APIs (no keys in the dev environment) — `parseNewsResult` and everything downstream is tested; the requests are follow-up verification (NEWS-3, manual test plan).

## [3 — Web UI](../3-ui.md) — Shipped

- FR-3.59 (NEWS-183): the feed's **day heading** (Today / Yesterday / "Jul 20") is larger and **has no rule** — FR-3.54's sidebar correction applied to the feed. Matched to `.topic-section`'s 0.8rem so both grouping headings read as one device. The rule specifically fenced a group whose cards already carry their own borders, and sat pixels above the first card's top edge, reading doubled.

- FR-3.58a (NEWS-174): each wordmark's accent **is** its theme's `--pine`, gate-enforced by `tests/unit/brand-assets.test.ts` (it reads the SVG fills and the SCSS token blocks and compares them). Nothing else ties an asset's baked-in colour to the stylesheet, and that gap shipped the same contrast bug twice.
- FR-3.58 (NEWS-175): the masthead is the **wordmark SVG asset**, not body-serif text imitating one. `<picture>` + `prefers-color-scheme` swaps light/dark with no JS; the `<h1>` and an `alt="Newsmonger"` keep the outline and accessible name unchanged. New assets must be added to **both** client-build copy lists in `package.json` or they never reach `dist/client`.
- FR-3.2c (NEWS-142/143/144): topic names **wrap** rather than truncate; guidance shows as **text** below the name (2 lines, 10 when solely selected) replacing the icon; the dial **counts down** — full after a check, empty as the next comes due, and full while paused.
- NEWS-141: the toast raised when adding a discovered topic never cleared — it called the store action directly instead of `showToast`, which owns the timer. The action is now `setToastRaw` so a direct call reads as wrong.
- FR-3.2a sidebar sort gained **By section** (NEWS-140): taxonomy order rather than alphabetical, unclassified last, with a `role="presentation"` heading opening each group. Headings are entries in the same flat keyed list as the topics — a nested list would be an `each()` inside an `each()` row, which kerf never reconciles.

- Collapsible topics sidebar (localStorage-persisted, panel stays mounted): **Shipped**
- Topic selection (click / Cmd-click / Shift-range), right-click context menu with Lucide icons, bulk actions, Delete key: **Shipped**
- All icons are Lucide; no emoji or text glyphs anywhere in the UI (E2E-guarded): **Shipped**
- Source status moved from the sidebar into the settings dialog: **Shipped**
- Solo (show only chosen topics' stories) — additive, banner + dimming, ephemeral by design: **Shipped**
- Bookmark/save stories + Saved feed filter, and Share a story — see [11 — Story Actions](../11-story-actions.md): **Shipped**
- Error/warning banners are dismissable; the failure warning's dismissal is remembered by run id so a new failure reappears (NEWS-41): **Shipped**
- Destructive confirmations via an in-app dialog, never `window.confirm` (a WKWebView no-op that broke delete in the desktop app — NEWS-39): **Shipped**

- KF-377 workarounds **kept deliberately** after kerfjs 3.0.0 went stable — `#banners`/`#toast-slot` are ARIA live regions (must exist before their content), `#topics-panel` is the `aria-controls` target (removal fails axe) — NEWS-99: **Decided, no change**
- **docs/23-retries-and-rate-limits.md** (NEWS-109) — FR-23.1–23.6 linear jittered retry (15/30/45 s, ±20 %, 4 attempts), failure classification, account-wide rate-limit gate, rate-limited checks not advancing the attempt clock, `Retry-After` honoured: **Shipped**. FR-23.7 (NEWS-110) per-topic failure cooldown (2→30 min, schema v3), only *fatal* failures now advance the attempt clock, in-check retries cut to one: **Shipped**
- **docs/22-topic-categories.md** (NEWS-97) — topic categories. FR-22.1–22.7 code-side taxonomy, slug-not-label storage, retire-not-delete, most-specific label resolution, "no subcategory" as a rendered *Other*, topic `category`/`subcategory`/`categorySource` + manual-override route (schema v2 migration): **Shipped**. FR-22.8 auto-classification on the first check, model slugs validated against the live taxonomy: **Shipped**. FR-22.9 section label on its own line with the full path (NEWS-111), FR-22.10–22.12 two-row newspaper-style filter bar, server-side filtering with `uncategorized`/`other` sentinels, ephemeral filter state; FR-22.13–22.15 (NEWS-114) empty options hidden, no subsection row below two options, active selection always kept: **Shipped**
- Feed search **stays substring `LIKE`**, FTS5 declined (measured: 18 ms at a realistic 15k stories; FTS would break mid-word matching) — NEWS-102: **Decided, no change**
- Run retention 200 runs → **400 days** (25,000-row backstop), moved to the housekeeping sweep — NEWS-103: **Shipped**. Originally sized so a spend total covered a billing month; spend is gone (NEWS-119) and the window is kept for the diagnostics record instead
- FR-17.9 refresh responses apply in **issue order** — sequence guard on `refreshState`/`refreshFeed`, so a slow poll can't overwrite a newer mutation — NEWS-104: **Shipped**
- FR-4.8c orphan sweep (`pruneOrphans`) for stories/runs written after their topic was deleted — after every check and at startup — NEWS-105: **Shipped**
- FR-4.8/4.8a/4.8b/4.9 **storage moved to SQLite** (`node:sqlite`, Node 22.5+): per-row writes, zod-validated rows, one-time `data.json` import, no foreign keys (a check can outlive its topic), corrupt-db backup + settings-only fallback. Search stays substring `LIKE`, not FTS5 — NEWS-94: **Shipped**
- FR-3.45–3.48 (NEWS-117/118/120/121) settings tabbed with ARIA arrow-key nav; diagnostics collapsed on the App tab; privacy moved to its own footer-linked dialog; high-priority label shortened: **Shipped**
- FR-3.43–3.44 SVG favicon + web app manifest (route, not a static file) with `any`/`maskable` icons; app icons generated from `assets/logo.svg`; `mask-icon.svg` unwired (opaque square would tint as a block) — NEWS-115: **Shipped**
- FR-3.41–3.42 relative timestamps never wrap; source-link arrow aligns to the first line — NEWS-112/113: **Shipped**
- FR-3.40 double-click a topic row to toggle solo, sharing `toggleSolo` with the menu item — NEWS-95: **Shipped**
- FR-3.36–3.39 full-window layout: no shell max-width, extra width becomes story columns (1→6 across 1100–3000px), 400px column minimum, 74ch measure cap — NEWS-96: **Shipped**
- FR-3.33–3.35 kerf dev diagnostics behind a `__KERF_DEV__` esbuild define; **E2E runs the dev bundle with `invariants: 'throw'`** plus a `pageerror` guard, so a morph bug fails at the render that caused it — NEWS-100: **Shipped**
- FR-3.29–3.32 source attribution: optional `outlet` + `publishedAt` per source, domain fallback for the outlet, date shown **only when it differs from the found day** — NEWS-82: **Shipped**
- FR-3.25–3.28 in-app diagnostics: recent-checks list + copy-diagnostics bundle; **topic names redacted by default**, endpoint reported as set/not-set, never its URL — NEWS-88: **Shipped**
- FR-3.20–3.24 accessibility pass — NEWS-90: **Shipped**. Topics list is a real multi-select listbox (Enter/Space selects, **Shift+F10 opens the menu** — the whole topic action set was mouse-only); Escape closes dialogs innermost-first; Tab trapped in the frontmost dialog; banners `aria-live`; visible focus ring everywhere. axe-core runs in the E2E suite over **both themes** (0 violations / 22 rules).

Header/interval/check-all, topics panel with actions + confirm-delete, newest-first feed with source links, error + last-failure banners, 4 s visible-tab polling, empty states, light/dark. kerf structural conventions documented and E2E-regression-tested.

- **NEWS-202 (requirement change): the dial tooltip shows a duration, not a percentage.** "3% of the interval left" required arithmetic from an interval the tooltip never named. Now "Next check in 42m", via pure `dialCountdownMs`/`formatCountdown` in `src/client/dial.ts` (13 unit tests) plus an E2E assertion on the rendered `title`, since the string is assembled in `dialJsx` rather than the helpers. Rounds **down** to match the adjacent "checked 23h ago" label; "in under a minute" rather than "due now" while the ring is visibly non-empty; paused / never-checked keep their own wording.

## [4 — CLI, Server, and Storage](../4-cli-server-storage.md) — Shipped

Flags, usage errors, readiness line (`running at ` — synced with Tauri shell), clean shutdown, localhost-only Hono server with port fallback, zod-validated API, atomic single-file JSON store with corrupt-file recovery.

- FR-4.1a / FR-4.1b **Shipped** (NEWS-216): `npm install -g newsmonger` → `newsmonger` is the supported install path and what the README leads with (developer material moved to `CONTRIBUTING.md`). `--help`/`-h` and `--version`/`-v` print to **stdout** and exit **0**, scanned by `earlyExitFlag` *before* `parseArgs` so they answer even alongside a bad flag or a bad `NEWSMONGER_PROVIDER`, and before the store opens so neither creates a data dir. `--help` used to exit 1 with "unknown argument: --help". Verified by packing and installing the tarball on **macOS, Linux (arm64 + amd64, root and non-root, plus a real browser pass) and Windows 11 ARM64** (NEWS-217/218) — see the manual test plan.
- FR-4.12 **Shipped** (NEWS-164): renamed **News → Newsmonger** throughout — package/bin, Tauri productName + identifier + window title, Rust crate, sidecar binary, keychain service, `~/.newsmonger`, `newsmonger.db`, readiness line, `NEWSMONGER_*` env vars, export filenames, temp prefixes. **Not** renamed: `NewsItem`/`NewsProvider`/`NewsService`/`NEWS_JSON_SCHEMA` — those name *news*, not the product. Breaking for existing local installs (fresh data dir; keys must be re-entered, the keychain service moved) — fine pre-launch.
- FR-4.11 story retention (default 365 days, 0 = forever; bookmarked and flagged stories exempt; prunes at startup + after each check, reclaiming images) — NEWS-87 phase 1: **Shipped**. SQLite (phase 2) is **NEWS-94**.
- FR-4.5a cross-origin/DNS-rebinding guard (Host + Origin checked on every route, 403 otherwise) — NEWS-86: **Shipped**. Scope is the user's browser, not the machine — an absent `Origin` is allowed, so it is not authentication.

## [6 — AI Providers](../6-providers.md) — Shipped

- FR-6.13 **Shipped** (NEWS-189 + NEWS-226 for the per-run recording): **effort is a setting** — dropdown in the Source block, `effort` in Settings, `--effort`/`NEWSMONGER_EFFORT`, default `''` = provider default. A `<select>` not a slider (levels are named and unevenly spaced — NEWS-19 measured medium and low at the same 72 s with low using ~3× the input tokens). **Checks only, as a correctness constraint**: discovery runs on `claude-haiku-4-5`, which *rejects* `output_config.effort`, so leaking the setting there would 400 every suggestion request. Anthropic-only today; the control is disabled rather than hidden elsewhere. **NEWS-226**: each run records the level it ran at (`runs.effort`, SCHEMA_VERSION 4), read off the *provider object* rather than settings so a mid-sweep change can't misattribute it; `null` (not recorded) and `''` (model default) are deliberately distinct. That is what dissolves NEWS-19's blocker — every ordinary check becomes a data point instead of a paid-for sample.

- Model field is a combobox (datalist suggestions + free text) per provider (NEWS-37): **Shipped**

Pluggable provider abstraction (`NewsProvider`), `FACTORIES`/`AUTO_ORDER`/`resolveProvider`, provider/model/endpoint as persisted settings seeded by CLI/env, provider recorded per `CheckRun`. **Shipped**: the abstraction, `anthropic`, `openai` (Responses API + hosted web search; live path needs a key to verify), and `mock` (test-only), plus the UI provider selector. **Scope decision (NEWS-18)**: only platforms that do their own web search are supported — Ollama/local providers and the whole search-grounding layer were removed as unnecessary complexity.


### Attendance gate (FR-6.5–6.10) — **Shipped**

Subscription-backed providers (`attended: true`) run *scheduled* checks only while the app is foregrounded; manual checks are never gated **and record attendance** (so a long manual sweep isn't deferred mid-way when the app is backgrounded — NEWS-44); the gate fails closed. No `attended` provider exists yet — NEWS-27 (claude-cli) / NEWS-28 (codex-cli) are the first. Gate decision unit-tested; E2E covers the client heartbeat only.

## [5 — Desktop App (Tauri)](../5-desktop-app.md) — Shipped (macOS verified; other platforms unbuilt)

- FR-5.19 **Shipped** (NEWS-219): **nothing the app spawns runs in a directory the user keeps things in.** macOS attributes a child's file access to the *responsible app*, so `claude`/`codex` — agents that read their cwd — inheriting the server's cwd produced "Newsmonger would like to access files in your Documents folder"; three grants (Documents, Downloads, MediaLibrary) were recorded against the bundle id before it was found. Both spawns now pass an explicit `cwd`: `agentCwd()` for the CLIs, the resource dir for the release sidecar.
- **FR-5.12–5.17 auto-update: Shipped (NEWS-89).** Tauri v2 updater plugin against the signed `latest.json` on `releases/latest`, **ported from glassbox** rather than designed here. **Prompted, never silent**: a spawned startup check parks the version in `PendingUpdate(Mutex<Option<String>>)`, the client polls `get_pending_update` (delays `[0, 3s, 10s]`) and raises a banner with **Install**; nothing downloads unpressed. Three commands (`get_pending_update`, `check_for_update`, `install_update`), all `#[cfg(not(debug_assertions))]`-guarded so a dev build never chases an update for an unsigned binary. An install ends at **"restart to start using it"** rather than relaunching — the new binary is on disk but this process is the old one. **Settings → App → "Check for updates"** is the only surface that reports "up to date" / "could not check", because those are answers worth giving to someone who asked and not worth a banner otherwise; it is `isTauri()`-gated since the browser build has no binary to replace. A dismissal survives **re-announcement of the same version** (the poll reads it up to three times) but a newer version clears both it and any install progress. Two findings worth keeping: the banner's Install button needs an **always-present `.update-actions` slot** — a conditional element between siblings failed the render outright under the E2E suite's `invariants: 'throw'`, and the *whole* `#banners` region went empty, which is how it was caught; and `tauri-plugin-process` + `process:default` are needed for the relaunch capability. Covered by `tests/unit/update.test.ts` (18, walked as sequences) + `tests/e2e/update.spec.ts` (9, faked `window.__TAURI__`); the Rust commands and a real signed install stay manual. NEWS-199 was a duplicate of this ticket.
- **Release pipeline (NEWS-190 + NEWS-201): shipped, unexercised.** **Two workflows split by tag shape.** `release-candidate.yml` (`v*-rc.*`, `v*-beta.*`) is the port of glassbox's — gates/audit/rust(both clippy profiles)/e2e/npm-pack/4-target Tauri → npm `@beta` via **OIDC trusted publishing** (no `NPM_TOKEN`) → smoke tests against the *published* package → then **rc**: publish `@latest`, create the clean `v{ver}` tag, dispatch the desktop build; **beta**: signed bundles into a draft prerelease, flipped public at the end. `release-desktop.yml` (`v[0-9]*`) owns the stable bundles with the same draft-until-every-asset-lands pattern. `scripts/release.sh` now tags **`v{ver}-rc.N`** for stable — **the clean tag is created by CI, never by hand** — so nothing reaches `latest` until the published artifact has been installed and run. Findings worth keeping: npm's OIDC handshake needs **npm ≥ 11.5.1** and older npm reports the auth rejection as a **404**; the trusted-publisher binding is **workflow-filename-scoped**, so renaming `release-candidate.yml` silently breaks publishing; a tag pushed with `GITHUB_TOKEN` **does not trigger another workflow**, hence the explicit `createWorkflowDispatch` in promote; `prerelease: true` + `make_latest: 'false'` must be repeated on the **draft flip** as well as the create, since flipping is a full update that would otherwise clear it; and betas skip the Windows MSI because its pre-release identifier must be numeric-only. **NEWS-207**: beta bundles now carry the full `-beta.N` version. They used to get the *base* version (NEWS-196 claimed macOS rejects a suffix — measured false), which made every beta report the same version, so the Tauri updater could never deliver beta→beta. `tests/smoke/smoke-test.sh` is new and derives its asset list from what the server serves. **FR-5.20 / NEWS-197**: `scripts/notary-watch.sh` makes Apple's notarization queue visible (poll during the build, report on `always()`, history + submission id on `failure()`), and `timeout-minutes: 120` is back on the signing jobs — both were NEWS-194's and were lost in the port. **Three guards were lost that way**: this one, NEWS-208's tag-vs-config check (still open), and the `verify-signing.sh` gate — **NEWS-220**. All four are now restored: NEWS-208's guard is `scripts/check-tag-version.sh`, wired as its own gating job in `release-candidate.yml` and the first step of `create-release` in `release-desktop.yml`. NEWS-220's gate is restored to both workflows' macOS shards and deliberately not `continue-on-error`, since `publish-release` needs that job and a rejected bundle should keep the release a draft. The port is still worth auditing as a whole. **NEWS-209**: an advisory `test-e2e-windows` job (windows-latest, `continue-on-error`, in no job's `needs`) — the harness needed **no porting**, measured by running the full suite on a real Windows 11 machine: 173/173, the one flake being the a11y sweep timing out under load on a slow VM. **Still needs a human**: npm trusted publishing configured on npmjs.com, and an `npm-publish` GitHub environment. **Neither workflow re-implements the old tag-vs-config version guard** (tracked separately). Nothing has run yet — three of four platforms have never been bundle-built (NEWS-20).
- FR-5.5 signing + notarization: **Partial — config shipped, credentials outstanding.** The full generation recipe now lives in `docs/5-desktop-app.md` (NEWS-21): Developer ID cert via CSR, Team ID, notarization credential, `.p12` export for CI, forward-looking updater keypair, plus a **GitHub Actions secret-name table** and a production-vs-beta section. **Notarization uses an app-specific password** (`APPLE_ID` + `APPLE_PASSWORD` + `APPLE_TEAM_ID`) — the owner's choice — which makes all **seven** secrets plain strings mapping 1:1 onto Tauri env vars, so the release job needs no credential-prep step. Key findings recorded there: the Apple credentials are **identical** for production and beta (there is no beta Developer ID cert); `APPLE_PASSWORD` is the app-specific password *with hyphens*, not the Apple ID password, and **changing the Apple ID password revokes it** (releases then fail to notarize with nothing in the repo having changed); the credential is bound to one person's Apple ID, which is the reason the App Store Connect key stays documented as the migration target — and that route reintroduces a file-materialization step, since `APPLE_API_KEY_PATH` is a path and a secret cannot hold one; the release runner must be **macOS** (both current CI jobs are `ubuntu-latest` and cannot sign); and the updater keypair should be **shared** across channels, because the pubkey is compiled into the binary and a per-channel key would strand beta testers.
- FR-5.11 **Shipped (NEWS-186)**: bundle identifier is **`com.smalltale.newsmonger`** (was `com.brianwestphal.newsmonger`) after the repo moved to **Small-Tale/newsmonger** under **Small Tale Inc.** The identifier is the app's permanent macOS identity — it keys signing/notarization, notification authorization and the system app-support directory — so changing it post-release would read as a *different app*; pre-launch it is free. Inert here: the keychain service (`newsmonger`) and `~/.newsmonger` are chosen by our own code, not derived from it. Gated by `tests/unit/ownership.test.ts`, which also pins `package.json`'s `author`/`repository`/`bugs`/`homepage`. **Not** changed: the `brianwestphal/kerf` links — kerfjs is a third-party dep that still lives there.
- FR-5.10 **Shipped (NEWS-185)**: window title **set but not drawn** on macOS via `hiddenTitle` (it was redundant with the wordmark). `title` stays set so the **Window menu and Dock context menu still list the window** — `title: ""` would hide the text *and* break both, which is the trap. **macOS-only by design**: on Windows/Linux one string feeds titlebar *and* taskbar list, and there the titlebar is the only place the window names itself, so keeping it is correct rather than a compromise.
- FR-5.9 **Shipped (NEWS-184)**: binary named `Newsmonger` via an explicit `[[bin]]` target. macOS names a *running* app from **`CFBundleExecutable`**, not `CFBundleName`/`CFBundleDisplayName` — both were already right while the Dock showed `newsmonger`. Renamed in Cargo, not via `mainBinaryName`, because that only applies to `tauri build` and would leave `tauri dev` lowercase. Gated by `tests/unit/tauri-naming.test.ts`.

- FR-5.8 **Shipped (NEWS-182)**: `bundle.icon` is declared. Its schema default is **`[]`** — omitting it shipped a bundle with no `CFBundleIconFile` and no `.icns`, so macOS showed a generic icon in the Dock, Finder and About panel while every asset sat unreferenced in `src-tauri/icons/`. FR-5.3's "verified end to end" had verified *function*, not identity. `tests/unit/tauri-icons.test.ts` gates the declaration + files; the bundled result is manual (needs a Rust build).

- FR-5.1 dev-mode shell: **Shipped, verified on macOS** (compile + spawn + navigate + page load confirmed via request log)
- FR-5.2 Tauri detection + external links: **Shipped**
- FR-5.3 release sidecar bundling: **Shipped, verified on macOS** (`npm run tauri:build` → `Newsmonger.app`/`.dmg`; built app starts its sidecar, serves the real UI, exits cleanly. Other target triples wired but unbuilt)
- FR-5.4 orphan protection (`NEWSMONGER_WATCH_PARENT` ppid watch): **Shipped, verified**

## [7 — API Keys and Settings Dialog](../7-api-keys.md) — Shipped (all three platforms verified)

- a11y (NEWS-159): the settings dialog is axe-scanned on **all four tabs in both colour schemes** (was: once, in light, on the first tab). **0 violations** — the dark-mode failures NEWS-159 was filed for were artifacts of scanning while a second dialog was open, and do not exist.

- FR-7.1 env → keychain precedence: **Shipped**
- FR-7.2 keys never written to the data file (no disk fallback): **Shipped**
- FR-7.3 per-request resolution; SDK client cache keyed on the credential: **Shipped**
- FR-7.4 keychain via platform tooling, no native module: **Shipped, all three platforms verified** (macOS real Keychain; Linux in Docker; Windows 11 in Parallels — three Windows bugs found and fixed)
- FR-7.5 availability probed once; Linux round-trip probe: **Shipped, verified** (the headless-no-daemon case is exactly what it catches)
- FR-7.6 write verified by read-back: **Shipped**
- FR-7.7 key routes (`GET`/`PUT`/`DELETE /api/keys`): **Shipped**
- FR-7.8 status never carries the key, masked or otherwise: **Shipped**
- FR-7.9 single settings dialog (interval, provider, model, endpoint, keys): **Shipped**
- FR-7.10a **Shipped** (NEWS-156): **no Save button** — the key field commits on `change` (blur/Enter), never `input`, because a save verifies the key with its vendor. Enter fires `submit` *and* `change`, so the field is cleared **before** the await, or one keypress sends two `PUT`s. A `.key-saving` "Checking…" note replaces the button as the in-flight signal.
- FR-7.10 three key-row states; no input when a key exists: **Shipped**
- FR-7.11 disabled inputs + env-var guidance with no keychain: **Shipped** (rendering path untested — needs a machine without a credential store)
- FR-7.12 `NEWSMONGER_FAKE_KEYCHAIN=1` in-memory store for tests: **Shipped**
- FR-7.13 privacy disclosure (what's sent / stored locally / never collected), in Settings + README + onboarding — NEWS-91: **Shipped**. A unit test pins the "sent" claim to `buildUserPrompt`, so a change that starts sending more fails rather than making the note quietly untrue.

## [8 — Article Images](../8-article-images.md) — Shipped (verified against live sites)

- FR-8.14–8.18 **source favicons Shipped (NEWS-169)**: each `NewsSource` carries its outlet's icon, replacing the arrow before feed source links (arrow remains the fallback). Keyed **per origin** — one outlet cited six times is one request/cache entry. Two bounded attempts: `/favicon.ico`, then the homepage's `<link rel=icon>`. Tighter bounds than a lead image (256 KB, wider type set incl. ICO/SVG, empty body refused). **Joins the FR-8.13 mark-and-sweep** or the startup prune reclaims every icon silently.

- FR-8.1–8.3 og:image scraped server-side; no-image is the normal case; failures never cost a story: **Shipped**
- FR-8.4–8.5 proxied through `/api/image/:hash`, content-addressed cache, zero third-party browser requests: **Shipped**
- FR-8.6–8.11 SSRF guards (protocol, host, post-DNS address, re-validated image URL, cache-only route, size/type caps): **Shipped**
- FR-8.12 fixed-ratio media slot, collapses when absent: **Shipped**
- FR-8.13 cache pruning (mark-and-sweep at startup + on topic delete; shared hashes ref-counted): **Shipped** (NEWS-36)

## [9 — Subscription Providers](../9-subscription-providers.md) — both shipped

- FR-9.1–9.2 CLI rather than API or the 243 MB Agent SDK: **Shipped**
- FR-9.3–9.5 shared prompts, WebSearch-only tools, `--json-schema` structured output: **Shipped**
- FR-9.6 availability = binary + credential-file shape, no quota-spending probe: **Shipped**
- FR-9.7 `attended: true`, so the foreground gate applies: **Shipped**
- FR-9.9–9.11 subscription-first `AUTO_ORDER`, no key row, startup warning probes properly: **Shipped**
- FR-9.12–9.17 `codex-cli`: read-only sandbox, schema-as-file, combined prompt, `auth_mode` probe, stderr ignored: **Shipped**
- Live paths for both: **manual only** (unit tests inject a fake runner)

## [10 — New-Item Notifications](../10-notifications.md) — Shipped (browser-verified; Tauri-native manual)

- FR-10.1–10.4 opt-in setting, unfocused-only, 5-min throttle, first-load seeded silent: **Shipped**
- FR-10.5 web Notification (click focuses the app): **Shipped, browser-verified**
- FR-10.6 dock bounce / taskbar flash via Tauri `requestUserAttention`: **Shipped, unverified in a live WKWebView** (NEWS-40)

## [11 — Story Actions (Save & Share)](../11-story-actions.md) — Shipped

- FR-11.1 bookmark/save a story (`item.saved` persisted via `PATCH /api/items/:id`): **Shipped**
- FR-11.2 Saved feed filter (ephemeral view, composes with Solo): **Shipped**
- FR-11.3 share a story — formatted title+summary+link via OS share sheet, clipboard fallback + toast: **Shipped**; the real OS sheet is now **confirmed working in the Tauri WKWebView on macOS** (NEWS-45, owner's live run). `navigator.share` is *not* a WKWebView no-op the way `window.confirm`/`window.alert` are, which had been the working assumption. Fallback retained for desktop browsers and for unverified Windows/Linux.
