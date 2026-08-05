import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { defineConfig } from '@playwright/test';

import { E2E_REAL_SERVER, E2E_SERVER, e2ePort } from './tests/helpers/e2e-port.js';

// Each test run gets its own isolated data dir (pid-scoped) so E2E state never
// touches the real ~/.newsmonger and parallel runs don't collide.
const dataDir = path.join(os.tmpdir(), `newsmonger-e2e-${process.pid}`);
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });

// Derived from the checkout path, not hardcoded (NEWS-287) — two worktrees, or an
// agent and a developer, can now run E2E at the same time. See
// tests/helpers/e2e-port.ts for why the path and not the pid.
const PORT = e2ePort(E2E_SERVER);

const realRun = process.env['NEWSMONGER_E2E_REAL'] === '1';

/**
 * Clear the port before Playwright's own check gets to it.
 *
 * This is the only hook that runs *before* the webServer plugin: Playwright's
 * task order is plugin setup (which starts the server) and only then
 * `globalSetup`, and with `reuseExistingServer: false` the plugin throws on a
 * held port before it ever runs the command — so neither a `globalSetup` nor a
 * prefix on the command can get in front of it.
 *
 * **Guarded to the main process.** Worker processes re-import this config file,
 * and by then our own server is legitimately listening — an unguarded pre-flight
 * would see it and abort the run it is meant to protect. `TEST_WORKER_INDEX` is
 * set by Playwright's worker entry before it loads the config; verified by
 * logging pid/ppid/worker from here across a real run (main: `worker=undefined`,
 * worker: `worker=0`).
 */
if (process.env['TEST_WORKER_INDEX'] === undefined) {
  const ports = realRun ? [PORT, e2ePort(E2E_REAL_SERVER)] : [PORT];
  try {
    execFileSync(process.execPath, ['scripts/e2e-preflight.mjs', ...ports.map(String)], {
      cwd: import.meta.dirname,
      stdio: 'inherit',
    });
  } catch {
    // The script has already explained itself on stderr; this only stops the run.
    throw new Error(`E2E pre-flight failed for port ${ports.join(', ')} — see the message above.`);
  }
}

export default defineConfig({
  testDir: 'tests/e2e',
  /**
   * The real-subscription spec is opt-in (NEWS-276).
   *
   * It spends plan quota and takes minutes, so it must not ride along on
   * `npm run test:all` — the thing you run before every commit. `npm run
   * test:e2e:real` sets the flag; nothing else does.
   *
   * Note the shared `--ai-test` webServer below still boots for a real run, and
   * that is wanted rather than tolerated: its command builds the client bundle,
   * which the real spec's own server needs in order to serve anything.
   */
  testIgnore: realRun ? [] : ['**/real-providers.spec.ts'],
  // Serial: all tests share one server + one data file.
  workers: 1,
  retries: 1,
  timeout: 30_000,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'on-first-retry',
  },
  // The dev bundle, deliberately: it carries kerf's diagnostics with
  // `invariants: 'throw'`, so a morph/list-bookkeeping bug fails the suite at
  // the render that caused it instead of surfacing as a confusing assertion
  // several steps later (NEWS-100). The `pageerror` guard in fixtures.ts is
  // what makes that throw visible.
  // `node --import tsx/esm`, not `npx tsx` (NEWS-299).
  //
  // Same loader, same source, same coverage — `tsx/esm` only registers the
  // resolve/load hooks, where the `tsx` **CLI** additionally opens a unix-domain
  // socket (`createIpcServer`) to coordinate with its own child process. That
  // socket is what made `npm run test:all` impossible inside an agent's command
  // sandbox: `listen EPERM … /tmp/claude-501/tsx-501/<pid>.pipe`, every run.
  //
  // The two options the ticket proposed were both measured and both fail here:
  //
  //   - **Redirect tsx's pipe to a writable directory.** The sandbox denies
  //     `bind()` on a unix socket *anywhere*, `$TMPDIR` included — verified with
  //     a two-line `net.createServer().listen()` probe. It restricts the syscall,
  //     not the path, so no directory setting can help.
  //   - **Node's native type stripping** (`--experimental-strip-types`). Node
  //     22.14's ESM resolver does not map a `.js` specifier onto a `.ts` file,
  //     which is how this codebase imports, so `src/cli.ts` fails at its first
  //     import. Type stripping was never the missing piece — resolution was, and
  //     that is precisely what tsx's loader hooks supply.
  //
  // Switching to the bundle (`dist/cli.js`) would have cost the server's E2E
  // coverage contribution or a sourcemap-remapping step in
  // `scripts/merge-coverage.mjs`. This keeps `NODE_V8_COVERAGE` pointed at
  // `src/**` exactly as before, because it *is* the same execution.
  webServer: {
    command: `npm run build:client:dev && node --import tsx/esm src/cli.ts --no-open --strict-port --ai-test --port ${PORT} --data-dir ${dataDir}`,
    url: `http://127.0.0.1:${PORT}/healthz`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      // Key flows are driven through the real UI, so the server needs a
      // keychain — but never the developer's own, which would leave entries
      // behind and can block on an OS authorization prompt.
      NEWSMONGER_FAKE_KEYCHAIN: '1',
      // No background sweeps for the length of a run (NEWS-238). One server
      // serves every spec, and a scheduled check is an actor no test asked for
      // — it checks never-checked topics (most of what a spec creates) at a
      // phase unrelated to the test in progress, and writes stories, runs and
      // failures into the state those tests assert on. Every check a test sees
      // should be one it triggered.
      NEWSMONGER_SCHEDULER_TICK_MS: String(24 * 60 * 60 * 1000),
      // When E2E_COVERAGE=1 (scripts/test-all.sh), the server process writes V8
      // coverage on exit; scripts/merge-coverage.mjs converts it with c8.
      ...(process.env.E2E_COVERAGE === '1'
        ? { NODE_V8_COVERAGE: path.join(process.cwd(), '.coverage-tmp/server') }
        : {}),
    },
  },
});
