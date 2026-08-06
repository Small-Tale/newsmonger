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
  execFileSync(npmCommand(), ['run', 'build:client:dev'], { cwd: root, stdio: 'inherit' });
}

/**
 * What npm is actually called on this platform (NEWS-348).
 *
 * On Windows npm is **`npm.cmd`**, a shell shim rather than an executable, and
 * `execFile`/`spawn` without `shell: true` resolve only real executables. A bare
 * `'npm'` therefore throws `spawnSync npm ENOENT` — which, from `globalSetup`,
 * happens before the workers exist and takes the whole suite with it.
 *
 * `shell: true` would also work and is worse: it hands the arguments to cmd.exe
 * and brings its quoting rules into a path that has no need of them.
 *
 * Nothing else in the harness needs this — `server.ts` spawns `process.execPath`,
 * which is a real binary everywhere. This is the one place a *tool* is spawned by
 * name.
 *
 * The parameter exists so a test can ask about a platform it isn't running on.
 * That is the whole difficulty: on macOS and Linux the bare name works, so this
 * bug is invisible on every machine anyone develops on and only appears in the
 * Windows E2E job, which runs once per release.
 */
export function npmCommand(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'npm.cmd' : 'npm';
}
