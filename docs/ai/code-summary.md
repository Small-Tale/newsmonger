# Codebase Map (AI summary)

> Read this + `requirements-summary.md` at the start of a fresh session. Keep both in sync with reality in the same change as the code.

**News**: topic-based news tracker. Node/TS server (Hono) + kerfjs client; Claude (web search) finds news per topic on a schedule, deduplicated against previously seen stories. JSON-file storage. Optional Tauri desktop shell (dev-mode only so far).

## Directory tree

```
src/
  cli.ts              entry: arg parse → Store/service/runner → server → scheduler → open browser
  config.ts           CLI flags (--port --data-dir --no-open --strict-port --ai-test), data-dir resolution
  server.ts           createApp (Hono, DI via middleware) + startServer (127.0.0.1, port fallback), /static handler
  scheduler.ts        startScheduler: 60s tick + 3s startup sweep, non-overlapping
  checks.ts           CheckRunner (checkTopic/checkDue/checkAll, in-flight guard) + isDue()
  types.ts            Hono AppEnv (store, runner injected)
  db/
    schemas.ts        zod: Topic, NewsItem, Settings, CheckRun, DataFile; DEFAULT_CHECK_INTERVAL_MS
    store.ts          Store: single data.json, atomic writes, corrupt-file backup+reset
  ai/
    types.ts          NewsService + NewsProvider interfaces, PROVIDER_NAMES, FoundNewsItem, KnownItem
    prompt.ts         shared prompts (searching/offline), buildUserPrompt, parseNewsResult, NEWS_JSON_SCHEMA
    dedupe.ts         normalizeUrl/normalizeTitle/dedupeKeyFor/filterNewItems
    providers/
      index.ts        PROVIDERS/FACTORIES, AUTO_ORDER, resolveProvider, unavailableMessage
      anthropic.ts    createAnthropicProvider (opus-4-8, adaptive thinking, web_search_20260209, streamed); searchesWeb:true
      openai.ts       createOpenAIProvider (Responses API + hosted web_search, output_text; searchesWeb:true); OPENAI_BASE_URL
      ollama.ts       createOllamaProvider (OpenAI-compat, local; searchesWeb:false); endpoint/model resolution + env
      openaiCompat.ts shared OpenAI-compatible backend (model discovery, JSON chat, parse) — reused for hosted gateways later
      mock.ts         createMockProvider (--ai-test; deterministic; "fail"→throws, "empty"→[]); searchesWeb:false
  api/
    schemas.ts        zod request schemas + StateResp (shared client/server)
  routes/
    api.ts            /api/state (+searchesWeb), /api/providers, /api/topics, /api/settings (interval+provider/model/endpoint), /api/check, /api/open-external, /healthz
    pages.tsx         GET / — SSR shell
  components/
    layout.tsx        HTML shell
  client/
    app.tsx           kerf UI: mount + delegates; header/banners/topics/feed
    stores.ts         appStore (defineStore)
    api.ts            fetch wrappers, refreshState (zod-validated), withRefresh
    tauri.ts          __TAURI__ detection, openExternalUrl
    styles.scss       styling (light/dark via prefers-color-scheme)
src-tauri/            Tauri v2 shell: dev spawns `node --import tsx src/cli.ts`; release NOT bundled yet
tests/
  helpers/tmp.ts      tmp data dirs, auto-cleanup
  unit/               vitest: dedupe, store, checks, scheduler, config, parse-result, api (via app.request)
  e2e/app.spec.ts     playwright, serial, mock AI (--ai-test), port 4189
docs/                 numbered requirements (1–5), ai/ summaries, manual-test-plan.md
```

## Data schema (`<data-dir>/data.json`)

- `topics[]`: id, name, paused, createdAt, lastCheckedAt
- `items[]`: id, topicId, title, summary, sources[{title,url}], dedupeKey, foundAt
- `settings`: checkIntervalMs (default 1 day, min 5 min), provider (default `auto`), model (''), endpoint ('')
- `runs[]`: id, topicId, startedAt, finishedAt, status(running|succeeded|failed), newItems, error, provider (last 200)

Data dir: `--data-dir` flag → `NEWS_DATA_DIR` → `~/.news`.

## Build / run / test

- `npm run dev` — build client (esbuild IIFE + sass) then run server from source (tsx); port 4187
- `npm run build` — tsup → `dist/cli.js`; `npm run build:client` → `dist/client/`
- `npm run tauri:dev` — desktop dev shell (needs Rust; unverified)
- `npm test` (vitest+coverage) · `npm run test:e2e` (playwright) · `npm run test:all` (typecheck+lint+unit+e2e)
- Lint/typecheck: `npm run lint` / `npm run typecheck` (eslint strictTypeChecked + eslint-plugin-kerfjs)

## Where do I look for X?

| X | Look in |
|---|---|
| Add/modify an API endpoint | `src/routes/api.ts` + `src/api/schemas.ts` (+ client `src/client/api.ts`) |
| Add/change an AI provider | `src/ai/providers/` (+ register in `index.ts`); interface in `src/ai/types.ts` |
| Change prompts / result parsing | `src/ai/prompt.ts` |
| Provider selection / auto order | `src/ai/providers/index.ts` (`resolveProvider`, `AUTO_ORDER`) |
| Dedup behavior | `src/ai/dedupe.ts` (keys), `src/checks.ts` (application) |
| Scheduling rules | `src/checks.ts` (`isDue`), `src/scheduler.ts` (tick) |
| Persistence / schema change | `src/db/schemas.ts` + `src/db/store.ts` (bump carefully: old files that fail the schema get reset) |
| UI change | `src/client/app.tsx` (+ `styles.scss`); mind the kerf structural rules in `docs/3-ui.md` |
| New CLI flag | `src/config.ts` + `src/cli.ts` |
| Tauri shell | `src-tauri/src/lib.rs` (`running at ` marker must match `src/cli.ts`) |
| Mock behavior in tests | `src/ai/providers/mock.ts` (topic name containing "fail"/"empty" triggers those paths) |
