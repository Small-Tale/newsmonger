# 27 — Where Data Is Stored

**Status: shipped.** The fork below was decided in favour of **Design B** — local live data, snapshots to a chosen folder — with the added requirement that the snapshot carry the configuration (topics, settings) but never API keys. The backup engine landed in NEWS-192 (FR-27.6–27.9) and the offer in NEWS-230 (FR-27.2–27.5).

The goal, in the requester's words: *"so users can select, for example, an iCloud Drive or Google Drive location to automatically backup their data."*

## What exists today

- **FR-27.1** *(Shipped)* The data directory is chosen at startup: `--data-dir PATH`, then `NEWSMONGER_DATA_DIR`, then `~/.newsmonger` (`defaultDataDir()` in `src/config.ts`, FR-4.1). It cannot be changed while the app is running.
- It holds `newsmonger.db` — SQLite in **WAL** mode, so also `newsmonger.db-wal` and `newsmonger.db-shm` while open — and an `images/` cache.
- **API keys are not in it.** They live in the OS keychain (FR-7.x), so no storage-location choice moves or exposes them. Worth stating because "config files" in the ticket title suggests otherwise.

## The fork — live data vs backups

The requested mechanism is "point the data directory at a cloud folder". That achieves backup, and it also puts a live SQLite database inside a directory a sync daemon rewrites underneath it.

**This is a known way to corrupt SQLite, not a theoretical risk.** WAL mode maintains an invariant *across three files* — the database, `-wal` and `-shm`. A sync client uploads and downloads them independently, at moments it chooses, and may restore one without the others. Two machines syncing the same folder can also both open the database with no shared lock between them. SQLite's own documentation advises against putting a live database on a synchronised or network volume for exactly this reason.

This project already treats corruption as a real event: `backupUnreadableDb` renames a bad database to `newsmonger.db.corrupt-<ts>` (with its `-wal`/`-shm` siblings, precisely so a stale WAL cannot be replayed into the replacement) and starts fresh (FR-4.9). That path exists because corruption happens. Running from a sync folder would make it fire far more often, and every firing is data loss — which is the opposite of what the person asking for backups wants.

So there are two designs, and they are not variations of one thing:

### Design A — relocate the live data directory

The literal request. A setting names a directory; the app moves `newsmonger.db` and `images/` there and runs from it.

- Gets backup as a side effect of whatever the folder syncs.
- **Carries the corruption risk above**, most sharply for the user who does exactly what the feature suggests.
- Costs real re-plumbing: `Store` takes its directory in the constructor and `createApp` injects one instance, so changing it at runtime means closing the database, moving three-to-many files, constructing a new `Store`, and rewiring `CheckRunner`, `DiscoveryService` and the server middleware — or restarting the server process.

### Design B — keep the live data local, back it up to the chosen folder

A setting names a **backup** directory. The app keeps running from `~/.newsmonger` and writes a snapshot there on a schedule.

- Delivers the stated goal — automatic backup to iCloud/Drive — without a live database on synced storage.
- The snapshot can be a plain, already-implemented artifact: `toJson` already serialises topics, items and settings for `/api/export.json` (FR-21.4). Writing that to a directory is close to free, is a single file (nothing for a sync client to tear), and is human-readable.
- Restore becomes an explicit action rather than an implicit one, which is arguably better: the user chooses when to overwrite.
- Does **not** satisfy someone who wants two machines sharing one live database. That is a sync feature, not a backup feature, and it is a much larger piece of work.

**Decided: B.** A remains available to anyone who wants it — `--data-dir` on a synced path has always been possible — but it is not something the UI offers, because the UI offering it would read as an endorsement.

## What is built (FR-27.6–27.9)

- **FR-27.6** *(Shipped)* A **`backupDir`** setting names a folder; `''` (the default) means backups are off. Settings → Data.
- **FR-27.7** *(Shipped)* The snapshot is a single file, **`newsmonger-backup.json`**, holding **topics, stories, settings and run history**. It is written to a temp file and renamed into place, so a sync client watching the folder never uploads a half-written one.
  - **The format is `DataFileSchema`** — the very shape the legacy `data.json` importer reads (FR-4.8a). So **restore needs no restore code**: drop the file into an empty data directory as `data.json` and start the app. A bespoke format would have meant a bespoke restore path to write, maintain and test.
  - **API keys are never in it.** They live in the OS keychain, not in `Settings` (FR-7.x), so this is structural rather than a filter that could be forgotten. A unit test and an E2E test both assert on the serialised bytes anyway, because a future settings field could change that quietly.
