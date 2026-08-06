# 4 — CLI, Server, and Storage

## CLI

- **FR-4.1** *(Shipped)* `newsmonger` (dev: `npm run dev` → `node --import tsx/esm src/cli.ts`) starts the server and opens the browser. Flags:
  - `--port N` — requested port (default 4187)
  - `--data-dir PATH` — data directory (default `$NEWSMONGER_DATA_DIR` or `~/.newsmonger`)
  - `--provider auto|claude-cli|codex-cli|anthropic|openai|mock` — seed the provider setting (env `NEWSMONGER_PROVIDER`)
  - `--model ID` — seed the model setting (env `NEWSMONGER_MODEL`)
  - `--endpoint URL` — seed the endpoint setting for OpenAI-compatible gateways (env `NEWSMONGER_ENDPOINT`)
  - `--no-open` — don't open the browser
  - `--strict-port` — fail instead of falling back when the port is busy
  - `--ai-test` — force the deterministic mock provider (no API key needed)
  - `--demo` — serve curated fixture stories, for capturing the docs (NEWS-212); implies `--ai-test`
  - `-h`, `--help` / `-v`, `--version` — see FR-4.1a

  Provider/model/endpoint flags **seed** the persisted settings at startup; the UI changes them thereafter. See [6 — AI Providers](6-providers.md) for provider-specific env vars.
- **FR-4.1a** *(Shipped, NEWS-216)* **`--help` and `--version` are answered, not run.** Both print to **stdout** and exit **0**: asked-for help is not an error, `newsmonger --help | less` should show something, and a script checking whether the binary is installed should get a yes.

  They are scanned for **before `parseArgs` runs at all** (`earlyExitFlag`), which matters in three ways. `newsmonger --help` previously exited 1 with `unknown argument: --help` — replying "unknown argument" to someone asking *what the arguments are* is exactly backwards, and after `npm install -g newsmonger` it is close to the first thing anyone types. Answering early also means a bad flag or a bad `NEWSMONGER_PROVIDER` in the environment (parsed while building the defaults) can't stop help from printing. And it returns before the `Store` is constructed, so neither flag creates a data directory or starts a server.

  The scan skips the value of a value-taking flag, so `--model -v` seeds a (silly) model rather than printing the version and never starting.

  The help text and the one-line usage both live in `src/config.ts` and interpolate `PROVIDER_NAMES` (NEWS-204) — a hardcoded list had already drifted twice.
- **FR-4.1b** *(Shipped, NEWS-216)* **`npm install -g newsmonger` then `newsmonger` is the supported way to run it**, and is what the README leads with. That path is a different artifact from the source tree and can break while the whole suite is green (the same property the Tauri bundle has, FR-5.3), so it is checked as a package: `prepublishOnly` builds **both** the server bundle and the client assets, `files` is `dist` minus sourcemaps at every depth, and `bin.newsmonger` points inside `files` (`tests/unit/npm-package.test.ts`, NEWS-204). tsup writes the `#!/usr/bin/env node` banner; `engines` is `>=22.5` for `node:sqlite`.

  The server finds its client assets **relative to its own module**, not the cwd (`clientDir()` in `src/server.ts`), which is what makes an install work from anywhere. Verified end to end for NEWS-216 by packing the tarball, installing it to a throwaway `--prefix`, and driving the result in a browser — see [manual-test-plan.md](manual-test-plan.md).

  The README is written for people **using** Newsmonger; everything about working *on* it moved to [CONTRIBUTING.md](../CONTRIBUTING.md). The quick start used to be `npm install && npm run dev`, which silently assumed a clone the reader had never been told to make.
