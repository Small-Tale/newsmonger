# 6 — AI Providers

News checks run through a pluggable provider abstraction so you can choose which AI backend finds and summarizes news. (Full doc — provider-by-provider — is finalized as the individual providers land; NEWS-11.)

## The abstraction

- **FR-6.1** `NewsProvider` (`src/ai/types.ts`) extends `NewsService` with `name`, `searchesWeb` (capability), `model`, and `isAvailable()`. Providers are plain factory functions returning object literals (no base class), registered in `src/ai/providers/index.ts`.
- **FR-6.2** **`searchesWeb` is the key capability.** Providers that browse the live web (Anthropic, and OpenAI when added) can find genuinely *new* news. Local models (Ollama, the test mock) answer from training data only and set `searchesWeb: false` — they cannot confirm freshness. `auto` selection **never** picks a non-searching provider.

## Selection & config

- **FR-6.3** Provider, model, and endpoint are **persisted settings** (`Settings.provider` / `.model` / `.endpoint`), changeable at runtime (UI: NEWS-10). CLI flags / env seed them at startup: `--provider auto|anthropic|openai|ollama|mock`, `--model <id>`, `--endpoint <url>`; env `NEWS_PROVIDER`, `NEWS_MODEL`, `NEWS_ENDPOINT`. `--ai-test` forces the mock provider without touching settings.
- **FR-6.4** `resolveProvider()` runs per check. For `auto` it returns the first available provider in `AUTO_ORDER` (`anthropic`, then `openai`); for an explicit choice it returns that provider if available, else throws an actionable message (e.g. "set ANTHROPIC_API_KEY"). If nothing is available, the check fails with a clear error rather than crashing the app. The provider that ran is recorded on the `CheckRun`.

## Providers

| Provider | `searchesWeb` | Config | Status |
|---|---|---|---|
| `anthropic` | ✅ | `ANTHROPIC_API_KEY`; default model `claude-opus-4-8` | **Shipped** |
| `openai` | ✅ (native web search) | `OPENAI_API_KEY`, `OPENAI_BASE_URL` | Planned (NEWS-8) |
| `ollama` | ❌ (local model, no browsing) | `NEWS_OLLAMA_HOST` (default `http://localhost:11434/v1`), `NEWS_OLLAMA_MODEL` | Planned (NEWS-9) |
| `mock` | ❌ | none (`--ai-test` / `--provider mock`) | **Shipped** (tests / offline) |

Grounding non-searching providers with an external web-search step is tracked as NEWS-12.

See also: [2 — News Checks and Deduplication](2-news-checks-and-dedup.md), [4 — CLI, Server, and Storage](4-cli-server-storage.md).
