# 6 — AI Providers

News checks run through a pluggable provider abstraction so you can choose which AI finds and summarizes news.

## Scope: web-searching platforms only

- **FR-6.0** Only AI platforms that perform **their own web search** are supported. Finding genuinely *new* news requires live browsing, and the app deliberately does not carry a search backend to compensate for models that can't browse. A local model would answer from its training cutoff — plausible-sounding but not actually news — so those providers are out of scope. (`mock` is a test-only provider for `--ai-test`.)

## The abstraction

- **FR-6.1** `NewsProvider` (`src/ai/types.ts`) extends `NewsService` with `name`, `model`, and `isAvailable()`. Providers are plain factory functions returning object literals (no base class), registered in `src/ai/providers/index.ts`.

## Selection & config

- **FR-6.2** Provider, model, and endpoint are **persisted settings** (`Settings.provider` / `.model` / `.endpoint`), changeable at runtime from the UI's Source block (`PATCH /api/settings`) or seeded at startup by `--provider auto|anthropic|openai|mock`, `--model <id>`, `--endpoint <url>` / `NEWS_PROVIDER`, `NEWS_MODEL`, `NEWS_ENDPOINT`. `--ai-test` forces the mock provider without touching settings.
- **FR-6.3** `resolveProvider()` runs per check. For `auto` it returns the first available provider in `AUTO_ORDER` (`anthropic`, then `openai`); for an explicit choice it returns that provider if available, else throws an actionable message (e.g. "Anthropic has no API key — add one in Settings, or set ANTHROPIC_API_KEY"). If nothing is available, the check fails with a clear error rather than crashing the app. The provider that ran is recorded on the `CheckRun`.
- **FR-6.4** A stored provider that no longer exists in the schema degrades to `auto` (`z.enum(...).catch('auto')`) rather than failing the whole data file — see [4 — CLI, Server, and Storage](4-cli-server-storage.md) FR-4.9.

## Providers

| Provider | Config | Status |
|---|---|---|
| `anthropic` | key from Settings or `ANTHROPIC_API_KEY`; default model `claude-opus-4-8` | **Shipped** |
| `openai` | key from Settings or `OPENAI_API_KEY`, plus `OPENAI_BASE_URL`; default model `gpt-5` | **Shipped** (live path needs a key to verify) |
| `mock` | none (`--ai-test` / `--provider mock`) | **Shipped** (tests / offline) |

### Anthropic

Claude with adaptive thinking and the `web_search_20260209` server tool (max 8 searches per check), streamed to avoid HTTP timeouts.

### OpenAI

The **Responses API** with the hosted `web_search` tool (`client.responses.create({ model, instructions, input, tools: [{type:'web_search'}] })`, reading `output_text`) — the OpenAI analog of Anthropic's server tool. Result parsing reuses the shared fenced-JSON `parseNewsResult`; a strict `json_schema` output was left as a possible enhancement to avoid schema-vs-hosted-tool friction. `OPENAI_BASE_URL` (or `--endpoint`) targets an OpenAI-compatible gateway. **The live request path needs a real key to verify** — see `manual-test-plan.md`.

See also: [2 — News Checks and Deduplication](2-news-checks-and-dedup.md), [4 — CLI, Server, and Storage](4-cli-server-storage.md).

Key storage and the Settings dialog are covered in [7 — API Keys and Settings Dialog](7-api-keys.md).
