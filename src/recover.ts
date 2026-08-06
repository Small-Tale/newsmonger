import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildBackup } from './backup.js';
import type { DataFile } from './db/schemas.js';
import { openDb } from './db/sqlite.js';
import { Store } from './db/store.js';

/**
 * Getting back a database that was set aside as unreadable (NEWS-342).
 *
 * [FR-4.9](../docs/4-cli-server-storage.md) renames a database it cannot open to
 * `newsmonger.db.corrupt-<ts>` and starts fresh, and [FR-4.17](../docs/4-cli-server-storage.md)
 * tells the user where it went. This is the answer to the question that follows:
 * *can I have it back?*
 *
 * **Nothing here swaps files.** The live `Store` holds an open connection, and
 * replacing the file under it would be a different and much worse problem than
 * the one being solved. Instead the set-aside file is opened *separately*, read
 * out, and written into the live database through `Store.replaceAll` — the same
 * route [FR-27.10](../docs/27-data-location.md)'s restore takes, for the same
 * reason. No restart, no connection juggling, and one transaction.
 */

/** Files this looks for. Anchored so a name can never carry a path. */
const SET_ASIDE_PATTERN = /^newsmonger\.db\.corrupt-\d+$/;

export interface SetAsideDatabase {
  /**
   * File name, never a path. It is what the client hands back to recover, so
   * keeping it a bare name is what makes that request unable to name anything
   * outside the data directory.
   */
  file: string;
  /** When it was set aside, from the file's mtime. */
  setAsideAt: string;
  sizeBytes: number;
  /** What is inside, or `null` when it still cannot be read. */
  contents: { topics: number; items: number; runs: number } | null;
  /** Why it cannot be read. Present exactly when `contents` is null. */
  error: string | null;
}

/** Is this a name `listSetAside` would have produced? */
export function isSetAsideName(file: string): boolean {
  return SET_ASIDE_PATTERN.test(file);
}

/**
 * Open a set-aside file somewhere harmless and hand it to `read`.
 *
 * Always against a **copy**. `openDb` migrates what it opens, and this is the
 * user's only copy of that data — inspecting it must not be the thing that
 * changes it. The copy is also what makes an *old* quarantine recoverable:
 * NEWS-335 made migrations idempotent and NEWS-336 narrowed what counts as
 * unreadable, so a file set aside by an earlier build may well open cleanly
 * today. That is the case this feature is most useful for.
 */
function withSetAside<T>(dataDir: string, file: string, read: (store: Store) => T): T {
  if (!isSetAsideName(file)) throw new Error(`not a set-aside database: ${file}`);
  const source = path.join(dataDir, file);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'newsmonger-recover-'));
  try {
    const copy = path.join(scratch, 'newsmonger.db');
    fs.copyFileSync(source, copy);
    // Opened first for its error. `Store`'s constructor answers an unreadable
    // file by quarantining it and starting fresh, which here would look like a
    // database that simply had nothing in it — a silent, empty "recovery".
    openDb(copy).close();
    const store = new Store(scratch);
    try {
      return read(store);
    } finally {
      store.close();
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Every set-aside database in the data directory, newest first, with what each
 * one holds.
 *
 * Independent of the FR-4.17 notice on purpose. That notice is dismissible, and
 * a route back that a dismissal destroys is not a route back — so this reads the
 * directory instead, and finds files left by builds that predate the notice
 * entirely.
 */
export function listSetAside(dataDir: string): SetAsideDatabase[] {
  let names: string[];
  try {
    names = fs.readdirSync(dataDir).filter(isSetAsideName);
  } catch {
    return [];
  }
  const found = names.map((file) => {
    const stat = fs.statSync(path.join(dataDir, file));
    const entry: SetAsideDatabase = {
      file,
      setAsideAt: stat.mtime.toISOString(),
      sizeBytes: stat.size,
      contents: null,
      error: null,
    };
    try {
      entry.contents = withSetAside(dataDir, file, (store) => ({
        topics: store.listTopics().length,
        items: store.listItems().length,
        runs: store.listRuns(Number.MAX_SAFE_INTEGER).length,
      }));
    } catch (err) {
      // Reported, not thrown: one unreadable file must not hide the others, and
      // "we still cannot read this" is itself something the user needs told.
      entry.error = err instanceof Error ? err.message : String(err);
    }
    return entry;
  });
  return found.sort((a, b) => b.setAsideAt.localeCompare(a.setAsideAt));
}

export interface RecoveryResult {
  topics: number;
  items: number;
  runs: number;
  /** Where the database being replaced was written first. */
  safetyCopy: string;
}

/**
 * Replace everything in the live database with the contents of a set-aside one.
 *
 * The current contents are written to `pre-recover-<ts>.json` **first**, in the
 * same shape a backup uses, so this is not the second irreversible step in a
 * story that started with one. Someone recovering a database may have added
 * topics since; those are not silently the price of getting the old ones back.
 *
 * The set-aside file itself is left exactly where it is. Recovering is a copy,
 * not a move — if the result is not what they hoped, the original is still
 * there to try again from.
 *
 * The FR-4.17 notice is dismissed on success, since it has now been answered.
 */
export function recoverSetAside(store: Store, file: string): RecoveryResult {
  const data: DataFile = withSetAside(store.dataDir, file, (recovered) => buildBackup(recovered));

  const safetyCopy = path.join(store.dataDir, `pre-recover-${String(Date.now())}.json`);
  fs.writeFileSync(safetyCopy, `${JSON.stringify(buildBackup(store), null, 2)}\n`);

  store.replaceAll(data);
  store.dismissQuarantine();

  return { topics: data.topics.length, items: data.items.length, runs: data.runs.length, safetyCopy };
}
