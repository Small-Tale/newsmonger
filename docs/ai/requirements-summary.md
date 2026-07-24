# Requirements Summary (AI summary)

Status markers: **Shipped** · **Partial** · **Design only** · **Deferred**. Source docs win on conflict.

## [1 — Topics and Scheduling](../1-topics-and-scheduling.md) — Shipped

Add/delete/pause topics (unique, case-insensitive); global interval (default 1 day, min 5 min); minute-tick scheduler + startup sweep; sequential, non-overlapping checks; failures advance `lastCheckedAt` (retry next interval); manual per-topic and check-all triggers. All shipped and covered by unit + E2E tests.

## [2 — News Checks and Deduplication](../2-news-checks-and-dedup.md) — Shipped (real-API path untested)

- Prompt window wording scales with the gap (first check / hours / 1 day / ≥2 days catch-up): **Shipped**
- Model output sanitized (citation markup stripped) on both write and read: **Shipped**
- Digest-size bound in the shared system prompt (wider span, not longer list) — portable across all providers, since only `anthropic` has a tool-level cap: **Shipped**
- FR-1.10 `coveredThroughAt` separate from `lastCheckedAt` so a failure can't discard pending news: **Shipped**

Default Anthropic provider (`claude-opus-4-8` + web search), prompt-level exclusion of known stories, fenced-JSON result parsing, URL/title dedupe keys, per-topic scope, mid-check-deletion safety, `--ai-test` mock — now behind the provider abstraction (see [6 — AI Providers](../6-providers.md)). **Caveat:** the live Anthropic/OpenAI request paths have not been exercised against the real APIs (no keys in the dev environment) — `parseNewsResult` and everything downstream is tested; the requests are follow-up verification (NEWS-3, manual test plan).

## [3 — Web UI](../3-ui.md) — Shipped

- Collapsible topics sidebar (localStorage-persisted, panel stays mounted): **Shipped**
- Topic selection (click / Cmd-click / Shift-range), right-click context menu with Lucide icons, bulk actions, Delete key: **Shipped**
- All icons are Lucide; no emoji or text glyphs anywhere in the UI (E2E-guarded): **Shipped**
- Source status moved from the sidebar into the settings dialog: **Shipped**
- Solo (show only chosen topics' stories) — additive, banner + dimming, ephemeral by design: **Shipped**
- Bookmark/save stories (`item.saved` persisted) + a Saved feed filter (ephemeral view, composes with Solo) — NEWS-42: **Shipped**
- Error/warning banners are dismissable; the failure warning's dismissal is remembered by run id so a new failure reappears (NEWS-41): **Shipped**
- Destructive confirmations via an in-app dialog, never `window.confirm` (a WKWebView no-op that broke delete in the desktop app — NEWS-39): **Shipped**

Header/interval/check-all, topics panel with actions + confirm-delete, newest-first feed with source links, error + last-failure banners, 4 s visible-tab polling, empty states, light/dark. kerf structural conventions documented and E2E-regression-tested.

## [4 — CLI, Server, and Storage](../4-cli-server-storage.md) — Shipped

Flags, usage errors, readiness line (`running at ` — synced with Tauri shell), clean shutdown, localhost-only Hono server with port fallback, zod-validated API, atomic single-file JSON store with corrupt-file recovery.

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
- FR-7.2 keys never written to `data.json` (no disk fallback): **Shipped**
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
