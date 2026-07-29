# Codebase Map (AI summary)

> Read this + `requirements-summary.md` at the start of a fresh session. Keep both in sync with reality in the same change as the code.

**News**: topic-based news tracker. Node/TS server (Hono) + kerfjs client; Claude (web search) finds news per topic on a schedule, deduplicated against previously seen stories. JSON-file storage. Optional Tauri desktop shell (dev-mode only so far).

## Directory tree

```
src/
  cli.ts              entry: arg parse → Store/service/runner → server → scheduler → open browser
  config.ts           CLI flags (--port --data-dir --provider --model --endpoint --no-open --strict-port --ai-test) + env
  server.ts           createApp (Hono, DI via middleware) + startServer (127.0.0.1, port fallback), /static handler
  export.ts           toMarkdown/toJson/toAtom + escapeXml — export & feed rendering, pure (NEWS-85)
  origin-guard.ts     Host/Origin check on every route — cross-origin + DNS-rebinding guard (NEWS-86)
  discovery.ts        DiscoveryService: topic-suggestion exclusions + in-memory request cache + classification validation + call log (NEWS-125)
  scheduler.ts        startScheduler: 60s tick + 3s startup sweep, non-overlapping; drains an overrun cycle (NEWS-57)
  checks.ts           CheckRunner (checkTopic/checkDue/checkAll, in-flight guard) + isDue()/isDueDaily()/isDueUnderSchedule()/lastSlotBefore() (NEWS-84) + effectiveInterval() + byCheckOrder() (most-overdue-first, NEWS-58). No budget logic — NEWS-119 removed it
  types.ts            Hono AppEnv (store, runner injected)
  keychain.ts         OS credential store via platform CLI (security/secret-tool/cmdkey)
  images/             og:image scrape + local cache; safety.ts holds the SSRF guards
  attendance.ts       Attendance: in-memory lastSeenAt + 5 min window; gates attended providers
  db/
    schemas.ts        zod: Topic, NewsItem, Settings, CheckRun, DataFile; DEFAULT_CHECK_INTERVAL_MS, MAX_GUIDANCE_LENGTH
    store.ts          Store: SQLite (node:sqlite), per-row writes, zod-validated rows, corrupt-db backup+reset, one-time data.json import (NEWS-94)
    sqlite.ts         schema DDL, SCHEMA_VERSION + MIGRATIONS (user_version based), openDb (WAL + sanity probe), backupUnreadableDb, dbPath
    warnings.ts       filters ONLY node:sqlite's ExperimentalWarning; imported before the require in sqlite.ts
  ai/
    types.ts          AUTO_ORDER (client-safe, NEWS-128); DISCOVERY_MODELS + usesLegacyRequestShape (NEWS-132); NewsService (checkTopic + suggestTopics) + NewsProvider, TopicContext, CheckResult/TokenUsage, SuggestRequest/SuggestScope/TopicSuggestion (NEWS-124), PROVIDER_NAMES/INFO, FoundNewsItem, KnownItem
    prompt.ts         searchingSystemPrompt, buildUserPrompt, parseNewsResult, NEWS_JSON_SCHEMA
    suggest-prompt.ts topic *discovery* prompting: suggestSystemPrompt, buildSuggestPrompt, parseSuggestResult, SUGGEST_JSON_SCHEMA (NEWS-124)
    retry.ts          two backoffs (in-check DEFAULT_BACKOFF, per-topic FAILURE_COOLDOWN), failure classification, Retry-After parsing (NEWS-109/110)
    verify-links.ts   probeLink/verifyItemLinks — citation checking before storage (NEWS-83)
    verify-key.ts     verifyApiKey — vendor-side key check before saving; 401/403 = invalid, else unknown (NEWS-78)
    api-keys.ts       resolveApiKey/saveApiKey/deleteApiKey — env then keychain, never the database
    sanitize.ts       stripMarkup — strips model citation markup (<cite>) from prose, idempotent
    dedupe.ts         normalizeUrl/normalizeTitle/dedupeKeyFor/filterNewItems
    providers/
      index.ts        PROVIDERS/FACTORIES, AUTO_ORDER, resolveProvider, unavailableMessage
      anthropic.ts    createAnthropicProvider (opus-4-8, adaptive thinking, web_search_20260209, streamed); messageParams() builds the body — shape varies by model for the haiku discovery path (NEWS-132)
      claude-cli.ts   createClaudeCliProvider — Claude subscription via the Claude Code CLI; attended: true
      codex-cli.ts    createCodexCliProvider — ChatGPT subscription via Codex (-s read-only); attended: true
      openai.ts       createOpenAIProvider (Responses API + hosted web_search, output_text); OPENAI_BASE_URL
      mock.ts         createMockProvider (--ai-test; deterministic; "fail"→throws, "empty"→[]); suggestTopics keys off a request seed and plants an excluded name on purpose (NEWS-124)
  api/
    schemas.ts        zod request schemas + StateResp (shared client/server)
  routes/
    api.ts            /api/discover + /api/discover/usage (NEWS-125), /api/state (topics/settings/runs/checking + latestItemIds + flaggedByTopic; NO items), /api/items (paginated feed: filter+sort+cursor), /api/providers, /api/topics, /api/items/:id (save/flag), /api/settings, /api/keys, /api/foreground, /api/check, /api/open-external, /api/export.md, /api/export.json, /feed.xml, /healthz
    pages.tsx         GET / — SSR shell
  components/
    layout.tsx        HTML shell
  client/
    app.tsx           kerf UI: mount + delegates; header/banners/settings dialog/topics/feed
    stores.ts         appStore (defineStore)
    api.ts            fetch wrappers, refreshState (zod-validated), withRefresh
    icons.tsx         ALL icons live here — Lucide paths inlined (lucide-static@1.26.0), no runtime dep, no emoji
    tauri.ts          __TAURI__ detection, openExternalUrl, bounceDockIcon, focusAppWindow
    notifications.ts  noteState — OS notification when new items arrive while unfocused (NEWS-38)
    share.ts          shareText + shareItem — OS share sheet, clipboard fallback (NEWS-43)
    schedule.ts       isBehindSchedule/topicsBehindSchedule — falling-behind detection for the banner (NEWS-59)
    failure.ts        currentFailure — the topic-currently-failing warning source (NEWS-41); dismissal persisted in localStorage
    search.ts         itemMatchesQuery/filterItemsByQuery — live feed search filter (NEWS-60)
    attribution.ts    outletFor/publishedLabel — source outlet + publication date display (NEWS-82)
    diagnostics.ts    runRows/formatDuration/buildDiagnostics — redacted bug-report bundle (NEWS-88) + the discovery call log (NEWS-130)
    discover-progress.ts estimateTargetMs/recordDuration — the discovery progress-bar estimate, median of the last 10 durations in localStorage (NEWS-137)
    discover.ts       groupSuggestions/resultsHeading/sectionTiles (NEWS-126) + the pure tuner state machine: startTuner/judgeCandidate/nextRound/mergeKept (NEWS-127)
    solo.ts           toggleSolo/isAllSoloed — solo-set arithmetic shared by the context menu and the double-click gesture (NEWS-95)
    dial.ts           dialRemaining — the sidebar ring's countdown fraction (NEWS-144)
    menu-position.ts  placeMenu/menuStyle — clamps a context menu into the viewport so its last item stays reachable (NEWS-149)
    onboarding.ts     onboardingCountText — the Topics step's running count, which names ticked-but-not-created and already-created separately (NEWS-146)
    topic-sort.ts     sortTopics (NEWS-63) + topicRows — the sidebar's rows, with section headings interleaved in the By-section sort (NEWS-140)
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
  unit/               vitest: dedupe, store, checks, scheduler, config, parse-result, providers, openai, api, api-keys, api-keys-routes, attendance, catch-up, sanitize, origin-guard, guidance, key-verify, diagnostics, retention, export, daily-schedule, verify-links, attribution, concurrency, suggest-prompt, suggest-providers, discovery, discover-client, discover-progress
  e2e/                playwright, serial, mock AI (--ai-test), port 4189: app.spec.ts, keys.spec.ts, topics.spec.ts, a11y.spec.ts (axe-core, both themes), categories.spec.ts (NEWS-97), discover.spec.ts (NEWS-126), layout.spec.ts (full-window layout + column count at several viewports, NEWS-96). `resetTopics` in a beforeAll gives every attempt — first run or serial retry — an empty server (NEWS-101)
docs/                 numbered requirements (1–25), ai/ summaries, manual-test-plan.md
```

