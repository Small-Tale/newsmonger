import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach } from 'vitest';

const created: string[] = [];

/** Create a temporary data directory, cleaned up after each test. */
export function tmpDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'newsmonger-test-'));
  created.push(dir);
  return dir;
}

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
 * **One attempt, no retries** — and that is a correction. The first fix passed
 * `maxRetries: 5, retryDelay: 50`, reasoning about a handle in the process of
 * closing. That is not the case here: the handles are open for good, so every
 * directory paid the full 250ms budget before giving up, in a hook that runs
 * after *every* test. Four suites then timed out at 5000ms on the Windows runner
 * — a fresh set of failures, caused by the fix for the previous set.
 *
 * `EBUSY` / `EPERM` means a handle is still open, and retrying cannot change
 * that. The right response is to leave the directory: it is under `os.tmpdir()`,
 * the OS reclaims it, and failing here would report a test as broken when what
 * it actually did was decline to call `close()`.
 *
 * Any other error still throws. A cleanup hook that swallows everything is how a
 * helper stops being able to tell "nothing to remove" from "removal is broken".
 *
 * This is not covering for a product defect — `Store.close()` exists and the CLI
 * calls it. It is test hygiene that only one platform can see, which is why the
 * Windows unit run (NEWS-419) is the thing that found it.
 */
afterEach(() => {
  while (created.length > 0) {
    const dir = created.pop();
    if (dir === undefined) continue;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EBUSY' && code !== 'EPERM') throw err;
    }
  }
});
