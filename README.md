# News

Follow topics, not feeds. Enter a list of topics and, on a schedule you pick (e.g. once a day), the app asks an AI — with live web search — whether there's anything genuinely new on each one. New stories are summarized in a feed with links to the sources; anything already reported on a previous check is deduplicated away.

Built with [kerfjs](https://github.com/brianwestphal/kerf) + Hono + Tauri (hybrid web / desktop, same architecture as glassbox).

## Quick start

```sh
npm install
export ANTHROPIC_API_KEY=sk-ant-...   # or run with --ai-test for a mock service
npm run dev                            # http://127.0.0.1:4187
```

Data lives in `~/.news/data.json` (override with `--data-dir` or `NEWS_DATA_DIR`).

## AI providers

Pick which AI finds and summarizes news, from the Source block in the UI or with `--provider` / `NEWS_PROVIDER`:

| Provider | Live web search? | Config |
|---|---|---|
| `auto` (default) | ✅ | picks the first available web-searching provider |
| `anthropic` | ✅ | `ANTHROPIC_API_KEY` (Claude + web search) |
| `openai` | ✅ | `OPENAI_API_KEY`, `OPENAI_BASE_URL` (Responses API + web search) |
| `ollama` | ❌ local model | `NEWS_OLLAMA_HOST`, `NEWS_OLLAMA_MODEL` — summarizes from the model's own knowledge, not a live search |
| `mock` | ❌ | offline deterministic (`--ai-test`) |

Seed at startup with `--provider <name> --model <id> --endpoint <url>` (or `NEWS_PROVIDER`/`NEWS_MODEL`/`NEWS_ENDPOINT`); change any time in the UI. See [docs/6-providers.md](docs/6-providers.md).

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Build client assets and run the server from source |
| `npm test` | Unit tests (vitest, with coverage) |
| `npm run test:e2e` | Browser E2E tests (Playwright, mock AI) |
| `npm run test:all` | Typecheck + lint + unit + E2E |
| `npm run tauri:dev` | Desktop app in dev mode (needs Rust) |
| `npm run build` | Bundle the server CLI to `dist/` |

## Docs

Requirements live in `docs/` (numbered); AI session summaries in `docs/ai/`.
