# Requirements Summary (AI summary)

Status markers: **Shipped** · **Partial** · **Design only** · **Deferred**. Source docs win on conflict.

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
- FR-21.7 reaching the feed from **another device**: **Deferred** — needs a bearer token + non-loopback bind, coupled to the NEWS-46 mobile line

## [20 — First-Run Onboarding](../20-onboarding.md) — Shipped

- FR-20.1–20.3 auto-opens only with no topics **and** no provider, only after both `/api/state` and `/api/providers` answer; dismissal remembered per device — NEWS-78: **Shipped**
- FR-20.4–20.8 four skippable steps (welcome → source → topics → schedule); a detected subscription CLI is offered **first**, since it needs no key at all: **Shipped**
- FR-20.9–20.11 keys checked with the vendor before saving (models-list probe, not a completion); **only 401/403 blocks the save** — offline is "unknown", not "wrong key"; verifier injected, null under `--ai-test`: **Shipped**
- Auto-open on a genuinely fresh install is **manual** — the shared E2E server can never be in that state

## [19 — Cost Visibility](../19-cost-visibility.md) — Shipped

- FR-19.1–19.3 providers return `{items, usage}`; token+search counts persisted on the `CheckRun` with the model. **null usage = unknown, never zero** — NEWS-79: **Shipped**
- FR-19.4–19.6 counts stored, money derived at display time from a dated, never-guessed rate table; a model with no published price yields **no estimate** rather than a wrong one: **Shipped**
- FR-19.5a **rates updatable without a build** — NEWS-93: **Shipped**. `<data-dir>/prices.json` is the live table (seeded from built-ins, hand edits apply with no restart); an optional https `priceManifestUrl` is fetched daily and replaces it; built-ins are the floor. Every failure costs the *update*, never the estimate.
- FR-19.7–19.9 `spend` block on `/api/state`; Settings shows the month's estimate *with* the count of checks it couldn't price: **Shipped**
- FR-19.10–19.13 optional monthly cap pausing **scheduled** checks only (manual always runs), tripping on `>=`: **Shipped**

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