## Data schema (`<data-dir>/news.db`, SQLite — NEWS-94)

Tables `topics` / `items` / `runs` / `meta` (settings as one JSON row). Booleans are INTEGER 0/1; `sources`, `image` and `usage` are JSON columns. No foreign keys — a check can outlive its topic, so `deleteTopic` cascades explicitly. The shapes below are the zod schemas every row is validated against on read.

- `topics[]`: id, name, paused, highPriority (checked on the shorter interval — NEWS-56), guidance (free-text steer fed to the prompt — NEWS-80), createdAt, lastCheckedAt (every attempt), coveredThroughAt (successes only — drives the prompt window)
- `items[]`: id, topicId, title, summary, sources[{title,url,outlet,publishedAt — NEWS-82}], image, saved (bookmark), offTopic (NEWS-61 flag), dedupeKey, foundAt
- `settings`: itemRetentionDays (default 365, 0 = forever — NEWS-87), checkIntervalMs (default 1 day, min 5 min), highPriorityIntervalMs (≤ checkIntervalMs, clamped on update+load — NEWS-56), provider (default `auto`, `.catch('auto')` for retired providers), model (''), endpoint (''), notifyOnNewItems, monthlyBudgetUsd (0 = no cap — NEWS-79)
- `runs[]`: id, topicId, startedAt, finishedAt, status(running|succeeded|failed), newItems, error, provider, model, usage (tokens+searches, null = unknown — NEWS-79) (last 200)

