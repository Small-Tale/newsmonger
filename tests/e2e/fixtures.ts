import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Locator, Page } from '@playwright/test';
import { expect, request as playwrightRequest, test as base } from '@playwright/test';

export { expect } from '@playwright/test';

/**
 * Delete every topic on the shared server (NEWS-101).
 *
 * The whole suite runs against **one** server and **one** data dir, and
 * `app.spec.ts` / `topics.spec.ts` are `mode: 'serial'` — so when a test fails,
 * Playwright replays the *entire group from the top* without resetting
 * anything. A test that failed before reaching its own cleanup leaves its
 * topics behind, and the replayed early tests then fail on state they never
 * created. The run blames an innocent test and hides the one that actually
 * broke, which is far more expensive than the flake itself.
 *
 * Calling this from `beforeAll` gives every attempt — first run or retry — the
 * same precondition the first attempt had: an empty server. Nothing else is
 * reset (settings, runs), because nothing else has caused this.
 *
 * Uses its own request context rather than the `request` fixture: `beforeAll`
 * only sees worker-scoped fixtures. No `Origin` header is sent, which the
 * cross-origin guard allows by design (FR-4.5a) — a non-browser caller.
 */
export async function resetTopics(baseURL: string): Promise<void> {
  const ctx = await playwrightRequest.newContext({ baseURL });
  try {
    const state = (await (await ctx.get('/api/state')).json()) as { topics: { id: string }[] };
    for (const topic of state.topics) {
      await ctx.delete(`/api/topics/${encodeURIComponent(topic.id)}`);
    }
    // Assert rather than assume: a silent failure here would put the pollution
    // back, and it would look exactly like the bug this exists to prevent.
    const after = (await (await ctx.get('/api/state')).json()) as { topics: unknown[] };
    expect(after.topics, 'server should start each attempt with no topics').toHaveLength(0);
  } finally {
    await ctx.dispose();
  }
}

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
  action: 'check' | 'pause' | 'priority' | 'solo' | 'guidance' | 'rename' | 'delete',
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
    // Suppress the first-run wizard's *auto*-open (NEWS-193).
    //
    // `maybeOpenOnboarding()` opens it when there are no topics AND no usable
    // provider AND it hasn't been seen on this device. Every test starts with a
    // fresh context (empty localStorage) and specs reset topics, so the only
    // term that varied was "usable provider" — and that is decided by whether
    // the *host* has a signed-in `claude` or `codex` CLI.
    //
    // So the suite passed on a dev machine and could never pass on a CI runner:
    // there, onboarding opened and `.onboarding-backdrop` intercepted pointer
    // events for the rest of the run. The tell was that read-only a11y scans
    // passed and the first test that *clicked* timed out.
    //
    // Seeding the flag costs no coverage. No test asserts the auto-open, and the
    // specs that exercise onboarding open it explicitly via Settings →
    // `[data-action=rerun-onboarding]`. Deliberately not "give CI an API key":
    // that would paper over it and assert a state no first-run user is in.
    await page.addInitScript(() => {
      try {
        localStorage.setItem('news:onboarding-seen', '1');
      } catch {
        // Storage disabled — the wizard reappears, which is the pre-fix state.
      }
    });

    const collect = process.env['E2E_COVERAGE'] === '1';
    if (collect) await page.coverage.startJSCoverage({ resetOnNavigation: false });

    // The E2E bundle is built with kerf's dev diagnostics and
    // `invariants: 'throw'` (NEWS-100), which audits kerf's list bookkeeping
    // against the live DOM after every render. That throw surfaces here as an
    // uncaught page error — and without this listener it would be swallowed,
    // leaving the suite green while the DOM was quietly wrong. Collecting them
    // is what turns Playwright into a morph-correctness harness rather than
    // only a behaviour harness.
    const pageErrors: Error[] = [];
    page.on('pageerror', (err) => pageErrors.push(err));

    await use(page);
    expect(pageErrors.map((e) => e.message), 'uncaught errors in the page').toEqual([]);
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

/**
 * Open the settings dialog on a given tab (NEWS-118).
 *
 * Settings is tabbed now, so a control is only in the DOM while its own tab is
 * showing. Tests that reach for a control have to say which tab it lives on —
 * which is also a readable statement of where the feature belongs.
 */
export async function openSettingsTab(page: Page, tab: 'Schedule' | 'Source' | 'Data' | 'App'): Promise<void> {
  await page.click('[data-action=open-settings]');
  await expect(page.locator('.dialog')).toBeVisible();
  await page.locator('.settings-tab').filter({ hasText: tab }).click();
  await expect(page.locator('.settings-tab.active')).toHaveText(tab);
}
