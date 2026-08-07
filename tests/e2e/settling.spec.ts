import type { Page, Request } from '@playwright/test';

import { expect, resetSharedState, test, topicAction, workerBaseURL } from './fixtures.js';

/**
 * A topic's dialog holds off its scheduled check (NEWS-366, FR-34.4 – FR-34.6).
 *
 * **What this file can and cannot see.** The E2E server runs with
 * `NEWSMONGER_SCHEDULER_TICK_MS` set to a day (NEWS-238), so no sweep fires
 * during a run and "the check did not happen" is not an assertion this layer can
 * make honestly — it would pass with the feature deleted. That half is unit
 * tested, where the clock is in hand.
 *
 * What only this layer can check is the **client half**: that the running app
 * actually names the open topic on its poll. Everything else could be correct
 * and the feature would still do nothing if the browser never sent the id — and
 * a unit test of `refreshState` would be asserting against a store it built
 * itself, not against the dialog a user opened.
 */

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  await resetSharedState(workerBaseURL());
});

/** Query values of `holding` seen on `/api/state` while `run` was executing. */
async function holdsDuring(page: Page, run: () => Promise<void>): Promise<string[]> {
  const seen: string[] = [];
  const listener = (req: Request): void => {
    const url = new URL(req.url());
    if (url.pathname === '/api/state') seen.push(url.searchParams.get('holding') ?? '');
  };
  page.on('request', listener);
  try {
    await run();
  } finally {
    page.off('request', listener);
  }
  return seen;
}

test('the poll names the topic whose guidance dialog is open', async ({ page }) => {
  await page.goto('/');
  await page.fill('.add-topic input', 'held topic');
  await page.press('.add-topic input', 'Enter');
  const row = page.locator('.topic', { hasText: 'held topic' });
  await expect(row).toBeVisible();

  // Nothing open: the poll carries no hold.
  const idle = await holdsDuring(page, async () => {
    await page.waitForTimeout(5_000);
  });
  expect(idle.length).toBeGreaterThan(0);
  expect(idle.every((v) => v === '')).toBe(true);

  await topicAction(page, row, 'guidance');
  await expect(page.locator('.dialog.guidance')).toBeVisible();

  // Open: every poll names a topic, and the same one each time.
  const held = await holdsDuring(page, async () => {
    await page.waitForTimeout(5_000);
  });
  expect(held.length).toBeGreaterThan(0);
  expect(held.every((v) => v !== '')).toBe(true);
  expect(new Set(held).size).toBe(1);

  await page.click('[data-action=close-guidance]');
  await expect(page.locator('.dialog.guidance')).toHaveCount(0);

  // Closed: the id stops being sent, which is the whole release mechanism —
  // there is no release request to look for (FR-34.5).
  const after = await holdsDuring(page, async () => {
    await page.waitForTimeout(5_000);
  });
  expect(after.length).toBeGreaterThan(0);
  expect(after.every((v) => v === '')).toBe(true);
});

test('the rename dialog holds the topic too', async ({ page }) => {
  await page.goto('/');
  const row = page.locator('.topic', { hasText: 'held topic' });
  await expect(row).toBeVisible();

  await topicAction(page, row, 'rename');
  await expect(page.locator('.dialog.rename')).toBeVisible();

  const held = await holdsDuring(page, async () => {
    await page.waitForTimeout(5_000);
  });
  expect(held.length).toBeGreaterThan(0);
  expect(held.every((v) => v !== '')).toBe(true);
});
