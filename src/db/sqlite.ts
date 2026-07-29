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

/** Bumped when `SCHEMA` changes in a way an existing database must be migrated for. */
export const SCHEMA_VERSION = 3;

/**
 * Upgrades for a database created by an older `SCHEMA_VERSION`.
 *
 * Indexed by the version being upgraded *from*: `MIGRATIONS[1]` takes a v1
 * database to v2. A brand-new database gets the current `SCHEMA` directly and
 * skips all of these, which is why `SCHEMA` below must always describe the
 * latest shape rather than the original one plus a trail of migrations.
 */
const MIGRATIONS: Partial<Record<number, (db: DatabaseSyncType) => void>> = {
  // v1 → v2: topic categories (NEWS-97). Additive and nullable, so nothing needs
  // backfilling — an unclassified topic is exactly what `null` means here.
  1: (db) => {
    db.exec(`ALTER TABLE topics ADD COLUMN category TEXT`);
    db.exec(`ALTER TABLE topics ADD COLUMN subcategory TEXT`);
    db.exec(`ALTER TABLE topics ADD COLUMN category_source TEXT NOT NULL DEFAULT 'auto'`);
  },
  // v2 → v3: per-topic failure cooldown (NEWS-110). Additive and defaulted, so
  // an existing topic starts with a clean slate, which is what it has.
  2: (db) => {
    db.exec(`ALTER TABLE topics ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0`);
    db.exec(`ALTER TABLE topics ADD COLUMN retry_after TEXT`);
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
const SCHEMA = `
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
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  retry_after        TEXT
);

-- Backstop for the case-insensitive uniqueness addTopic enforces in code. The
-- code check stays, because it produces the message the API surfaces; this
-- makes a duplicate impossible even if a future writer forgets to check.
CREATE UNIQUE INDEX IF NOT EXISTS topics_name_nocase ON topics(name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS items (
  id         TEXT PRIMARY KEY,
  topic_id   TEXT NOT NULL,
  title      TEXT NOT NULL,
  summary    TEXT NOT NULL,
  sources    TEXT NOT NULL,
  image      TEXT,
  dedupe_key TEXT NOT NULL,
  found_at   TEXT NOT NULL,
  saved      INTEGER NOT NULL DEFAULT 0,
  off_topic  INTEGER NOT NULL DEFAULT 0
);

-- The feed's sort order, so a page is a range scan rather than a sort of every
-- row the filters left behind.
CREATE INDEX IF NOT EXISTS items_feed ON items(found_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS items_topic ON items(topic_id);
-- Dedupe lookups and the flagged-count aggregate are both per-topic.
CREATE INDEX IF NOT EXISTS items_topic_dedupe ON items(topic_id, dedupe_key);
CREATE INDEX IF NOT EXISTS items_off_topic ON items(off_topic) WHERE off_topic = 1;

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
  usage       TEXT
);

CREATE INDEX IF NOT EXISTS runs_started ON runs(started_at);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
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
    // Read *before* `SCHEMA` runs: a brand-new file reports 0, and `SCHEMA`
    // already describes the latest shape, so it needs no migrations. Anything
    // >0 was created by an older build and does.
    const from = Number((db.prepare('PRAGMA user_version').get() as { user_version: unknown }).user_version ?? 0);
    db.exec(SCHEMA);
    for (let v = from; v > 0 && v < SCHEMA_VERSION; v++) {
      const migrate = MIGRATIONS[v];
      if (migrate === undefined) throw new Error(`no migration from schema v${String(v)}`);
      migrate(db);
    }
    db.exec(`PRAGMA user_version = ${String(SCHEMA_VERSION)}`);
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
 * Move a database we can't read out of the way, so the caller can start fresh.
 * Returns the backup path. The `-wal`/`-shm` siblings go too: leaving them
 * beside a new database of the same name is how you corrupt the *replacement*.
 */
export function backupUnreadableDb(file: string): string {
  const backup = `${file}.corrupt-${String(Date.now())}`;
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
