import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// The walk below stays this file's own, deliberately — it is scoped differently
// from the text-hygiene guards' and filters to source extensions. The *separator
// contract* is not walk-specific, though, and repeating it inline at each site is
// how two of the four places that needed it came to be missing it (NEWS-419).
import { isSkippedEntry, repoRelative, walkProblems } from '../helpers/source-tree.js';

/**
 * Nothing this repo runs may invoke the **tsx CLI** (NEWS-299).
 *
 * `tsx` the command opens a unix-domain socket to coordinate with its own child
 * process (`createIpcServer`). An agent's command sandbox denies `bind()` on a
 * unix socket — measured, and *anywhere*, `$TMPDIR` included, because it
 * restricts the syscall rather than the path — so every such invocation dies
 * with `listen EPERM … /<tmp>/tsx-<uid>/<pid>.pipe`.
 *
 * **It is the command, not the package.** `node --import tsx/esm` and
 * `node --import tsx` both register the resolve/load hooks and open nothing —
 * measured, both run `src/cli.ts` under the sandbox. Only `tsx <file>` and
 * `npx tsx <file>` spawn the wrapper that needs the socket. So the rule this
 * guards is narrow on purpose: the Tauri shell's `node --import tsx src/cli.ts`
 * (`src-tauri/src/lib.rs`) is correct as written and must not be flagged.
 *
 * **This has now been fixed twice.** NEWS-295 moved the unit suite's CLI spawn
 * to `node dist/cli.js`, and `npm run test:all` still could not run in a sandbox
 * because `playwright.config.ts` booted the E2E server with `npx tsx`. Fixing
 * call sites one at a time is how this survives, so the guard is on the pattern
 * rather than on any one file.
 *
 * It cannot be caught by running the tests: on a machine with a permissive
 * `/tmp` every one of them passes either way, which is exactly how the E2E line
 * outlived the unit fix.
 */

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Every file that could spawn a process, found by walking rather than by list.
 *
 * This **was** a hand-maintained array (NEWS-356), which is the failure its own
 * doc comment above predicts: the rule is on the pattern, but a curated list
 * silently exempts anything nobody remembered to add. `tests/e2e/real-providers.spec.ts`
 * spawned `npx tsx` and was simply not on it — and neither was
 * `tests/e2e/server.ts`, the single most important spawner in the repo.
 *
 * A walk cannot go stale. Adding a spawner cannot opt out of the rule by
 * omission, only by deliberately editing this function.
 */
function spawners(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      // Shared with the other two walks (NEWS-424). This one used to skip
      // `binaries` and `server` by **bare directory name**, which is the hole
      // `SKIPPED_PATHS` was written to avoid and warns about in its own doc: a
      // future `src/server/` would have been swallowed whole by the guard that
      // exists to catch unfixed spawners.
      if (isSkippedEntry(entry.name, full)) continue;
      if (entry.isDirectory()) walk(full);
      // `repoRelative`, not `path.relative`: the required names below and the
      // `path.join(root, file)` reads are all written with `/`, and Windows would
      // hand back `\` (NEWS-419).
      else if (/\.(ts|tsx|mjs|js|sh|rs)$/.test(entry.name)) found.push(repoRelative(full));
    }
  };
  for (const sub of ['src', 'scripts', 'tests', 'src-tauri/src']) walk(path.join(root, sub));
  // Root-level config that carries commands but lives in no scanned directory.
  for (const file of ['package.json', 'playwright.config.ts', 'vitest.config.ts']) {
    if (fs.existsSync(path.join(root, file))) found.push(file);
  }
  return found.sort();
}

const SPAWNERS = spawners();


/**
 * `tsx` used as a **command**, rather than as a loader argument.
 *
 * Matches `tsx <file>.ts` and `npx tsx …`. The lookbehinds are what keep the
 * legitimate forms out: `--import tsx src/cli.ts` is the Tauri shell's dev spawn
 * and opens no socket, so a rule that flagged it would push someone toward
 * "fixing" working code. `tsx/esm`, the dependency entry, and prose about the
 * trap are all excluded by the `.ts` lookahead.
 */