- **FR-4.2** *(Shipped)* Unknown flags or bad values print the usage line **to stderr** and exit non-zero.
- **FR-4.3** *(Shipped)* The server prints `newsmonger running at http://127.0.0.1:<port>` on stdout when ready — the Tauri shell watches for this exact `running at ` marker (KEEP IN SYNC with `src-tauri/src/lib.rs`).
- **FR-4.4** *(Shipped)* SIGINT/SIGTERM stop the scheduler and server cleanly.
- **FR-4.4a** *(Shipped, NEWS-238)* **`NEWSMONGER_SCHEDULER_TICK_MS` sets how often the scheduler sweeps** (default 60 000; anything unparseable or non-positive falls back to it rather than throwing, since a bad value in the environment should not leave an app that starts and then never checks anything). It changes only *how often due-ness is reconsidered* — the check **interval** is a user setting ([9 — Scheduling](9-scheduling.md)), and a topic that is not due is not checked however often the sweep runs.

  It exists for the **E2E suite**, which sets it beyond the length of a run. Every spec shares one long-lived server, and a sweep there is an actor no test asked for: it checks any topic that has never been checked — most of what a spec creates — at a phase unrelated to the test in progress, writing stories, runs and failures into the state those tests assert on. Two failures have been traced to exactly that, one of them a test that says in its own comment that a new check is "the one thing that legitimately brings this banner back" and can only avoid *clicking* one. Nothing is given up by switching it off: no spec asserts on a scheduled check, so the sweeps were never coverage — `tests/unit/scheduler.test.ts` covers the scheduler with the clock in hand.

## Server

- **FR-4.5** *(Shipped)* Hono + `@hono/node-server`, bound to 127.0.0.1 only. Default port 4187 with fallback across the next 20 ports unless `--strict-port`.
- **FR-4.5a** *(Shipped)* Requests that a page on another origin could have made are rejected with 403 (`src/origin-guard.ts`, applied to *every* route — page, static assets and API alike, ahead of any handler that reads a body or touches state).

  Loopback binding keeps other machines out; it does nothing about the user's own browser. Any site they visit can issue requests to `http://127.0.0.1:4187`, and while it can't read the responses without CORS, `DELETE /api/topics/:id` and `POST /api/check` (which spends API credit) take effect regardless of whether anyone reads the reply. Two checks close that:

  - the **`Host`** must name this machine — `localhost`, a `.localhost` name (RFC 6761 reserves that TLD for loopback, and it's what Tauri's webview uses on Windows/Linux), `127.0.0.1`, or `::1`. This is what stops **DNS rebinding**, where an attacker-controlled name resolves to loopback and the browser therefore treats the app as same-origin — the case where reads *do* get through.
  - the **`Origin`**, when present, must be one of those same hosts or a `tauri:` webview origin. A literal `null` (sandboxed iframe, `data:` document) is rejected: it is never the app's own page.

  An **absent** `Origin` is allowed — no browser can omit it on a cross-origin request, so absence means a non-browser caller (curl, the test harness). This is deliberately **not authentication**: a local process can still call the API, but it could equally read `data.json` directly, so the guard's scope is the browser, not the machine.
- **FR-4.6** *(Shipped)* API surface: `GET /api/state`, `GET /api/providers`, `POST /api/topics`, `PATCH|DELETE /api/topics/:id`, `PATCH /api/settings` (interval + provider/model/endpoint), `POST /api/check`, `POST /api/open-external`, `GET /healthz`. Request bodies are zod-validated; invalid input → 400, unknown ids → 404, duplicate topics → 409.
- **FR-4.7** *(Shipped)* Static client assets are served from `/static/*` (flat directory; path traversal rejected). The page shell is server-rendered kerfjs JSX.

## Storage

