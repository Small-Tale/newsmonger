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
- **FR-4.5a** Requests that a page on another origin could have made are rejected with 403 (`src/origin-guard.ts`, applied to *every* route — page, static assets and API alike, ahead of any handler that reads a body or touches state).

  Loopback binding keeps other machines out; it does nothing about the user's own browser. Any site they visit can issue requests to `http://127.0.0.1:4187`, and while it can't read the responses without CORS, `DELETE /api/topics/:id` and `POST /api/check` (which spends API credit) take effect regardless of whether anyone reads the reply. Two checks close that:

  - the **`Host`** must name this machine — `localhost`, a `.localhost` name (RFC 6761 reserves that TLD for loopback, and it's what Tauri's webview uses on Windows/Linux), `127.0.0.1`, or `::1`. This is what stops **DNS rebinding**, where an attacker-controlled name resolves to loopback and the browser therefore treats the app as same-origin — the case where reads *do* get through.
  - the **`Origin`**, when present, must be one of those same hosts or a `tauri:` webview origin. A literal `null` (sandboxed iframe, `data:` document) is rejected: it is never the app's own page.

  An **absent** `Origin` is allowed — no browser can omit it on a cross-origin request, so absence means a non-browser caller (curl, the test harness). This is deliberately **not authentication**: a local process can still call the API, but it could equally read `data.json` directly, so the guard's scope is the browser, not the machine.
- **FR-4.6** API surface: `GET /api/state`, `GET /api/providers`, `POST /api/topics`, `PATCH|DELETE /api/topics/:id`, `PATCH /api/settings` (interval + provider/model/endpoint), `POST /api/check`, `POST /api/open-external`, `GET /healthz`. Request bodies are zod-validated; invalid input → 400, unknown ids → 404, duplicate topics → 409.
- **FR-4.7** Static client assets are served from `/static/*` (flat directory; path traversal rejected). The page shell is server-rendered kerfjs JSX.

## Storage

- **FR-4.8** All data lives in one zod-validated JSON file, `<data-dir>/data.json`: topics, items, settings, and the last 200 check runs. Writes are atomic (temp file + rename).
- **FR-4.9** A corrupt data file is backed up (`data.json.corrupt-<ts>`) and the app starts fresh rather than crashing. Schema *evolution* must not trigger this: removed keys are stripped by zod, and a stored `provider` that no longer exists degrades to `auto` (`.catch('auto')`), so retiring a provider never wipes a user's topics.
- **FR-4.10** Tests never touch `~/.news` — unit tests and E2E use temp dirs.
- **FR-4.11** *(Shipped)* **Story retention** (NEWS-87). Stories older than `settings.itemRetentionDays` are dropped; the default is **365 days** and **0 means keep forever** (the pre-NEWS-87 behaviour). `runs` has been capped at 200 all along and images are pruned by mark-and-sweep — `items` was the one collection with no ceiling at all, and every mutation rewrites the whole file, so unbounded growth was a write-cost problem as much as a disk one.

  Two exemptions, both deliberate: **bookmarked** stories, which the user marked as worth keeping (retention is about the pile that accumulates on its own, not the things they chose), and **off-topic flagged** ones, whose titles feed the prompt's negative-example list — pruning those would quietly un-teach the model what the user meant by a topic.

  Pruning runs at **startup** (an install closed for months comes back trimmed) and **after each successful check** (an always-on install would otherwise never reclaim anything). It reclaims the dropped stories' cached images in the same pass, and is best-effort: a failure is logged and never turns a successful check into a failed one. A run that drops nothing does not rewrite the file.

  The window is a boundary-inclusive `>=`: a story found exactly `days` ago is inside the window.

  > The storage *engine* is unchanged — this bounds the JSON file rather than replacing it. Moving to SQLite (per-row writes, a smaller corruption blast radius, FTS5 search) is **NEWS-94**.

See also: [5 — Desktop App](5-desktop-app.md).
