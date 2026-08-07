// Must precede the `node:sqlite` load below — see the note on that line.
import './warnings.js';

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';

/**
 * `node:sqlite` is loaded with `require`, not a static `import`, and that is
 * load-bearing rather than a style choice.
 *
 * ESM **links** its whole graph before evaluating any module body, and a
 * builtin emits its `ExperimentalWarning` at link time — so a static import
 * would fire the warning before `./warnings.js` had run, no matter how the
 * imports were ordered. `require` defers the load to *this* line, which
 * executes after the filter is installed. The type comes from a type-only
 * import, which TypeScript erases entirely and which therefore never loads it.
 */
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: typeof DatabaseSyncType;
};

/**
 * Schema and connection handling for the SQLite store (NEWS-94).
 *
 * `node:sqlite` is built into Node — no native module to compile and nothing
 * new to stage into the Tauri sidecar, which is the whole reason it was chosen
 * over `better-sqlite3`. It requires **Node 22.5+** and still prints an
 * `ExperimentalWarning`; `src/cli.ts` silences that one warning and nothing else.
 */

/** Bumped when `TABLES` changes in a way an existing database must be migrated for. */
export const SCHEMA_VERSION = 7;

/**
 * Add a column only if it isn't already there, reporting whether it did.
 *
 * Every migration below is an additive `ALTER TABLE`, and a bare `ADD COLUMN`
 * against a column that already exists throws `duplicate column name` — which
 * `Store` used to read as a corrupt file (NEWS-335). Checking first makes each
 * migration **idempotent**, so a database whose schema is further along than its
 * `user_version` claims heals on the next open instead of being unopenable
 * forever. That is not hypothetical: one such database happened, and the only
 * way back was hand-repair with the sqlite CLI.
 *
 * The return value matters as much as the skip. A migration that *backfills*
 * the column it adds must run that backfill **only when it did the adding** —
 * re-running NEWS-280's `UPDATE items SET thread_id = id` on a database that
 * has already grouped its stories would silently reset every thread to a thread
 * of one. Healing must not cost data to do it.
 */
