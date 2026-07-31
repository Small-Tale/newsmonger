# 27 — Where Data Is Stored

**Status: the backup half is shipped (NEWS-192); the prompt is design only.** The fork below was decided in favour of **Design B** — local live data, snapshots to a chosen folder — with the added requirement that the snapshot carry the configuration (topics, settings) but never API keys. FR-27.6–27.9 are built; FR-27.2–27.5 (the prompt after the third topic) are not.

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

## The prompt (specified by the requester, mechanism-independent apart from wording)

- **FR-27.2** After the user adds their **third topic**, offer the storage-location setting with sensible defaults pre-filled.
- **FR-27.3** The dialog **does not dismiss on an outside click** — it is a decision, not a notification.
- **FR-27.4** Two explicit exits: **"Not now"**, which re-asks after **one day**, and **"Don't ask again"**, which is permanent.
- **FR-27.5** Suggested locations are **OS-appropriate**: iCloud Drive on macOS, OneDrive on Windows, Google Drive where present. Detected by looking for the directory rather than assumed — offering a path that does not exist is worse than offering none.

The copy for FR-27.2 follows from the decision: it is **"keep a backup here"**, not "move your data here" — the second is a promise this design deliberately does not make.

## Open decisions

1. ~~**A or B**~~ — decided: **B**.
2. ~~**If B:** what cadence?~~ — decided: event-driven (startup + after a successful check) with a one-hour floor, which is "on change with a floor".
3. **If A:** does choosing a new location *move* the existing data or start empty there? Moving is what a user expects; it is also the step where a failure loses everything, so it needs to copy-verify-then-delete rather than rename. *(Moot unless A is ever built.)*
4. **Folder picking.** *(Still open — the shipped feature takes a typed path.)* The desktop shell has no `tauri-plugin-dialog` today, so a native picker means a new plugin plus a capability entry. **The browser build cannot pick a directory at all** — the File System Access API yields a sandboxed handle, not a path the Node server can open — so the browser path is a typed-in path with validation, whatever else is decided.

## Not built yet

The prompt (FR-27.2–27.5) is unimplemented: today the setting is only discoverable by opening Settings → Data, which means most people will never find it. Tracked as its own ticket.

See also: [4 — CLI, Server, and Storage](4-cli-server-storage.md) (FR-4.1 data-dir resolution, FR-4.9 corrupt-database recovery), [21 — Export and Feed](21-export-and-feed.md) (the JSON export a backup would reuse), [7 — API Keys](7-api-keys.md) (why keys are not affected).
