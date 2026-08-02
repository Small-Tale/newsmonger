import fs from 'node:fs';
import path from 'node:path';

import type { DataFile } from './db/schemas.js';
import { DataFileSchema } from './db/schemas.js';
import type { Store } from './db/store.js';

/**
 * Snapshot the whole store into a chosen folder (NEWS-192, FR-27.6).
 *
 * The requested feature was "point the data directory at iCloud/Drive". That is
 * a documented way to corrupt SQLite: WAL keeps an invariant across
 * `newsmonger.db`, `-wal` and `-shm`, and a sync daemon moves those three
 * independently. So the live database stays local and this writes a **copy**
 * into the synced folder instead — same outcome the request wanted, none of the
 * risk.
 *
 * **The shape is deliberately `DataFile`,** the same one the legacy `data.json`
 * import parses (FR-4.8a) — so `restoreBackup` below reuses that schema and
 * gets every migration it performs for free. That reuse was originally sold as
 * "restore needs no code at all: rename the file into the data directory". It
 * did need code (NEWS-252): the importer reads a different filename in a
 * different folder and only into an *empty* database, so anyone who had opened
 * the app once on a new machine was locked out of their own backup with no
 * error to explain it. A bespoke backup format would have meant
 * writing — and maintaining, and testing — a bespoke restore.
 *
 * **API keys are not in here**, and cannot be: they live in the OS keychain, not
 * in `Settings` (FR-7.x). A backup that quietly carried credentials into a
 * synced folder would be a much worse bug than the one this feature fixes.
 */
export const BACKUP_FILE = 'newsmonger-backup.json';

/** Written next to the real file, then renamed over it. */
const TEMP_FILE = '.newsmonger-backup.json.tmp';

/**
 * How often a backup may be written, at most.
 *
 * Backups are triggered by events (startup, a finished check), not a timer, so
 * this is what stops a busy sweep from rewriting several megabytes a dozen times
 * in a minute. An hour is well inside "I lost my laptop" tolerance and well
 * outside "my sync client is thrashing".
 */
export const MIN_BACKUP_INTERVAL_MS = 60 * 60 * 1000;

/** Everything worth restoring: the config *and* the news it has gathered. */
export function buildBackup(store: Store): DataFile {
  return {
    topics: store.listTopics(),
    items: store.listItems(),
    settings: store.getSettings(),
    // Bounded already (NEWS-103 caps runs at 200), and worth keeping: the run
    // history is what the failure banner and the falling-behind detector read.
    runs: store.listRuns(Number.MAX_SAFE_INTEGER),
  };
}

/**
 * Write a backup, atomically.
 *
 * Temp file then `rename`, which is atomic on both POSIX and Windows within a
 * directory. This matters more than usual here: the destination is a folder a
 * sync client is watching, and a partially-written JSON file is exactly the
 * thing that would get uploaded and then restored over a good one.
 */
export function writeBackup(store: Store, dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, BACKUP_FILE);
  const temp = path.join(dir, TEMP_FILE);
  fs.writeFileSync(temp, `${JSON.stringify(buildBackup(store), null, 2)}\n`);
  fs.renameSync(temp, target);
  return target;
}

/**
 * What a backup folder holds, without committing to restoring it (NEWS-252).
 *
 * The preview exists so the confirmation step can say *what* is about to
 * replace *what* — "restore 12 topics and 340 stories saved 3 hours ago" is a
 * decision a person can make; "restore?" is not. It is also the honest place to
 * report a folder that has no backup, or one this version cannot read, since
 * both are things the user needs to know **before** agreeing to overwrite.
 */
export interface BackupPreview {
  /** Absolute path of the file that was inspected. */
  path: string;
  topics: number;
  items: number;
  /** When the snapshot was written, from the file's mtime. */
  savedAt: string;
}

/** Read a backup folder. Throws with a reason a person can act on. */
export function readBackup(dir: string): { data: DataFile; preview: BackupPreview } {
  const file = path.join(dir, BACKUP_FILE);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    // Named precisely: "no backup found in that folder" sends someone to look
    // at the folder, where the answer is. "Restore failed" sends them nowhere.
    throw new Error(`no ${BACKUP_FILE} in ${dir}`);
  }
  let data: DataFile;
  try {
    data = DataFileSchema.parse(JSON.parse(raw));
  } catch {
    throw new Error(`${file} is not a readable Newsmonger backup`);
  }
  return {
    data,
    preview: {
      path: file,
      topics: data.topics.length,
      items: data.items.length,
      savedAt: fs.statSync(file).mtime.toISOString(),
    },
  };
}

/**
 * Replace everything with the snapshot in `dir`, after saving what is there.
 *
 * **The safety copy is not optional.** This is the one action in the app that
 * destroys data the user did not ask to delete, and "I clicked restore and lost
 * the topics I had added since" is a complaint with no answer unless the old
 * state is still somewhere. It is written into the data directory rather than
 * the backup folder, so it cannot be picked up as a backup to restore *from*
 * and cannot be clobbered by the sync client that owns that folder.
 */
export function restoreBackup(store: Store, dir: string): { preview: BackupPreview; safetyCopy: string } {
  const { data, preview } = readBackup(dir);
  const safetyCopy = path.join(store.dataDir, `pre-restore-${String(Date.now())}.json`);
  fs.writeFileSync(safetyCopy, `${JSON.stringify(buildBackup(store), null, 2)}\n`);
  store.replaceAll(data);
  return { preview, safetyCopy };
}

/**
 * Event-driven backup with a floor on how often it actually writes.
 *
 * Best-effort by construction: a backup that fails must never turn a successful
 * check into a failed one, and the destination is a folder that can be
 * unmounted, full, or renamed by a sync client at any moment. Errors are
 * reported and swallowed.
 */
export class Backups {
  private lastWriteMs = 0;

  constructor(
    private readonly store: Store,
    /** Reads the setting fresh each time, so changing it takes effect at once. */
    private readonly dir: () => string,
    private readonly now: () => number = () => Date.now(),
    private readonly onError: (message: string) => void = (m) => {
      console.error(m);
    },
  ) {}

  /** Write unless one was written recently. Returns the path, or null. */
  maybeWrite(): string | null {
    const dir = this.dir();
    if (dir === '') return null; // the feature is off until a folder is chosen
    const last = this.lastSeenWriteMs(dir);
    // `null` means there is no backup yet, which is never a reason to skip one.
    if (last !== null && this.now() - last < MIN_BACKUP_INTERVAL_MS) return null;
    return this.write();
  }

  /**
   * When the last backup happened, from this process *or* an earlier one.
   *
   * The in-memory timestamp alone would make the throttle per-process, which
   * defeats it exactly where it matters most: the startup backup. An app the
   * user quits and reopens a few times an hour — or a `tauri dev` loop — would
   * rewrite the whole snapshot on every launch. The file's own mtime is the
   * durable record of when it was last written, so it is the one to ask.
   */
  private lastSeenWriteMs(dir: string): number | null {
    if (this.lastWriteMs !== 0) return this.lastWriteMs;
    try {
      return fs.statSync(path.join(dir, BACKUP_FILE)).mtimeMs;
    } catch {
      return null; // no backup there yet (or the folder is gone) — write one
    }
  }

  /** Write regardless of the interval — for an explicit "Back up now". */
  write(): string | null {
    const dir = this.dir();
    if (dir === '') return null;
    try {
      const at = writeBackup(this.store, dir);
      this.lastWriteMs = this.now();
      return at;
    } catch (err) {
      this.onError(`newsmonger: backup to ${dir} failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }
}