- Collapsible topics sidebar (localStorage-persisted, panel stays mounted): **Shipped**
- Topic selection (click / Cmd-click / Shift-range), right-click context menu with Lucide icons, bulk actions, Delete key: **Shipped**
- All icons are Lucide; no emoji or text glyphs anywhere in the UI (E2E-guarded): **Shipped**
- Source status moved from the sidebar into the settings dialog: **Shipped**
- Solo (show only chosen topics' stories) — additive, banner + dimming, ephemeral by design: **Shipped**
- Bookmark/save stories + Saved feed filter, and Share a story — see [11 — Story Actions](../11-story-actions.md): **Shipped**
- Error/warning banners are dismissable; the failure warning's dismissal is remembered by run id so a new failure reappears (NEWS-41): **Shipped**
- Destructive confirmations via an in-app dialog, never `window.confirm` (a WKWebView no-op that broke delete in the desktop app — NEWS-39): **Shipped**

- KF-377 workarounds **kept deliberately** after kerfjs 3.0.0 went stable — `#banners`/`#toast-slot` are ARIA live regions (must exist before their content), `#topics-panel` is the `aria-controls` target (removal fails axe) — NEWS-99: **Decided, no change**
- FR-4.8/4.8a/4.8b/4.9 **storage moved to SQLite** (`node:sqlite`, Node 22.5+): per-row writes, zod-validated rows, one-time `data.json` import, no foreign keys (a check can outlive its topic), corrupt-db backup + settings-only fallback. Search stays substring `LIKE`, not FTS5 — NEWS-94: **Shipped**
- FR-3.40 double-click a topic row to toggle solo, sharing `toggleSolo` with the menu item — NEWS-95: **Shipped**
- FR-3.36–3.39 full-window layout: no shell max-width, extra width becomes story columns (1→6 across 1100–3000px), 400px column minimum, 74ch measure cap — NEWS-96: **Shipped**
- FR-3.33–3.35 kerf dev diagnostics behind a `__KERF_DEV__` esbuild define; **E2E runs the dev bundle with `invariants: 'throw'`** plus a `pageerror` guard, so a morph bug fails at the render that caused it — NEWS-100: **Shipped**
- FR-3.29–3.32 source attribution: optional `outlet` + `publishedAt` per source, domain fallback for the outlet, date shown **only when it differs from the found day** — NEWS-82: **Shipped**
- FR-3.25–3.28 in-app diagnostics: recent-checks list + copy-diagnostics bundle; **topic names redacted by default**, endpoint reported as set/not-set, never its URL — NEWS-88: **Shipped**
- FR-3.20–3.24 accessibility pass — NEWS-90: **Shipped**. Topics list is a real multi-select listbox (Enter/Space selects, **Shift+F10 opens the menu** — the whole topic action set was mouse-only); Escape closes dialogs innermost-first; Tab trapped in the frontmost dialog; banners `aria-live`; visible focus ring everywhere. axe-core runs in the E2E suite over **both themes** (0 violations / 22 rules).

Header/interval/check-all, topics panel with actions + confirm-delete, newest-first feed with source links, error + last-failure banners, 4 s visible-tab polling, empty states, light/dark. kerf structural conventions documented and E2E-regression-tested.

## [4 — CLI, Server, and Storage](../4-cli-server-storage.md) — Shipped

Flags, usage errors, readiness line (`running at ` — synced with Tauri shell), clean shutdown, localhost-only Hono server with port fallback, zod-validated API, atomic single-file JSON store with corrupt-file recovery.

- FR-4.11 story retention (default 365 days, 0 = forever; bookmarked and flagged stories exempt; prunes at startup + after each check, reclaiming images) — NEWS-87 phase 1: **Shipped**. SQLite (phase 2) is **NEWS-94**.
- FR-4.5a cross-origin/DNS-rebinding guard (Host + Origin checked on every route, 403 otherwise) — NEWS-86: **Shipped**. Scope is the user's browser, not the machine — an absent `Origin` is allowed, so it is not authentication.

## [6 — AI Providers](../6-providers.md) — Shipped

- Model field is a combobox (datalist suggestions + free text) per provider (NEWS-37): **Shipped**

Pluggable provider abstraction (`NewsProvider`), `FACTORIES`/`AUTO_ORDER`/`resolveProvider`, provider/model/endpoint as persisted settings seeded by CLI/env, provider recorded per `CheckRun`. **Shipped**: the abstraction, `anthropic`, `openai` (Responses API + hosted web search; live path needs a key to verify), and `mock` (test-only), plus the UI provider selector. **Scope decision (NEWS-18)**: only platforms that do their own web search are supported — Ollama/local providers and the whole search-grounding layer were removed as unnecessary complexity.


### Attendance gate (FR-6.5–6.10) — **Shipped**

Subscription-backed providers (`attended: true`) run *scheduled* checks only while the app is foregrounded; manual checks are never gated **and record attendance** (so a long manual sweep isn't deferred mid-way when the app is backgrounded — NEWS-44); the gate fails closed. No `attended` provider exists yet — NEWS-27 (claude-cli) / NEWS-28 (codex-cli) are the first. Gate decision unit-tested; E2E covers the client heartbeat only.

## [5 — Desktop App (Tauri)](../5-desktop-app.md) — Shipped (macOS verified; other platforms unbuilt)

- FR-5.1 dev-mode shell: **Shipped, verified on macOS** (compile + spawn + navigate + page load confirmed via request log)
- FR-5.2 Tauri detection + external links: **Shipped**
- FR-5.3 release sidecar bundling: **Shipped, verified on macOS** (`npm run tauri:build` → `News.app`/`.dmg`; built app starts its sidecar, serves the real UI, exits cleanly. Other target triples wired but unbuilt)
- FR-5.4 orphan protection (`NEWS_WATCH_PARENT` ppid watch): **Shipped, verified**

## [7 — API Keys and Settings Dialog](../7-api-keys.md) — Shipped (all three platforms verified)

- FR-7.1 env → keychain precedence: **Shipped**
- FR-7.2 keys never written to the data file (no disk fallback): **Shipped**
- FR-7.3 per-request resolution; SDK client cache keyed on the credential: **Shipped**
- FR-7.4 keychain via platform tooling, no native module: **Shipped, all three platforms verified** (macOS real Keychain; Linux in Docker; Windows 11 in Parallels — three Windows bugs found and fixed)
- FR-7.5 availability probed once; Linux round-trip probe: **Shipped, verified** (the headless-no-daemon case is exactly what it catches)
- FR-7.6 write verified by read-back: **Shipped**
- FR-7.7 key routes (`GET`/`PUT`/`DELETE /api/keys`): **Shipped**
- FR-7.8 status never carries the key, masked or otherwise: **Shipped**
- FR-7.9 single settings dialog (interval, provider, model, endpoint, keys): **Shipped**
- FR-7.10 three key-row states; no input when a key exists: **Shipped**
- FR-7.11 disabled inputs + env-var guidance with no keychain: **Shipped** (rendering path untested — needs a machine without a credential store)
- FR-7.12 `NEWS_FAKE_KEYCHAIN=1` in-memory store for tests: **Shipped**
- FR-7.13 privacy disclosure (what's sent / stored locally / never collected), in Settings + README + onboarding — NEWS-91: **Shipped**. A unit test pins the "sent" claim to `buildUserPrompt`, so a change that starts sending more fails rather than making the note quietly untrue.

## [8 — Article Images](../8-article-images.md) — Shipped (verified against live sites)

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
- FR-11.3 share a story — formatted title+summary+link via OS share sheet, clipboard fallback + toast: **Shipped**
