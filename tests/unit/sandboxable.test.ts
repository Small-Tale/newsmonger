import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

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

/** Files that spawn node on this project's source, and could reach for tsx. */
const SPAWNERS = [
  'package.json',
  'playwright.config.ts',
  'scripts/test-all.sh',
  'scripts/gate-quick.sh',
  'src-tauri/src/lib.rs',
];

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
  it.each(SPAWNERS)('%s does not invoke the tsx CLI', (file) => {
    const full = path.join(root, file);
    expect(fs.existsSync(full), `${file} is named here but does not exist`).toBe(true);
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
    const config = fs.readFileSync(path.join(root, 'playwright.config.ts'), 'utf8');
    const command = /command: `([^`]*)`/.exec(config)?.[1] ?? '';
    expect(command, 'the webServer command must still be found').not.toBe('');
    expect(command).toContain('src/cli.ts');
    expect(command).not.toContain('dist/cli.js');
    expect(command, 'run through the loader, not the CLI').toContain('--import tsx/esm');
  });
});
