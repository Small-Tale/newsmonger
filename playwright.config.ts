import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { defineConfig } from '@playwright/test';

// Each test run gets its own isolated data dir (pid-scoped) so E2E state never
// touches the real ~/.news and parallel runs don't collide.
const dataDir = path.join(os.tmpdir(), `news-e2e-${process.pid}`);
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });

const PORT = 4189;

export default defineConfig({
  testDir: 'tests/e2e',
  // Serial: all tests share one server + one data file.
  workers: 1,
  retries: 1,
  timeout: 30_000,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'on-first-retry',
  },
  webServer: {
    command: `npm run build:client && npx tsx src/cli.ts --no-open --strict-port --ai-test --port ${PORT} --data-dir ${dataDir}`,
    url: `http://127.0.0.1:${PORT}/healthz`,
    reuseExistingServer: false,
    timeout: 60_000,
    // When E2E_COVERAGE=1 (scripts/test-all.sh), the server process writes V8
    // coverage on exit; scripts/merge-coverage.mjs converts it with c8.
    env:
      process.env.E2E_COVERAGE === '1'
        ? { NODE_V8_COVERAGE: path.join(process.cwd(), '.coverage-tmp/server') }
        : {},
  },
});