const TSX_CLI =
  /(?:^|[\s&|;"'`(])(?<!--import )(?<!--loader )(?<!--require )(?:npx\s+)?tsx(?=\s+[^\s]*\.[cm]?ts\b)/;

describe('every spawned entry point stays sandbox-safe (NEWS-299)', () => {
  it('scans a plausible number of files, so a broken walk cannot pass silently', () => {
    // The failure mode of replacing a list with a walk: match nothing, assert
    // nothing, stay green forever.
    //
    // The floor was 100 against a walk that finds 278 (NEWS-424) — losing
    // `tests/` whole, 162 files, would not have tripped it. 200 does, and so
    // does losing `src/`. The named files below are the other instrument, one
    // per walked root: `src-tauri/src` contributes too few for any floor to
    // police, so only naming a file in it can notice it going missing.
    expect(
      walkProblems(SPAWNERS, {
        floor: 200,
        required: [
          'src/cli.ts',
          'scripts/e2e-preflight.mjs',
          'tests/e2e/server.ts',
          'src-tauri/src/lib.rs',
          'playwright.config.ts',
          'package.json',
        ],
        label: 'spawner walk',
      }),
    ).toEqual([]);
  });

  it.each(SPAWNERS)('%s does not invoke the tsx CLI', (file) => {
    const full = path.join(root, file);
    // Comments are stripped first: `playwright.config.ts` and `test-all.sh` both
    // *explain* the trap at length, and a guard that fails on its own
    // explanation teaches people to delete the explanation.
    const text = fs
      .readFileSync(full, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((l) => l.replace(/^\s*(?:\/\/|#|\s\*)\s.*$/, ''))
      .join('\n');
    const hit = TSX_CLI.exec(text);
    expect(hit?.[0] ?? null, `${file} runs the tsx CLI — use \`node --import tsx/esm\` instead`).toBeNull();
  });

  it('still runs the E2E server from source, not from the bundle', () => {
    // The other half of the constraint, and the reason the obvious fix was
    // rejected: `NODE_V8_COVERAGE` on this process is the server's contribution
    // to the merged report, and coverage of `dist/cli.js` is coverage of a
    // bundle, not of `src/**`. Switching to the binary would have silently
    // dropped that leg or required sourcemap remapping in merge-coverage.mjs.
    //
    // Read from `tests/e2e/server.ts` since NEWS-321. It used to be the
    // `webServer` command in `playwright.config.ts`; sharding needed a server
    // *per worker* and Playwright's `webServer` is global, so the spawn moved to
    // a worker-scoped fixture. The property is unchanged — only where it lives.
    const spawner = fs.readFileSync(path.join(root, 'tests/e2e/server.ts'), 'utf8');
    const args = /spawn\([\s\S]*?\[([\s\S]*?)\],/.exec(spawner)?.[1] ?? '';
    expect(args, 'the E2E server spawn must still be found').not.toBe('');
    expect(args).toContain("'src/cli.ts'");
    expect(args).not.toContain('dist/cli.js');
    expect(args, 'run through the loader, not the CLI').toContain("'tsx/esm'");
    expect(args, 'the loader is registered with --import').toContain("'--import'");
  });

  it('builds the client once, before the workers exist (NEWS-321)', () => {
    // The build used to be the first half of the `webServer` command, which is
    // correct for one server and is N concurrent esbuild+sass runs writing the
    // same files for N. The likely symptom is not a build error but a *torn*
    // bundle served to whichever worker asked first — a failure that would look
    // like anything but its cause.
    const config = fs.readFileSync(path.join(root, 'playwright.config.ts'), 'utf8');
    expect(config, 'globalSetup is what runs before any worker starts').toContain('globalSetup');
    expect(config, 'the server is no longer declared globally').not.toContain('webServer:');

    const setup = fs.readFileSync(path.join(root, 'tests/e2e/global-setup.ts'), 'utf8');
    expect(setup).toContain('build:client:dev');
  });
});
