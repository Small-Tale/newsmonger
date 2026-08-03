import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { defineConfig } from '@playwright/test';

// Each test run gets its own isolated data dir (pid-scoped) so E2E state never
// touches the real ~/.newsmonger and parallel runs don't collide.
const dataDir = path.join(os.tmpdir(), `newsmonger-e2e-${process.pid}`);
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });

const PORT = 4189;

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
  testIgnore: process.env['NEWSMONGER_E2E_REAL'] === '1' ? [] : ['**/real-providers.spec.ts'],
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
  webServer: {
    command: `npm run build:client:dev && npx tsx src/cli.ts --no-open --strict-port --ai-test --port ${PORT} --data-dir ${dataDir}`,
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