- **FR-4.8** *(Shipped, NEWS-94)* All data lives in a **SQLite database**, `<data-dir>/newsmonger.db`: topics, items, settings, and the last 200 check runs. Writes are per-row — toggling one bookmark writes that row, where the previous JSON file re-serialized every topic, story and run on every mutation. Uses the built-in `node:sqlite`, so there is no native dependency and nothing extra to stage into the Tauri sidecar; it needs **Node 22.5+**, which is now the engine floor.

  Rows are still **validated, not asserted** — every read goes through the same zod schemas the JSON file used, so the trust boundary didn't move, it just applies per row. Settings are one JSON row rather than columns, because `SettingsSchema` defaults every field and that makes adding a setting a zero-migration change.

  Search stays `LIKE '%q%'` rather than FTS5. FTS matches tokens and prefixes, so it would stop matching mid-word — and a filter that narrows as you type is exactly where someone types the middle of a word. Adopting FTS is a user-visible change to what search finds, not a free win, so it is a separate decision.

- **FR-4.8a** *(Shipped, NEWS-94)* A legacy `<data-dir>/data.json` is **imported once** on first open, then renamed to `data.json.imported-<ts>`. The import parses with the same `DataFileSchema`, so every migration that schema performs still happens. It runs only when the database has neither topics nor settings, so it can never fire twice or overwrite live data — and the file is renamed rather than deleted, since it is the only copy of that data until someone is satisfied the import worked.

### Feed search stays substring, not FTS5 (NEWS-102)

**Decision: keep `LIKE '%q%'`.** No code change; recorded here so the omission is a decision rather than an oversight, since NEWS-94 originally named FTS5 as a benefit.

**What FTS5 would cost.** It matches *tokens and prefixes*, so `eserv` would stop finding "Federal Reserve" and `ommittee` would stop finding "The committee held". A filter that narrows as you type is precisely where someone types the middle of a word, so that is a real regression in what the box finds — not a technicality. Two tests in `tests/unit/sqlite-store.test.ts` pin mid-word matching so this can't be reversed by accident.

**What it would buy: measured, not assumed.** `LIKE '%q%'` can't use an index, so it scales linearly — about 1 µs per stored story on this machine:

| Stories | Search |
|---|---|
| 15,000 | 18 ms |
| 50,000 | 57 ms |
| 100,000 | 97 ms |
| 250,000 | 223 ms |

15,000 is roughly what a year of 20 topics at a couple of stories a day produces — the realistic ceiling under the default 365-day retention window (FR-4.11). At 18 ms, behind the existing search debounce, it is imperceptible. Reaching the 100 ms mark needs ~275 new stories a day sustained for a year, which is an order of magnitude beyond what checks actually return.

**Revisit when** a real store passes ~100k stories — that is where the linear scan starts being felt rather than merely being theoretically wrong. Until then the honest trade is to keep a search that finds what people type.

- **FR-4.8c** *(Shipped, NEWS-105)* **An orphan sweep collects what the race leaves behind.** `deleteTopic` cascades at deletion time, but an in-flight check can land a story, or a queued check can *start*, after that — so `Store.pruneOrphans()` deletes items and runs whose `topic_id` no longer resolves. It runs after every check (the moment right after the write that can create an orphan, so the window is as short as possible) and at startup (to collect anything a killed process never swept).

  Deliberately **not** solved at the writers: checking the topic exists before every insert costs a query on the hot path and still loses the race, since the topic can go between the check and the insert.

  The sweep ignores the `saved` / `offTopic` exemptions that `pruneOldItems` honours. Those mean "the user wants this kept", but there is no topic left to keep it under — and a flagged orphan would go on feeding the negative-example list for a topic that no longer exists.

- **FR-4.8b** *(Shipped, NEWS-94)* **No foreign keys on `topic_id`.** `ON DELETE CASCADE` would make `deleteTopic` a single statement, but it would also reject a *write* for a topic deleted mid-check — a race the app has tolerated since `markTopicChecked` was written. A constraint would convert a harmless no-op into a thrown error mid-sweep. `deleteTopic` cascades explicitly, in a transaction.
- **FR-4.9** *(Shipped)* A database that is **genuinely unreadable as a file** is backed up (`newsmonger.db.corrupt-<ts>`, along with its `-wal`/`-shm` siblings, which would otherwise be replayed into the replacement) and the app starts fresh rather than crashing. "Unreadable" is a narrow, explicit list — `file is not a database`, `database disk image is malformed`, `file is encrypted` — and everything else is FR-4.13's hard stop, because the direction that keeps data is the one to fail towards. Unreadable **settings** alone fall back to defaults *without* touching topics and stories — that separation is much of the point of leaving one file behind. Schema *evolution* must not trigger this: removed keys are stripped by zod, and a stored `provider` that no longer exists degrades to `auto` (`.catch('auto')`), so retiring a provider never wipes a user's topics.
- **FR-4.10** *(Shipped)* Tests never touch `~/.newsmonger` — unit tests and E2E use temp dirs.