Data dir: `--data-dir` flag → `NEWS_DATA_DIR` → `~/.news`. Also holds `news.db-wal`/`-shm`, `prices.json` (live model rates, user-editable — NEWS-93) and the image cache.

## Build / run / test

- `npm run dev` — build client (esbuild IIFE + sass, **dev bundle**) then run server from source (tsx); port 4187
- `npm run build:client` (prod, `__KERF_DEV__=false`) vs `build:client:dev` (kerf diagnostics + `invariants: 'throw'`) — NEWS-100
- `npm run build` — tsup → `dist/cli.js`; `npm run build:client` → `dist/client/`
- `npm run tauri:dev` — desktop dev shell (needs Rust; verified on macOS)
- `npm run tauri:build` — release app + dmg; runs `scripts/build-sidecar.sh` via `beforeBuildCommand`
- `npm test` (vitest+coverage) · `npm run test:e2e` (playwright) · `npm run test:all` (typecheck+lint+unit+e2e)
- `npm run commit:msg` — gitgist drafts a commit message from the staged diff. Output is Conventional Commits and must be reshaped to this project's style; see CLAUDE.md → Git
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
| Dead / hallucinated source links | `src/ai/verify-links.ts`, called from `CheckRunner.verifyLinks` **before** dedup. Reuses `images/safety.ts` SSRF vetting; null probe under `--ai-test`. See `docs/2-news-checks-and-dedup.md` FR-2.6–2.10 |
| Scheduling rules | `src/checks.ts` (`isDueUnderSchedule` picks interval vs daily — NEWS-84; `isDue`, `effectiveInterval`, `byCheckOrder`), `src/scheduler.ts` (tick + overrun drain). **Adding a topic checks it immediately** — `POST /api/topics` fires `checkTopic({manual:true})` in the background (NEWS-54, FR-1.12) |
| How many checks run at once | `checkConcurrency` setting + `CheckRunner.runPool` (shared cursor, `byCheckOrder` start order). See `docs/13-scheduling-under-load.md` FR-13.4–13.7 |
| Behaviour under load (overrun, ordering, falling-behind) | `src/scheduler.ts` drain (NEWS-57), `byCheckOrder` in `src/checks.ts` (NEWS-58), `src/client/schedule.ts` + the "falling behind" banner in `app.tsx` (NEWS-59). See `docs/13-scheduling-under-load.md` |
| Topic priority (high-priority interval) | `highPriority` on the topic + `highPriorityIntervalMs` in settings; `effectiveInterval` in `src/checks.ts`; clamp in `store.updateSettings` + `SettingsSchema` transform; menu action `priority` + star icon in `app.tsx`. See `docs/12-topic-priority.md` |
| How far back a check asks | `coveredThroughAt` on the topic → `sinceIso` → `windowLine()` in `src/ai/prompt.ts`; **not** `lastCheckedAt` |
| How much a check returns | `searchingSystemPrompt()` volume rule (portable); `max_uses: 8` in `anthropic.ts` is a cost guard, not the mechanism |
| Persistence / schema change | `src/db/schemas.ts` + `src/db/store.ts` — **removing an enum value needs `.catch()`** or old files get reset (see the migration tests) |
| UI change | `src/client/app.tsx` (+ `styles.scss`); mind the kerf structural rules in `docs/3-ui.md`. **kerfjs 4.0.0** — dev diagnostics are opt-in by import (we don't import them; NEWS-100), KF-377 is fixed (NEWS-99), and enumerated attributes take keyword strings (NEWS-123) |
| New CLI flag | `src/config.ts` + `src/cli.ts` |
| Tauri shell | `src-tauri/src/lib.rs` (`running at ` marker must match `src/cli.ts`) |
| Release bundling / sidecar | `scripts/build-sidecar.sh` + `src-tauri/tauri.conf.json` (`externalBin`, `resources`) |
| A new runtime dependency | just add it to `package.json` `dependencies` — tsup externalizes it and the sidecar script installs it; no list to update |
| Mock behavior in tests | `src/ai/providers/mock.ts` (topic name containing "fail"/"empty" triggers those paths) |
| API keys / keychain | `src/keychain.ts` (OS layer) + `src/ai/api-keys.ts` (env→keychain precedence); `NEWS_FAKE_KEYCHAIN=1` for tests |
| Foreground/attendance gate | `src/attendance.ts` + `CheckRunner.checkDue`; provider opts in via `attended: true`. **Manual checks (`{manual:true}`) record attendance** so a long sweep isn't deferred (NEWS-44) |
| Article images / SSRF guards | `src/images/` — `safety.ts` (URL vetting), `ogimage.ts` (extract), `cache.ts` (fetch+store+`pruneImageCache`), route `/api/image/:hash` is **cache-only** |
| Image cache pruning | `pruneImageCache`/`liveImageHashes` in `src/images/cache.ts`; called at startup (`cli.ts`) + on `DELETE /api/topics/:id` |
| Settings dialog | `src/client/app.tsx` `settingsDialogJsx`/`keyRowJsx`; routes in `src/routes/api.ts` under `/api/keys` |
| Sidebar collapse | `sidebarCollapsed` in `src/client/stores.ts` (localStorage `news:sidebar-collapsed`); `.shell.sidebar-collapsed` in `styles.scss` |
| Topic selection / context menu / solo | `src/client/app.tsx` (`contextMenuJsx`, `selectTopic`, `runTopicAction`); state in `stores.ts`. **Row state outside the topic object needs `each()`'s cacheKey** |
| Confirm a destructive action | `confirm()` helper + `confirmDialogJsx` in `app.tsx`. **Never `window.confirm` — a silent no-op in Tauri's WKWebView** |
| Save/bookmark or share a story | `src/client/app.tsx` (bookmark + share buttons in `itemJsx`, `showToast`); `setItemSaved` in `store.ts` + `PATCH /api/items/:id`; `src/client/share.ts`. See `docs/11-story-actions.md` |
| Feed filters (Solo / Saved / Search) | **Server-side** now (NEWS-76): `Store.queryItems` filters; client sends view params via `refreshFeed` (`src/client/api.ts`). Search is debounced. `feedItems`/`feedTotal` in `stores.ts`. See `docs/14-search.md` + `docs/17-server-pagination.md` |
| Feed pagination ("Show more") | `feedLimit`/`FEED_PAGE`/`showMoreFeed` in `stores.ts` (reset per view) → `/api/items?limit=`; `moreCount` from server `total`. See `docs/16-pagination.md` |
| The feed data / where items come from | `/api/items` via `refreshFeed`, NOT `/api/state` (slimmed). Just-flagged overlay: `recentlyFlaggedItems` merged in `app.tsx`. Notifications read `latestItemIds`. See `docs/17-server-pagination.md` |
| Export / the Atom feed | `src/export.ts` (pure renderers) + `/api/export.md`, `/api/export.json`, `/feed.xml` in `routes/api.ts`; Settings "Export & feed" block. `scope=all\|saved\|topic`. See `docs/21-export-and-feed.md` |
| Story retention / data-file growth | `Store.pruneOldItems` + `itemRetentionDays` setting; called from `cli.ts` at startup and `CheckRunner.pruneAfterCheck` after each success. Bookmarked + flagged items exempt. See `docs/4-cli-server-storage.md` FR-4.11 |
| Diagnostics / "why did a check fail" | `src/client/diagnostics.ts` (pure, unit-tested) + the Settings Diagnostics section; `appVersion` on `/api/state`. Topic names redacted unless opted in. See `docs/3-ui.md` FR-3.25–3.28 |
| Solo filter (set arithmetic, menu + double-click) | `src/client/solo.ts` (`toggleSolo`, `isAllSoloed`), used by `runTopicAction` and the `dblclick` delegate in `app.tsx`. See `docs/3-ui.md` FR-3.40 |
| Topic categories / taxonomy | `src/categories.ts` (`BUILTIN_CATEGORIES`, `categoryLabel`, `activeCategories`). See `docs/22-topic-categories.md` |
| Topic discovery / suggestions | `NewsService.suggestTopics` + `SuggestRequest`/`SuggestScope`/`TopicSuggestion` in `src/ai/types.ts`; prompting + parsing in `src/ai/suggest-prompt.ts`; all 5 providers (NEWS-124). Server: `src/discovery.ts` (`DiscoveryService` — exclusions, request cache, classification validation, call log) + `POST /api/discover` / `GET /api/discover/usage` (NEWS-125). Client: `src/client/discover.ts` (grouping/headings) + the dialog in `app.tsx` (NEWS-126). Tuner (NEWS-127) + onboarding integration (NEWS-128) shipped. Variation D (newsstand) deferred — NEWS-129. See `docs/24-topic-discovery.md` |
| Provider retries / rate limiting | `src/ai/retry.ts` (`backoffDelayMs`, `classifyFailure`, `retryAfterMs`, `DEFAULT_BACKOFF` vs `FAILURE_COOLDOWN`); `checkWithRetry` + `rateLimitedUntil` in `checks.ts`. See `docs/23-retries-and-rate-limits.md` |
| A topic held back after failures | `consecutiveFailures`/`retryAfter` columns; `recordCheckFailure`/`clearCheckFailures` in `db/store.ts`; the cooldown check at the top of `isDueUnderSchedule`. See FR-23.7 |
| Settings tabs / panels | `SETTINGS_TABS`, `settingsTabsJsx`, `settingsPanelJsx` in `client/app.tsx`; `settingsTab` in `stores.ts`; `.settings-tabs` in `styles.scss`. See `docs/3-ui.md` FR-3.45 |
| Privacy dialog | `privacyDialogJsx` + `#privacy-slot` + the footer `[data-action=open-privacy]`. See FR-3.47 |
| Icons, favicon, web app manifest | `assets/*.svg` sources; `manifest()` + the `/manifest.webmanifest` route in `src/routes/pages.tsx`; `<link>`s in `src/components/layout.tsx`. See `docs/3-ui.md` FR-3.43–3.44 |
| Which filter pills are shown | `visibleCategories`/`visibleSubcategories`/`hasUncategorized` in `src/categories.ts` (pure, over the topic list). See `docs/22-topic-categories.md` FR-22.13–22.15 |
| Renaming a topic / clearing its stories | `Store.renameTopic` / `clearItemsForTopic`; the story count comes from `GET /api/items?topics=<id>&limit=1` when the dialog opens (**not** `/api/state`, which is polled every 4 s); `PATCH /api/topics/:id { name, clearItems }`; `renameDialogJsx` + `saveRename` in `client/app.tsx`. See `docs/25-topic-editing.md` |
| Sidebar sort order / section headings | `src/client/topic-sort.ts` (`sortTopics`, `topicRows`); `TOPIC_SORTS`/`TOPIC_SORT_LABELS` in `client/stores.ts`; `.topic-section` in `styles.scss`. See `docs/3-ui.md` FR-3.2a |
| Section filter bar / sidebar pills | `filterBarJsx` + `[data-filter-category]`/`[data-filter-subcategory]` delegates in `client/app.tsx`; `.filter-bar` in `styles.scss`; server filter in `Store.queryItems`. See `docs/22-topic-categories.md` FR-22.9–22.12 |
| Automatic topic classification | `needsClassifying`/`classifierOptions`/`applyClassification` in `checks.ts`; prompt + parsing in `ai/prompt.ts`. See `docs/22-topic-categories.md` FR-22.8 |
| Stale refresh overwriting newer state | sequence guards in `refreshState`/`refreshFeed` (`src/client/api.ts`). See `docs/17-server-pagination.md` FR-17.9 |
| Orphaned stories/runs after a topic delete | `Store.pruneOrphans()` in `db/store.ts`, called from `pruneAfterCheck` (`checks.ts`) and at startup (`cli.ts`). See `docs/4-cli-server-storage.md` FR-4.8c |
| Wide-window layout / column count | `.shell` (no max-width) and `.day` (`auto-fill, minmax(400px, 1fr)`) in `styles.scss`. Guarded by `tests/e2e/layout.spec.ts`. See `docs/3-ui.md` FR-3.36–3.39 |
| Accessibility (keyboard, ARIA, focus) | `trapTabInDialog` + the global `keydown` handler + `openTopicMenuFor` in `app.tsx`; `role=listbox/option` on the topics list; `:focus-visible` rule in `styles.scss`. Guarded by `tests/e2e/a11y.spec.ts`. See `docs/3-ui.md` FR-3.20–3.24 |
| The privacy disclosure | `privacyNoteJsx` in `app.tsx` (Settings → Privacy), README "Privacy", onboarding welcome step; pinned by a test in `tests/unit/guidance.test.ts`. See `docs/7-api-keys.md` FR-7.13 |
| First-run onboarding | `onboarding`/`onboardingTopics`/`STARTER_TOPICS` in `stores.ts`; `onboardingJsx` + `maybeOpenOnboarding` in `app.tsx`; dismissal in localStorage `news:onboarding-seen`. Key check: `src/ai/verify-key.ts`, injected via `createApp({verifyKey})` (null under `--ai-test`). See `docs/20-onboarding.md` |
| Per-topic guidance (free-text steer) | `guidance` on the topic + `setTopicGuidance` in `store.ts`; `PATCH /api/topics/:id`; `TopicContext` → `buildUserPrompt` in `src/ai/prompt.ts`; menu action `guidance` + `guidanceDialogJsx`/`guidanceTopicId` in the client. See `docs/18-topic-guidance.md` |
| Flag a story off-topic / review mode | `offTopic` on items + `setItemOffTopic`/`offTopicTitlesForTopic` in `store.ts`; `PATCH /api/items/:id`; item context menu (`itemMenuJsx`), `flaggedRowJsx`, `reviewTopicIds`/`recentlyFlagged` in `app.tsx`; prompt via `buildUserPrompt` offTopicTitles. See `docs/15-off-topic-flagging.md` |
| Transient toast | `#toast-slot`/`.toast` + `showToast` in `app.tsx`; `toast` state in `stores.ts`. **Never `window.alert` — a WKWebView no-op** |
| Who is allowed to call the API | `src/origin-guard.ts`, mounted first in `createApp`. Loopback binding is not a fence against the user's *own* browser — Host + Origin are. Absent `Origin` is allowed on purpose (curl / `app.request`); it is not authentication. See `docs/4-cli-server-storage.md` FR-4.5a |
