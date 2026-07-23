# News

Follow topics, not feeds. Enter a list of topics and, on a schedule you pick (e.g. once a day), the app asks Claude — with live web search — whether there's anything genuinely new on each one. New stories are summarized in a feed with links to the sources; anything already reported on a previous check is deduplicated away.

Built with [kerfjs](https://github.com/brianwestphal/kerf) + Hono + Tauri (hybrid web / desktop, same architecture as glassbox).

## Quick start

```sh
npm install
export ANTHROPIC_API_KEY=sk-ant-...   # or run with --ai-test for a mock service
npm run dev                            # http://127.0.0.1:4187
```

Data lives in `~/.news/data.json` (override with `--data-dir` or `NEWS_DATA_DIR`).

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
