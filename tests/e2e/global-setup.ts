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
  execFileSync('npm', ['run', 'build:client:dev'], { cwd: root, stdio: 'inherit' });
}
