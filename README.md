# Newsmonger

Follow topics, not feeds. Enter a list of topics and, on a schedule you pick (e.g. once a day), the app asks an AI — with live web search — whether there's anything genuinely new on each one. New stories are summarized in a feed with links to the sources; anything already reported on a previous check is deduplicated away.

Built with [kerfjs](https://github.com/brianwestphal/kerf) + Hono + Tauri (hybrid web / desktop, same architecture as glassbox).

## Quick start

```sh
npm install
npm run dev     # http://127.0.0.1:4187
```

**No API key needed.** If you're signed in to [Claude Code](https://claude.com/claude-code) or the [Codex CLI](https://developers.openai.com/codex/cli), Newsmonger uses that subscription — it drives the CLI you already have, so checks come out of your existing plan rather than a metered key. That's the default and the recommended way to run it. Add `--ai-test` for an offline mock, or set an API key in Settings if you'd rather pay per call.

Data lives in `~/.newsmonger/newsmonger.db`, a SQLite database (override the directory with `--data-dir` or `NEWSMONGER_DATA_DIR`). A `data.json` left by an older build is imported automatically on first start and renamed.

## AI providers

Pick which AI finds and summarizes news, from the Source block in the UI or with `--provider` / `NEWSMONGER_PROVIDER`. Only platforms that do their own web search are supported — finding genuinely new news needs live browsing:

| Provider | Config |
|---|---|
| `auto` (default) | first available, in the order below — **subscriptions before API keys** |
| `claude-cli` | none — your **Claude subscription**, via the signed-in `claude` CLI |
| `codex-cli` | none — your **ChatGPT subscription**, via the signed-in `codex` CLI |
| `anthropic` | `ANTHROPIC_API_KEY` (Claude + web search) |
| `openai` | `OPENAI_API_KEY`, `OPENAI_BASE_URL` (Responses API + web search) |
| `mock` | offline deterministic (`--ai-test`) |

The two subscription providers are tried first on purpose: if you hold a subscription, you expect its quota spent before a key you also happen to have configured. They're **attended** — scheduled checks run only while Newsmonger is open, so it never becomes an unattended background agent on your account. Manual checks always run. See [docs/9-subscription-providers.md](docs/9-subscription-providers.md).

Seed at startup with `--provider <name> --model <id> --endpoint <url>` (or `NEWSMONGER_PROVIDER`/`NEWSMONGER_MODEL`/`NEWSMONGER_ENDPOINT`); change any time in the UI. See [docs/6-providers.md](docs/6-providers.md).

## Privacy

Newsmonger has no servers and collects no telemetry. Two kinds of data, and it's worth being precise about which is which:

**Sent to the AI provider you chose, on every check** — the topic's name, its guidance if you wrote any, the titles of stories already reported for that topic (that is how repeats are avoided), and the titles of stories you flagged off-topic (that is how it infers what you meant). Nothing else: not the feed, not your other topics, not your bookmarks.

**Stored on your machine only** — topics, the stories found, and cached article images, all under `~/.newsmonger`. **API keys are not stored there**: they go in your OS keychain (macOS Keychain, GNOME Keyring/KWallet, Windows Credential Manager), or come from an environment variable. See [docs/7-api-keys.md](docs/7-api-keys.md).

The only other outbound traffic is fetching an article's lead image (proxied through the app so your browser never talks to a news site directly — [docs/8-article-images.md](docs/8-article-images.md)) and opening links you click.

The same note is in the app, under Settings → Privacy.

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