- **FR-4.13** *(Shipped, NEWS-336)* **A schema error is not corruption, and is answered by refusing to start.** If `openDb` fails for any reason outside FR-4.9's list, the app stops with a message naming the file and the error, and **leaves the database exactly where it is**.

  This is the lesson of a real incident. A migration bug (FR-4.14) made a healthy database throw `duplicate column name: thread_id`; the store read any throw as corruption, renamed 20 topics and 51 stories aside, and opened an empty app. `PRAGMA integrity_check` on that file returned `ok` — nothing was ever wrong with it. The response threw away a working install to recover from a bug in our own code, and the only notice was a `console.error` the desktop shell never surfaces.

  A stopped app is recoverable: the data is still there, and someone can ask for help or wait for a fix. An empty app is the one outcome that both looks like total loss and invites the user to start typing new data over the top of the old.

- **FR-4.14** *(Shipped, NEWS-335)* **Migrations and the version stamp are one transaction.** The whole schema step — `TABLES`, every migration, the indexes, and the `PRAGMA user_version` bump — runs inside a single transaction, so a database is either fully migrated *and* stamped, or untouched.

  Each statement used to autocommit separately, with the stamp last. Any failure after the final `ALTER` left a fully-migrated database claiming an old version, and that state is not transient: **every** subsequent open re-applied an already-applied migration and threw. One bad start made a file permanently unopenable.

- **FR-4.15** *(Shipped, NEWS-335)* **Every migration is safe to run twice.** Column additions go through a helper that checks `PRAGMA table_info` first, so a database whose schema is ahead of its own `user_version` heals on the next open instead of needing hand repair with the sqlite CLI.

  A migration that *backfills* the column it adds runs that backfill **only when it did the adding**. Re-running NEWS-280's `UPDATE items SET thread_id = id` on a database that has already grouped its stories would flatten every thread to a thread of one — healing must not cost data to do it.

- **FR-4.17** *(Shipped, NEWS-340)* **A quarantine is recorded where the user can see it.** When FR-4.9 sets a database aside, `Store` writes a `quarantine` row to `meta` — the backup path and an ISO timestamp — which rides along on `/api/state` and raises a banner: what happened, that **nothing was deleted**, and where the old database is. Dismissing it (`POST /api/quarantine/dismiss`) deletes the row, so it cannot return on the next poll or the next launch, and never touches the backup file: dismissing says "I have read this", not "delete that copy".

  In `meta` rather than in memory, because the launch that loses the data is rarely the launch where anyone notices. Read uncached on every request — it is written once at startup and read by a 4-second poll, so a cache would buy nothing and would need invalidating by the dismissal.

  A malformed row reads as absent and is cleared. This row is the thing that reports a storage problem; it must not become a second storage problem.

  The notice names the file; [33 — Getting a Set-Aside Database Back](33-recovery.md) is how to act on it.

  Until this existed the only notice was a `console.error`, on a stream the desktop app does not show ([FR-32.1](32-startup-failure.md) surfaces that stream only when the server dies *before* readiness, which a quarantine specifically does not). The user's entire account of what had happened was an empty topic list — indistinguishable from total loss, and an invitation to start deleting things.

