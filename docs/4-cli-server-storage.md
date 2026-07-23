# 4 — CLI, Server, and Storage

## CLI

- **FR-4.1** `news` (dev: `npm run dev` → `tsx src/cli.ts`) starts the server and opens the browser. Flags:
  - `--port N` — requested port (default 4187)
  - `--data-dir PATH` — data directory (default `$NEWS_DATA_DIR` or `~/.news`)
  - `--provider auto|anthropic|openai|mock` — seed the provider setting (env `NEWS_PROVIDER`)
  - `--model ID` — seed the model setting (env `NEWS_MODEL`)
  - `--endpoint URL` — seed the endpoint setting for OpenAI-compatible gateways (env `NEWS_ENDPOINT`)
  - `--no-open` — don't open the browser
  - `--strict-port` — fail instead of falling back when the port is busy
  - `--ai-test` — force the deterministic mock provider (no API key needed)

  Provider/model/endpoint flags **seed** the persisted settings at startup; the UI changes them thereafter. See [6 — AI Providers](6-providers.md) for provider-specific env vars.
- **FR-4.2** Unknown flags or bad values print a usage line and exit non-zero.
- **FR-4.3** The server prints `news running at http://127.0.0.1:<port>` on stdout when ready — the Tauri shell watches for this exact `running at ` marker (KEEP IN SYNC with `src-tauri/src/lib.rs`).
- **FR-4.4** SIGINT/SIGTERM stop the scheduler and server cleanly.

## Server

- **FR-4.5** Hono + `@hono/node-server`, bound to 127.0.0.1 only. Default port 4187 with fallback across the next 20 ports unless `--strict-port`.
- **FR-4.6** API surface: `GET /api/state`, `GET /api/providers`, `POST /api/topics`, `PATCH|DELETE /api/topics/:id`, `PATCH /api/settings` (interval + provider/model/endpoint), `POST /api/check`, `POST /api/open-external`, `GET /healthz`. Request bodies are zod-validated; invalid input → 400, unknown ids → 404, duplicate topics → 409.
- **FR-4.7** Static client assets are served from `/static/*` (flat directory; path traversal rejected). The page shell is server-rendered kerfjs JSX.

## Storage

- **FR-4.8** All data lives in one zod-validated JSON file, `<data-dir>/data.json`: topics, items, settings, and the last 200 check runs. Writes are atomic (temp file + rename).
- **FR-4.9** A corrupt data file is backed up (`data.json.corrupt-<ts>`) and the app starts fresh rather than crashing. Schema *evolution* must not trigger this: removed keys are stripped by zod, and a stored `provider` that no longer exists degrades to `auto` (`.catch('auto')`), so retiring a provider never wipes a user's topics.
- **FR-4.10** Tests never touch `~/.news` — unit tests and E2E use temp dirs.

See also: [5 — Desktop App](5-desktop-app.md).
