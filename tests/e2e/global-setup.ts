import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Build the client bundle once, before any worker starts (NEWS-321).
 *
 * This used to be the first half of the `webServer` command —
 * `npm run build:client:dev && node --import tsx/esm src/cli.ts …` — which is
 * correct when there is one server and wrong when there are four: four esbuild
 * and sass runs, concurrently, writing the same files in `dist/client/`. The
 * likely outcome is not a build error but a *torn* bundle, served to whichever
 * worker asked first, and a failure that looks like anything but its cause.
 *
 * `globalSetup` is the only hook that runs before the worker processes exist.
 *
 * Deliberately not skipped when `dist/client/` already looks current: deciding
 * that correctly means comparing every source file's mtime against the bundle's,
 * and getting it wrong means the suite silently tests the previous commit's UI.
 * The build takes about a second.
 */
export default function globalSetup(): void {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const npm = npmSpawn();
  execFileSync(npm.command, ['run', 'build:client:dev'], {
    cwd: root,
    stdio: 'inherit',
    shell: npm.shell,
  });
}

/**
 * How to spawn npm on this platform (NEWS-348, corrected in NEWS-354).
 *
 * On Windows npm is **`npm.cmd`**, a batch shim rather than an executable, and
 * getting it to run takes **both** halves of this:
 *
 * 1. The name has to be `npm.cmd`. `execFile`/`spawn` resolve only real
 *    executables, never `PATHEXT` shims, so a bare `'npm'` throws
 *    `spawnSync npm ENOENT`.
 * 2. It has to go through a shell. Since the CVE-2024-27980 hardening (Node
 *    18.20.2 / 20.12.2 / 21.7.3 and everything after), Node **refuses** to spawn
 *    a `.bat` or `.cmd` without `shell: true` and throws
 *    `spawnSync npm.cmd EINVAL`. There is no shell-free way to run npm on
 *    Windows any more; that is the point of the change.
 *
 * NEWS-348 fixed only (1), and its comment here argued that `shell: true` was
 * "worse" and brought cmd.exe quoting into a path that had no need of it. That
 * was wrong on the facts — the shell is not optional — and it cost a second
 * failed release to find out. The quoting concern is also empty: the arguments
 * are two literals with no spaces or metacharacters and no user input anywhere
 * near them.
 *
 * POSIX needs neither half, so it gets neither: a bare `npm`, no shell.
 *
 * Nothing else in the harness needs this — `server.ts` spawns `process.execPath`,
 * which is a real binary everywhere. This is the one place a *tool* is spawned by
 * name.
 *
 * The parameter exists so a test can ask about a platform it isn't running on.
 * That is the whole difficulty: on macOS and Linux the plain spawn works, so
 * this is invisible on every machine anyone develops on and shows up only in the
 * Windows E2E job, which runs once per release.
 */
export function npmSpawn(platform: NodeJS.Platform = process.platform): { command: string; shell: boolean } {
  return platform === 'win32' ? { command: 'npm.cmd', shell: true } : { command: 'npm', shell: false };
}
