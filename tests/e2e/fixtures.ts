import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Locator, Page } from '@playwright/test';
import { expect, test as base } from '@playwright/test';

export { expect } from '@playwright/test';

/**
 * Accept the in-app confirmation dialog (NEWS-39).
 *
 * The app no longer uses `window.confirm`, which is a silent no-op in the Tauri
 * WKWebView — and which Playwright would auto-accept in headless, hiding that
 * very bug. Driving the real in-DOM dialog makes the test take the same path a
 * user does.
 */
export async function acceptConfirm(page: Page): Promise<void> {
  await expect(page.locator('.dialog.confirm')).toBeVisible();
  await page.locator('[data-action=confirm-ok]').click();
  await expect(page.locator('.dialog.confirm')).toHaveCount(0);
}

export async function cancelConfirm(page: Page): Promise<void> {
  await expect(page.locator('.dialog.confirm')).toBeVisible();
  await page.locator('[data-action=confirm-cancel]').click();
  await expect(page.locator('.dialog.confirm')).toHaveCount(0);
}

/**
 * Run a topic action through the right-click menu.
 *
 * Topic actions moved out of always-visible row buttons and into a context
 * menu (NEWS-29), so specs drive them the way a user does. Lives here rather
 * than in a spec because Playwright forbids one test file importing another.
 */
export async function topicAction(
  page: Page,
  row: Locator,
  action: 'check' | 'pause' | 'solo' | 'delete',
): Promise<void> {
  await row.click({ button: 'right' });
  await expect(page.locator('.menu')).toBeVisible();
  await page.locator(`[data-menu-action=${action}]`).click();
  await expect(page.locator('.menu')).toHaveCount(0);
  // Delete now raises an in-app confirmation; accept it so the action completes.
  if (action === 'delete') await acceptConfirm(page);
}

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
