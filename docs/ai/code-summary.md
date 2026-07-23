# Codebase Map (AI summary)

> Read this + `requirements-summary.md` at the start of a fresh session. Keep both in sync with reality in the same change as the code.

**News**: topic-based news tracker. Node/TS server (Hono) + kerfjs client; Claude (web search) finds news per topic on a schedule, deduplicated against previously seen stories. JSON-file storage. Optional Tauri desktop shell (dev-mode only so far).

## Directory tree

```
src/
  cli.ts              entry: arg parse → Store/service/runner → server → scheduler → open browser
  config.ts           CLI flags (--port --data-dir --provider --model --endpoint --no-open --strict-port --ai-test) + env
  server.ts           createApp (Hono, DI via middleware) + startServer (127.0.0.1, port fallback), /static handler
  scheduler.ts        startScheduler: 60s tick + 3s startup sweep, non-overlapping
  checks.ts           CheckRunner (checkTopic/checkDue/checkAll, in-flight guard) + isDue()
  types.ts            Hono AppEnv (store, runner injected)
  db/
    schemas.ts        zod: Topic, NewsItem, Settings, CheckRun, DataFile; DEFAULT_CHECK_INTERVAL_MS
    store.ts          Store: single data.json, atomic writes, corrupt-file backup+reset
  ai/
    types.ts          NewsService + NewsProvider interfaces, PROVIDER_NAMES/INFO, FoundNewsItem, KnownItem
    prompt.ts         searchingSystemPrompt, buildUserPrompt, parseNewsResult, NEWS_JSON_SCHEMA
    dedupe.ts         normalizeUrl/normalizeTitle/dedupeKeyFor/filterNewItems
    providers/
      index.ts        PROVIDERS/FACTORIES, AUTO_ORDER, resolveProvider, unavailableMessage
      anthropic.ts    createAnthropicProvider (opus-4-8, adaptive thinking, web_search_20260209, streamed)
      openai.ts       createOpenAIProvider (Responses API + hosted web_search, output_text); OPENAI_BASE_URL
      mock.ts         createMockProvider (--ai-test; deterministic; "fail"→throws, "empty"→[])
  api/
    schemas.ts        zod request schemas + StateResp (shared client/server)
  routes/
    api.ts            /api/state, /api/providers, /api/topics, /api/settings (interval+provider/model/endpoint), /api/check, /api/open-external, /healthz
    pages.tsx         GET / — SSR shell
  components/
    layout.tsx        HTML shell
  client/
    app.tsx           kerf UI: mount + delegates; header/banners/topics/feed
    stores.ts         appStore (defineStore)
    api.ts            fetch wrappers, refreshState (zod-validated), withRefresh
    tauri.ts          __TAURI__ detection, openExternalUrl
    styles.scss       styling (light/dark via prefers-color-scheme)
src-tauri/            Tauri v2 shell; one spawn path, dev runs tsx + release runs the sidecar
  src/lib.rs          server_command() picks the command; spawn_server() watches stdout + navigates
  binaries/           gitignored: news-node-<triple> (real Node binary, externalBin sidecar)
  server/             gitignored: staged cli.js + client/ + node_modules (bundled as `resources`)
scripts/
  build-sidecar.sh    builds/stages the above, then boots it from a temp dir to verify
.github/              CI: gate job (test:all) + rust job (fmt + clippy, BOTH profiles); dependabot
tests/
  helpers/            tmp.ts (tmp data dirs), provider.ts (asResolver/fakeProvider)
  unit/               vitest: dedupe, store, checks, scheduler, config, parse-result, providers, openai, api (via app.request)
  e2e/app.spec.ts     playwright, serial, mock AI (--ai-test), port 4189
docs/                 numbered requirements (1–6), ai/ summaries, manual-test-plan.md
```

## Data schema (`<data-dir>/data.json`)

- `topics[]`: id, name, paused, createdAt, lastCheckedAt
- `items[]`: id, topicId, title, summary, sources[{title,url}], dedupeKey, foundAt
- `settings`: checkIntervalMs (default 1 day, min 5 min), provider (default `auto`, `.catch('auto')` for retired providers), model (''), endpoint ('')
- `runs[]`: id, topicId, startedAt, finishedAt, status(running|succeeded|failed), newItems, error, provider (last 200)

Data dir: `--data-dir` flag → `NEWS_DATA_DIR` → `~/.news`.

## Build / run / test

- `npm run dev` — build client (esbuild IIFE + sass) then run server from source (tsx); port 4187
- `npm run build` — tsup → `dist/cli.js`; `npm run build:client` → `dist/client/`
- `npm run tauri:dev` — desktop dev shell (needs Rust; verified on macOS)
- `npm run tauri:build` — release app + dmg; runs `scripts/build-sidecar.sh` via `beforeBuildCommand`
- `npm test` (vitest+coverage) · `npm run test:e2e` (playwright) · `npm run test:all` (typecheck+lint+unit+e2e)
- Lint/typecheck: `npm run lint` / `npm run typecheck` (eslint strictTypeChecked + eslint-plugin-kerfjs)
- Rust: `cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings`, **and the same with `--release`** — the dev/release spawn paths are `cfg`-gated, so a debug-only check never compiles the release branch
- CI (`.github/workflows/ci.yml`) runs all of the above; **never executed — the repo has no remote yet** (NEWS-6)

## Where do I look for X?

| X | Look in |
|---|---|
| Add/modify an API endpoint | `src/routes/api.ts` + `src/api/schemas.ts` (+ client `src/client/api.ts`) |
| Add/change an AI provider | `src/ai/providers/` (+ register in `index.ts`); interface in `src/ai/types.ts` |
| Change prompts / result parsing | `src/ai/prompt.ts` |
| Provider selection / auto order | `src/ai/providers/index.ts` (`resolveProvider`, `AUTO_ORDER`) |
| Dedup behavior | `src/ai/dedupe.ts` (keys), `src/checks.ts` (application) |
| Scheduling rules | `src/checks.ts` (`isDue`), `src/scheduler.ts` (tick) |
| Persistence / schema change | `src/db/schemas.ts` + `src/db/store.ts` — **removing an enum value needs `.catch()`** or old files get reset (see the migration tests) |
| UI change | `src/client/app.tsx` (+ `styles.scss`); mind the kerf structural rules in `docs/3-ui.md` |
| New CLI flag | `src/config.ts` + `src/cli.ts` |
| Tauri shell | `src-tauri/src/lib.rs` (`running at ` marker must match `src/cli.ts`) |
| Release bundling / sidecar | `scripts/build-sidecar.sh` + `src-tauri/tauri.conf.json` (`externalBin`, `resources`) |
| A new runtime dependency | just add it to `package.json` `dependencies` — tsup externalizes it and the sidecar script installs it; no list to update |
| Mock behavior in tests | `src/ai/providers/mock.ts` (topic name containing "fail"/"empty" triggers those paths) |
