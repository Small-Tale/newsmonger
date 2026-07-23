# Requirements Summary (AI summary)

Status markers: **Shipped** · **Partial** · **Design only** · **Deferred**. Source docs win on conflict.

## [1 — Topics and Scheduling](../1-topics-and-scheduling.md) — Shipped

Add/delete/pause topics (unique, case-insensitive); global interval (default 1 day, min 5 min); minute-tick scheduler + startup sweep; sequential, non-overlapping checks; failures advance `lastCheckedAt` (retry next interval); manual per-topic and check-all triggers. All shipped and covered by unit + E2E tests.

## [2 — News Checks and Deduplication](../2-news-checks-and-dedup.md) — Shipped (real-API path untested)

Claude `claude-opus-4-8` + web search, prompt-level exclusion of known stories, fenced-JSON result parsing, URL/title dedupe keys, per-topic scope, mid-check-deletion safety, `--ai-test` mock. **Caveat:** the live `ClaudeNewsService` request path has not been exercised against the real API (no key in the dev environment) — `parseNewsResult` and everything downstream is tested; the request itself is a follow-up verification.

## [3 — Web UI](../3-ui.md) — Shipped

Header/interval/check-all, topics panel with actions + confirm-delete, newest-first feed with source links, error + last-failure banners, 4 s visible-tab polling, empty states, light/dark. kerf structural conventions documented and E2E-regression-tested.

## [4 — CLI, Server, and Storage](../4-cli-server-storage.md) — Shipped

Flags, usage errors, readiness line (`running at ` — synced with Tauri shell), clean shutdown, localhost-only Hono server with port fallback, zod-validated API, atomic single-file JSON store with corrupt-file recovery.

## [6 — AI Providers](../6-providers.md) — Partial

Pluggable provider abstraction (`NewsProvider` + `searchesWeb` capability), `PROVIDERS`/`AUTO_ORDER`/`resolveProvider`, provider/model/endpoint as persisted settings seeded by CLI/env, provider recorded per `CheckRun`. **Shipped**: the abstraction, `anthropic`, `openai` (Responses API + hosted web search; live path needs a key to verify), `ollama` (OpenAI-compatible local models, `searchesWeb:false`), and `mock`. UI provider selector + "not live-searched" badge (NEWS-10) **shipped**. **Planned**: external-search grounding (NEWS-12), docs finalize (NEWS-11).

## [5 — Desktop App (Tauri)](../5-desktop-app.md) — Partial

- FR-5.1 dev-mode shell: **Shipped, verified on macOS** (compile + spawn + navigate + page load confirmed via request log)
- FR-5.2 Tauri detection + external links: **Shipped**
- FR-5.3 release sidecar bundling: **Design only** (NEWS-2 remainder; icons already generated)
- FR-5.4 orphan protection (`NEWS_WATCH_PARENT` ppid watch): **Shipped, verified**