- **FR-4.18** *(Shipped, NEWS-340)* **A quarantine still starts the app, rather than stopping it like FR-4.13 does.** The two look similar and are not.

  FR-4.13 stops because the database is **fine** and our code failed on it: every row is intact, so the recoverable move is to change nothing and let a fix arrive. A quarantine happens when the file is genuinely unreadable — nothing in the app can repair it, no future start will do better on its own, and refusing to open would leave someone with an app that never launches again and no way to add the topics they would rather start over with.

  What made starting fresh *wrong* before was not the starting fresh. It was doing it silently. With FR-4.17's banner the outcome is the same and the user is not misled, which is the whole of the difference.

- **FR-4.16** *(Shipped, NEWS-337)* **A rescue copy never unlinks a write-ahead log unread.** `backupUnreadableDb` copies any `-wal`/`-shm` beside the database *before* it tries anything else, then checkpoints the database if it can open it, then copies the main file.

  The order is the substance. In WAL mode a committed transaction lives in `-wal` until a checkpoint folds it in, so copying the main file alone leaves the rescue copy older than what was actually committed — and closing a SQLite handle removes the log, including on a failed open. Copying first is what keeps the set restorable. This is best-effort by nature: `openDb`'s own failure path closes its handle before the backup runs, so a log often will not survive to reach this function. What it guarantees is that this function never destroys one.

- **FR-4.12** *(Shipped, NEWS-164)* The product was renamed **News → Newsmonger**, and the rename went all the way through rather than stopping at the wordmark. A repo carrying two names for one product is a repo where every later reader has to work out which one is current.

  Moved: the npm package and `bin` name, the Tauri `productName`, bundle `identifier` and window title, the Rust crate (`newsmonger` / `newsmonger_lib`), the sidecar binary (`newsmonger-node`), the keychain **service name**, the data directory (`~/.newsmonger`), the database file (`newsmonger.db`), the readiness line, every `NEWSMONGER_*` environment variable, export filenames, the diagnostics header, and the temp-directory prefixes.

  Deliberately **not** moved: `NewsItem`, `NewsProvider`, `NewsService`, `NEWS_JSON_SCHEMA` and the like. Those name *news* — the thing the app deals in — not the product, and renaming them would have been a category error. The same goes for prose like "News Checks and Deduplication" and "Review Flagged News Items". The `NEWS-nn` ticket prefix is Hot Sheet's project key and is untouched.

  **This is a breaking change for anyone with an existing local install** — a new empty data directory, and API keys must be re-entered because the keychain service name moved. Acceptable only because the app is pre-launch with no users; had it shipped, the data dir would have needed a migration and the keychain a read-old-write-new fallback.
- **FR-4.11** *(Shipped)* **Story retention** (NEWS-87). Stories older than `settings.itemRetentionDays` are dropped; the default is **365 days** and **0 means keep forever** (the pre-NEWS-87 behaviour). `runs` has been capped at 200 all along and images are pruned by mark-and-sweep — `items` was the one collection with no ceiling at all, and every mutation rewrites the whole file, so unbounded growth was a write-cost problem as much as a disk one.

  Two exemptions, both deliberate: **bookmarked** stories, which the user marked as worth keeping (retention is about the pile that accumulates on its own, not the things they chose), and **off-topic flagged** ones, whose titles feed the prompt's negative-example list — pruning those would quietly un-teach the model what the user meant by a topic.

  Pruning runs at **startup** (an install closed for months comes back trimmed) and **after each successful check** (an always-on install would otherwise never reclaim anything). It reclaims the dropped stories' cached images in the same pass, and is best-effort: a failure is logged and never turns a successful check into a failed one. A run that drops nothing does not rewrite the file.

  The window is a boundary-inclusive `>=`: a story found exactly `days` ago is inside the window.

  > The storage engine moved to SQLite in **NEWS-94** (FR-4.8). Retention still matters — it bounds what the database holds — but the whole-file rewrite it was mitigating is gone.

See also: [5 — Desktop App](5-desktop-app.md).
