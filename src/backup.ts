import fs from 'node:fs';
import path from 'node:path';

import type { DataFile } from './db/schemas.js';
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
 * import parses (FR-4.8a). That makes restore need no new code at all: drop the
 * backup into an empty data directory as `data.json` and the existing one-time
 * import reads it, migrations and all. A bespoke backup format would have meant
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