function addColumn(db: DatabaseSyncType, table: string, column: string, ddl: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: unknown }[];
  if (columns.some((c) => c.name === column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  return true;
}

/**
 * Upgrades for a database created by an older `SCHEMA_VERSION`.
 *
 * Indexed by the version being upgraded *from*: `MIGRATIONS[1]` takes a v1
 * database to v2. A brand-new database gets the current `TABLES` directly and
 * skips all of these, which is why `TABLES` below must always describe the
 * latest shape rather than the original one plus a trail of migrations.
 *
 * **Every migration must be safe to run twice** — see `addColumn`.
 */
const MIGRATIONS: Partial<Record<number, (db: DatabaseSyncType) => void>> = {
  // v1 → v2: topic categories (NEWS-97). Additive and nullable, so nothing needs
  // backfilling — an unclassified topic is exactly what `null` means here.
  1: (db) => {
    addColumn(db, 'topics', 'category', `category TEXT`);
    addColumn(db, 'topics', 'subcategory', `subcategory TEXT`);
    addColumn(db, 'topics', 'category_source', `category_source TEXT NOT NULL DEFAULT 'auto'`);
  },
  // v2 → v3: per-topic failure cooldown (NEWS-110). Additive and defaulted, so
  // an existing topic starts with a clean slate, which is what it has.
  2: (db) => {
    addColumn(db, 'topics', 'consecutive_failures', `consecutive_failures INTEGER NOT NULL DEFAULT 0`);
    addColumn(db, 'topics', 'retry_after', `retry_after TEXT`);
  },
  // v3 → v4: the effort a check ran at (NEWS-226). Additive and nullable —
  // and nullable is the point: a run recorded before this column existed truly
  // has no level, and must not read back as "ran at the default", which would
  // quietly poison the comparison this column exists to make possible.
  3: (db) => {
    addColumn(db, 'runs', 'effort', `effort TEXT`);
  },
  // v4 → v5: story threads (NEWS-280). Every existing story becomes a thread of
  // one, which is exactly what it was: nothing had been grouped yet. Filling the
  // column with the row's own id rather than leaving it empty means the invariant
  // "a thread id names a story" holds from the first read, and `Store.backfillThreads`
  // can then treat `thread_id = id` as "not yet considered" and group them for real.
  4: (db) => {
    // The backfill is guarded on the add: see `addColumn`. A database that
    // already has this column already has real thread groupings in it, and
    // re-running the backfill would flatten every one of them.
    if (addColumn(db, 'items', 'thread_id', `thread_id TEXT NOT NULL DEFAULT ''`)) {
      db.exec(`UPDATE items SET thread_id = id`);
    }
  },
  // v5 → v6: the scheduling baseline a clear leaves behind (NEWS-291). Additive
  // and nullable, and null is right for every existing topic: none of them has
  // been cleared, so their due-ness still comes from `last_checked_at` alone.
  5: (db) => {
    addColumn(db, 'topics', 'cleared_at', `cleared_at TEXT`);
  },
  // v6 → v7: what the classifier had said before a person overruled it
  // (NEWS-404). Additive and nullable, and nullable is load-bearing: a topic
  // that predates this column has no recorded correction, which is exactly true
  // — backfilling it with the current category would invent agreement that was
  // never observed and poison the only measurement this column exists to make.
  6: (db) => {
    addColumn(db, 'topics', 'auto_category', `auto_category TEXT`);
  },
};

/**
 * Notes on choices that aren't obvious from the DDL:
 *
 * - **Booleans are INTEGER 0/1** — SQLite has no boolean type. Conversion happens
 *   in exactly one place per direction (`rowToX` / the insert binders in
 *   `store.ts`), never at call sites.
 * - **`sources`, `image` and `usage` are JSON columns.** They are opaque blobs to
 *   every query we run; giving them tables would buy nothing and cost a join on
 *   the feed's hot path.
 * - **Settings live as one JSON row in `meta`.** Settings gain fields often (six
 *   in one recent stretch) and `SettingsSchema` already defaults every one of
 *   them, so a JSON blob makes adding a setting a zero-migration change. It is
 *   read and written whole, so there is nothing to gain from columns.
 * - **No foreign keys on `topic_id`.** Tempting, and `ON DELETE CASCADE` would
 *   make `deleteTopic` one statement — but a check can outlive the topic that
 *   started it (see `markTopicChecked`, which has tolerated exactly that since
 *   long before this change). A constraint would convert that race from a
 *   harmless no-op into a thrown error mid-sweep. `deleteTopic` cascades
 *   explicitly instead, in a transaction.
 * - **No `WITHOUT ROWID`**: the implicit rowid is the insertion order that
 *   `listTopics` and `listRuns` return, and `runs` truncation relies on it.
 */
const TABLES = `
CREATE TABLE IF NOT EXISTS topics (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  paused             INTEGER NOT NULL DEFAULT 0,
  high_priority      INTEGER NOT NULL DEFAULT 0,
  guidance           TEXT NOT NULL DEFAULT '',
  created_at         TEXT NOT NULL,
  last_checked_at    TEXT,
  covered_through_at TEXT,
  category           TEXT,
  subcategory        TEXT,
  category_source    TEXT NOT NULL DEFAULT 'auto',
  auto_category      TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  retry_after        TEXT,
  cleared_at         TEXT
);

CREATE TABLE IF NOT EXISTS items (
  id         TEXT PRIMARY KEY,
  topic_id   TEXT NOT NULL,
  title      TEXT NOT NULL,
  summary    TEXT NOT NULL,
  sources    TEXT NOT NULL,
  image      TEXT,
  dedupe_key TEXT NOT NULL,
  thread_id  TEXT NOT NULL DEFAULT '',
  found_at   TEXT NOT NULL,
  saved      INTEGER NOT NULL DEFAULT 0,
  off_topic  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS runs (
  id          TEXT PRIMARY KEY,
  topic_id    TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  status      TEXT NOT NULL,
  new_items   INTEGER NOT NULL DEFAULT 0,
  error       TEXT,
  provider    TEXT,
  model       TEXT,
  usage       TEXT,
  effort      TEXT
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/**
 * Indexes, created **after** the migrations rather than with the tables.
 *
 * An index names columns, so an index on a column a migration is about to add
 * cannot be created before that migration runs — and `TABLES` runs first,
 * because a migration may need a table that a fresh database has just been
 * given. Creating `items_topic_thread` alongside the tables made every
 * pre-NEWS-280 database fail to open with `no such column: thread_id`, which
 * `Store` correctly reads as corruption and answers by starting fresh: a schema
 * addition that silently discarded the user's stories. Ordering these last is
 * the fix, and it holds for every future column too.
 */
const INDEXES = `
-- Backstop for the case-insensitive uniqueness addTopic enforces in code. The
-- code check stays, because it produces the message the API surfaces; this
-- makes a duplicate impossible even if a future writer forgets to check.
CREATE UNIQUE INDEX IF NOT EXISTS topics_name_nocase ON topics(name COLLATE NOCASE);

-- The feed's sort order, so a page is a range scan rather than a sort of every
-- row the filters left behind.
CREATE INDEX IF NOT EXISTS items_feed ON items(found_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS items_topic ON items(topic_id);
-- Dedupe lookups and the flagged-count aggregate are both per-topic.
CREATE INDEX IF NOT EXISTS items_topic_dedupe ON items(topic_id, dedupe_key);
-- Reading a whole thread back (NEWS-280) is per-topic too: a thread never spans
-- topics, and the topic column keeps the scan off other topics' rows.
CREATE INDEX IF NOT EXISTS items_topic_thread ON items(topic_id, thread_id);
CREATE INDEX IF NOT EXISTS items_off_topic ON items(off_topic) WHERE off_topic = 1;

CREATE INDEX IF NOT EXISTS runs_started ON runs(started_at);
`;

/**
 * Open (creating if needed) the database at `file` and bring its schema up to date.
 *
 * Throws if the file exists but isn't a usable database — `Store` catches that
 * and takes the back-up-and-start-fresh path, the same contract the JSON store
 * had for an unparseable `data.json`.
 */
export function openDb(file: string): DatabaseSyncType {
  const db = new DatabaseSync(file);
  try {
    // Per-connection, not stored in the file: has to be set on every open.
    // WAL lets a read run while a write is in flight and, more to the point
    // here, stops every commit from rewriting the whole database header page.
    db.exec('PRAGMA journal_mode = WAL');
    // Read *before* `TABLES` runs: a brand-new file reports 0, and `TABLES`
    // already describes the latest shape, so it needs no migrations. Anything
    // >0 was created by an older build and does.
    const from = Number((db.prepare('PRAGMA user_version').get() as { user_version: unknown }).user_version ?? 0);
    // One transaction for the whole schema step, version stamp included
    // (NEWS-335). SQLite's DDL is transactional and so is the `user_version`
    // header write, so a database is either fully migrated *and* stamped or
    // untouched — never the state that caused this ticket, where every column
    // had been added but the stamp still read v4.
    //
    // Each `db.exec` autocommits on its own otherwise, and the stamp is the
    // last write of the sequence: any failure or unclean exit after the final
    // `ALTER` stranded the file one version behind its own schema, and *every*
    // subsequent open then re-applied an already-applied migration. That is not
    // a transient failure — it is permanent, and it presents as corruption.
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(TABLES);
      for (let v = from; v > 0 && v < SCHEMA_VERSION; v++) {
        const migrate = MIGRATIONS[v];
        if (migrate === undefined) throw new Error(`no migration from schema v${String(v)}`);
        migrate(db);
      }
      // Last: see the note on `INDEXES`.
      db.exec(INDEXES);
      db.exec(`PRAGMA user_version = ${String(SCHEMA_VERSION)}`);
      db.exec('COMMIT');
    } catch (err) {
      // Best-effort: a failure that already aborted the transaction leaves
      // nothing to roll back, and that rollback's own error must not replace
      // the real one on its way out.
      try {
        db.exec('ROLLBACK');
      } catch {
        /* already rolled back */
      }
      throw err;
    }
    // A statement that touches real data: `DatabaseSync` opens lazily enough
    // that a corrupt file can survive everything above and only fail on first
    // use, which would move the failure somewhere with no recovery path.
    db.prepare('SELECT count(*) AS c FROM topics').get();
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}

/**
 * Signatures SQLite uses for a file that is not a usable database at all.
 *
 * Deliberately a short list of *file* problems (NEWS-336). Everything else a
 * failed open can throw — a duplicate column, a missing column, a missing
 * migration — is our own schema code failing on a database that is perfectly
 * readable, and must never be answered by setting the user's data
 * aside. Matching on the narrow list means an error we have not seen before is
 * treated as *not* corruption, which is the direction that keeps data.
 */
const CORRUPT_SIGNATURES = [
  'file is not a database',
  'database disk image is malformed',
  'file is encrypted',
];
// `unable to open database file` is deliberately absent: that is a path or
// permissions problem, and a file we cannot open is also one we cannot copy —
// "back it up and start fresh" would fail on the backup and bury the real
// cause. Refusing to start says what actually went wrong.

/**
 * Is this a file we genuinely cannot read, as opposed to one our own schema
 * work choked on? Only the former justifies `backupUnreadableDb`.
 */
export function isUnreadableDbError(err: unknown): boolean {
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return CORRUPT_SIGNATURES.some((signature) => message.includes(signature));
}

/**
 * Move a database we can't read out of the way, so the caller can start fresh.
 * Returns the backup path. The `-wal`/`-shm` siblings go too: leaving them
 * beside a new database of the same name is how you corrupt the *replacement*.
 *
 * **The WAL is folded in or carried along, never just deleted** (NEWS-337). The
 * database runs in WAL mode, so a committed transaction lives in `-wal` until a
 * checkpoint writes it into the main file — which happens on a clean close or
 * around every 1000 pages, and therefore usually *hasn't* at the moment we get
 * here. Copying the main file and unlinking `-wal` discarded whatever had been
 * committed since the last checkpoint, from the backup as well as the original:
 * the rescue copy was silently the older of the two.
 *
 * Worse, it could manufacture the very failure it was reacting to. `openDb`'s
 * `user_version` stamp is the last write of the schema step and so sits at the
 * tail of the WAL — exactly what a WAL-discarding copy dropped while keeping
 * the `ALTER TABLE`s ahead of it, leaving a fully-migrated database claiming an
 * old version. That is the NEWS-335 state, and this function could produce it.
 */
export function backupUnreadableDb(file: string): string {
  const backup = `${file}.corrupt-${String(Date.now())}`;
  // Sidecars first, and the order is the whole trick: closing a `DatabaseSync`
  // handle checkpoints and *removes* the `-wal`, including on the failed open
  // below. Attempting the checkpoint before copying therefore destroys exactly
  // the file this is trying to save, on exactly the databases too broken to
  // checkpoint. Copy them while they are still there.
  for (const suffix of ['-wal', '-shm']) {
    if (fs.existsSync(`${file}${suffix}`)) fs.copyFileSync(`${file}${suffix}`, `${backup}${suffix}`);
  }
  try {
    const db = new DatabaseSync(file);
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally {
      db.close();
    }
  } catch {
    // Genuinely unopenable, so there is no checkpointing it — the sidecar
    // copies above are the fallback, and keeping the three files together
    // leaves the set restorable by anyone with the sqlite CLI.
  }
  // After the checkpoint, so the main file carries everything that was folded in.
  fs.copyFileSync(file, backup);
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(`${file}${suffix}`, { force: true });
  }
  return backup;
}

/** Path of the SQLite database inside a data directory. */
export function dbPath(dataDir: string): string {
  return path.join(dataDir, 'newsmonger.db');
}
