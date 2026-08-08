import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach } from 'vitest';

import { Store } from '../../src/db/store.js';

const created: string[] = [];

/** Create a temporary data directory, cleaned up after each test. */
export function tmpDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'newsmonger-test-'));
  created.push(dir);
  return dir;
}

/**
 * A `Store` that gets closed after the test, on a directory that gets removed
 * (NEWS-431).
 *
 * Use this instead of `new Store(tmpDataDir())`. The difference only shows on
 * Windows: an open SQLite handle makes the directory unremovable there, where
 * POSIX is happy to unlink a file somebody still holds. 46 of 126 test files
 * failed a release that way — every one of them having passed its assertions —
 * because none of them closed the store they opened.
 *
 * `dir` is optional so the two shapes in the suite both fit: a fresh directory,
 * or an existing one being **reopened**, which is how the persistence tests
 * check that what was written comes back.
 *
 * `tests/unit/store-cleanup.test.ts` keeps `new Store(` out of the unit suite,
 * so this cannot be bypassed by habit.
 */
export function tmpStore(dir: string = tmpDataDir()): Store {
  const store = new Store(dir);
  stores.push(store);
  return store;
}

const stores: Store[] = [];

/**
 * Remove the directories the test made, tolerating a still-open database.
 *
 * **This was POSIX-assuming, and it failed a release** (NEWS-429). Most tests
 * here open a `Store` and never close it, which is harmless on macOS and Linux:
 * unlinking a file that is still open is allowed, the name goes immediately and
 * the inode is reclaimed when the last handle closes. Windows refuses — the
 * `unlink` fails with `EBUSY` — so the hook threw and took **46 of 126 test
 * files** down with it, every one of them having passed its assertions.
 *
 * `force: true` does not cover this. It suppresses `ENOENT` only.
 *
 * **Strict again as of NEWS-431**: `tmpStore()` closes every store the test
 * opened, so nothing holds a handle and the removal has no reason to fail. An
 * error here is now information rather than noise — it means a handle survived,
 * which is the thing this hook could not previously distinguish from the normal
 * case.
 *
 * Two earlier versions are worth remembering, because both looked right:
 *
 *   - `force: true` alone. It suppresses `ENOENT` only, not the `EBUSY` Windows
 *     raises for an open file — 46 of 126 files failed a release that way.
 *   - `maxRetries: 5, retryDelay: 50`, reasoning about a handle mid-close. The
 *     handles were open for good, so every directory paid the full 250ms before
 *     giving up, in a hook that runs after *every* test, and four suites then
 *     timed out at 5000ms. Retrying cannot change an open handle.
 *
 * The fix for both was to stop leaving handles open, not to negotiate with the
 * filesystem about them.
 */
afterEach(() => {
  // Stores first: the directory cannot go while a handle on it is open.
  while (stores.length > 0) {
    const store = stores.pop();
    try {
      store?.close();
    } catch {
      // Already closed. Several tests close explicitly — to reopen the same
      // directory, or to assert on what closing does — and a double close is
      // their success, not a failure worth reporting.
    }
  }
  while (created.length > 0) {
    const dir = created.pop();
    if (dir === undefined) continue;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
