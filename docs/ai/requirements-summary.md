# Requirements Summary (AI summary)

Status markers: **Shipped** · **Partial** · **Design only** · **Deferred**. Source docs win on conflict.

## [1 — Topics and Scheduling](../1-topics-and-scheduling.md) — Shipped

Add/delete/pause topics (unique, case-insensitive); global interval (default 1 day, min 5 min); minute-tick scheduler + startup sweep; sequential, non-overlapping checks; failures advance `lastCheckedAt` (retry next interval); manual per-topic and check-all triggers. All shipped and covered by unit + E2E tests.

## [2 — News Checks and Deduplication](../2-news-checks-and-dedup.md) — Shipped (real-API path untested)

Default Anthropic provider (`claude-opus-4-8` + web search), prompt-level exclusion of known stories, fenced-JSON result parsing, URL/title dedupe keys, per-topic scope, mid-check-deletion safety, `--ai-test` mock — now behind the provider abstraction (see [6 — AI Providers](../6-providers.md)). **Caveat:** the live Anthropic/OpenAI request paths have not been exercised against the real APIs (no keys in the dev environment) — `parseNewsResult` and everything downstream is tested; the requests are follow-up verification (NEWS-3, manual test plan).

## [3 — Web UI](../3-ui.md) — Shipped

Header/interval/check-all, topics panel with actions + confirm-delete, newest-first feed with source links, error + last-failure banners, 4 s visible-tab polling, empty states, light/dark. kerf structural conventions documented and E2E-regression-tested.

## [4 — CLI, Server, and Storage](../4-cli-server-storage.md) — Shipped

Flags, usage errors, readiness line (`running at ` — synced with Tauri shell), clean shutdown, localhost-only Hono server with port fallback, zod-validated API, atomic single-file JSON store with corrupt-file recovery.

## [6 — AI Providers](../6-providers.md) — Partial

Pluggable provider abstraction (`NewsProvider` + `searchesWeb` capability), `PROVIDERS`/`AUTO_ORDER`/`resolveProvider`, provider/model/endpoint as persisted settings seeded by CLI/env, provider recorded per `CheckRun`. **Shipped**: the abstraction, `anthropic`, `openai` (Responses API + hosted web search; live path needs a key to verify), `ollama` (OpenAI-compatible local models, `searchesWeb:false`), and `mock`. UI provider selector + "not live-searched" badge (NEWS-10) **shipped**.

## [7 — Search Grounding](../7-search-grounding.md) — Shipped

Decouples search from summarization so non-browsing providers (Ollama) do live news: `SearchProvider` + Tavily (NEWS-13), the three-branch grounded pipeline + `searchProvider` setting + `CheckRun.grounded` (NEWS-14), and the "Ground with search" UI picker with auto badge-suppression (NEWS-15). Follow-ups: Brave impl (stub), the docs/7 open questions.

## [5 — Desktop App (Tauri)](../5-desktop-app.md) — Partial

- FR-5.1 dev-mode shell: **Shipped, verified on macOS** (compile + spawn + navigate + page load confirmed via request log)
- FR-5.2 Tauri detection + external links: **Shipped**
- FR-5.3 release sidecar bundling: **Design only** (NEWS-2 remainder; icons already generated)
- FR-5.4 orphan protection (`NEWS_WATCH_PARENT` ppid watch): **Shipped, verified**