- **FR-27.8** *(Shipped)* Backups are written **at startup and after a successful check**, at most **once an hour**. The throttle reads the existing file's mtime, not just an in-memory timestamp, so an app quit and reopened several times an hour does not rewrite the snapshot on each launch.
- **FR-27.9** *(Shipped)* **"Back up now"** in Settings → Data writes immediately, ignoring the throttle — "nothing happened, try again in an hour" is not an acceptable answer to a button press. Disabled until a folder is named.
- A backup that fails is **reported and swallowed**: it is housekeeping, exactly like pruning, and must never turn a successful check into a failed one. The destination is a folder that can be unmounted, full, or renamed by a sync client at any moment.
- **The path is typed, not picked.** See open decision 4 below — that has not changed, and is the one rough edge in the shipped feature.

## The offer (NEWS-230)

- **FR-27.2** *(Shipped)* After the user's **third topic**, a dialog offers the backup folder with the detected locations one click away. Three, not one: someone with a single topic is still deciding whether they want the app at all, and a dialog about protecting data they barely have is noise. By the third, losing it would matter.
- **FR-27.3** *(Shipped)* The dialog **does not dismiss on an outside click**, and Escape does not close it either. Every other dialog in the app does both. This one must not: a stray click is not an answer, and the two real answers differ in whether it ever asks again. There is no ✕ for the same reason — the buttons *are* the exits.
- **FR-27.4** *(Shipped)* Three exits: **"Keep backups here"** (saves and immediately writes a first snapshot), **"Not now"** (re-asks after **one day**), and **"Don't ask again"** (permanent). Both dismissals are **settings**, not `localStorage` — "stop asking me" is a promise, and one kept only per-browser is not kept. Saving with an empty folder is refused rather than treated as an answer: it would close the dialog having changed nothing and, since the offer only fires once, quietly never ask again.
- **FR-27.5** *(Shipped)* Suggested locations are **OS-appropriate and probed, never assumed** (`src/backup-locations.ts`) — iCloud Drive, Google Drive, OneDrive and Dropbox on macOS; OneDrive, Google Drive and Dropbox on Windows; the third-party clients on Linux. A machine with none still gets the dialog, with a note and an empty field. Offering a path that does not exist is worse than offering none: it looks authoritative and then fails at the first write.
  - macOS needs a **prefix scan**, not a path list: modern mounts live under `~/Library/CloudStorage` with the account in the folder name (`GoogleDrive-someone@example.com`), so there is no fixed path to test. Several accounts of one product each get an entry.
  - The probe is a **separate route** (`GET /api/backup/locations`), not a field on `/api/state`. It touches the filesystem, and `/api/state` is polled every 4 seconds — probing directories fifteen times a minute to answer a question asked once is the wrong shape.
- Clicking a suggestion **fills the field rather than saving**: the path is a guess about where the user keeps things, and committing on one click would turn a misread suggestion into a decision.

The copy is **"keep a backup here"**, never "move your data here" — the second is a promise this design deliberately does not make, and an E2E test asserts the dialog never says it.

## Open decisions

1. ~~**A or B**~~ — decided: **B**.
2. ~~**If B:** what cadence?~~ — decided: event-driven (startup + after a successful check) with a one-hour floor, which is "on change with a floor".
3. **If A:** does choosing a new location *move* the existing data or start empty there? Moving is what a user expects; it is also the step where a failure loses everything, so it needs to copy-verify-then-delete rather than rename. *(Moot unless A is ever built.)*
4. **Folder picking.** *(Still open — both shipped surfaces take a typed path, softened by the probed suggestions in FR-27.5. Tracked as NEWS-233.)* The desktop shell has no `tauri-plugin-dialog` today, so a native picker means a new plugin plus a capability entry. **The browser build cannot pick a directory at all** — the File System Access API yields a sandboxed handle, not a path the Node server can open — so the browser path is a typed-in path with validation, whatever else is decided.

## Note for anyone writing tests

The offer fires on the third topic, and most E2E specs create three or more — so `resetTopics` in `tests/e2e/fixtures.ts` sets `backupPromptNever` for every spec except `backup-prompt.spec.ts`, which clears it and drives the real thing. That suppression lives in the **harness**; the app has no test-only branch for it.

See also: [4 — CLI, Server, and Storage](4-cli-server-storage.md) (FR-4.1 data-dir resolution, FR-4.9 corrupt-database recovery), [21 — Export and Feed](21-export-and-feed.md) (the JSON export a backup would reuse), [7 — API Keys](7-api-keys.md) (why keys are not affected).
