/**
 * How to spawn npm and npx on this platform (NEWS-348, NEWS-354, NEWS-356).
 *
 * On Windows these are **`npm.cmd` / `npx.cmd`**, batch shims rather than
 * executables, and running one from Node needs *both* halves of what these
 * return:
 *
 * 1. The `.cmd` name. `execFile`/`spawn` resolve only real executables, never
 *    `PATHEXT` shims, so a bare `'npm'` throws `spawnSync npm ENOENT`.
 * 2. `shell: true`. Since the CVE-2024-27980 hardening (Node 18.20.2 / 20.12.2
 *    / 21.7.3 and everything after), Node **refuses** to spawn a `.bat` or
 *    `.cmd` without a shell and throws `spawnSync npm.cmd EINVAL`.
 *
 * Getting only (1) cost a failed `v0.2.0-beta.16`; adding (2) came a release
 * later. They are returned together so a caller cannot take half.
 *
 * POSIX needs neither, so it gets neither: a bare name, no shell.
 *
 * Lives in `scripts/` rather than `tests/` because both a unit test and two
 * build scripts need it, and `tests/e2e/global-setup.ts` — its first home — was
 * reachable from none of them.
 *
 * The `platform` parameter exists so a test can ask about a platform it is not
 * running on. That is the whole difficulty: on macOS and Linux the plain spawn
 * works, so this is invisible on every machine anyone develops on and shows up
 * only in the Windows E2E job.
 */

/** @typedef {{ command: string, shell: boolean }} SpawnSpec */

/**
 * @param {NodeJS.Platform} [platform]
 * @returns {SpawnSpec}
 */
export function npmSpawn(platform = process.platform) {
  return platform === 'win32' ? { command: 'npm.cmd', shell: true } : { command: 'npm', shell: false };
}

/**
 * @param {NodeJS.Platform} [platform]
 * @returns {SpawnSpec}
 */
export function npxSpawn(platform = process.platform) {
  return platform === 'win32' ? { command: 'npx.cmd', shell: true } : { command: 'npx', shell: false };
}
