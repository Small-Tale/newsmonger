import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { test as base } from '@playwright/test';

export { expect } from '@playwright/test';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const browserCovDir = path.join(projectRoot, '.coverage-tmp/browser');
const appBundle = path.join(projectRoot, 'dist/client/app.global.js');
let covFileCounter = 0;

/**
 * Test fixture that collects browser V8 JS coverage for the app bundle when
 * E2E_COVERAGE=1 (set by scripts/test-all.sh). Entries are rewritten from the
 * served URL to the built bundle's file:// path and written in
 * NODE_V8_COVERAGE format, so `c8 report` can source-map them back to
 * `src/client/*`. Chromium-only (the only browser we run).
 */
export const test = base.extend({
  page: async ({ page }, use) => {
    const collect = process.env['E2E_COVERAGE'] === '1';
    if (collect) await page.coverage.startJSCoverage({ resetOnNavigation: false });
    await use(page);
    if (collect) {
      const entries = await page.coverage.stopJSCoverage();
      const result = entries
        .filter((e) => e.url.endsWith('/static/app.js'))
        .map((e) => ({ ...e, url: `file://${appBundle}`, source: undefined }));
      if (result.length > 0) {
        fs.mkdirSync(browserCovDir, { recursive: true });
        const file = path.join(browserCovDir, `playwright-${process.pid}-${covFileCounter++}.json`);
        fs.writeFileSync(file, JSON.stringify({ result }));
      }
    }
  },
});
