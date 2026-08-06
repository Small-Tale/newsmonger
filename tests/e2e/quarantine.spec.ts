import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { expect, resetSharedState, test, workerBaseURL, workerDataDir } from './fixtures.js';

// The banner that says a database was set aside (NEWS-340).
//
// FR-4.9 answers an unreadable database by renaming it aside and starting
// fresh. Until this banner existed the only notice was a `console.error`, on a
// stream the desktop app does not show — so the user's whole account of what
// had happened was an empty topic list, which reads as total loss and invites
// them to start deleting things to fix it.
//
// The notice is written by `Store`'s constructor, which no request can provoke
// on a server that is already running, so the `meta` row is staged directly.
// The server reads it uncached on every `/api/state`, which is what makes that
// work — and is itself the reason the notice is not held in memory.

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  await resetSharedState(workerBaseURL());
});

const BACKUP_PATH = '/tmp/newsmonger-e2e/newsmonger.db.corrupt-1785991465508';

function writeNotice(): void {
  const db = new DatabaseSync(path.join(workerDataDir(), 'newsmonger.db'));
  db.prepare(
    `INSERT INTO meta (key, value) VALUES ('quarantine', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(JSON.stringify({ backupPath: BACKUP_PATH, at: '2026-08-06T04:44:25.508Z' }));
  db.close();
}

test('says what happened, and that nothing was deleted', async ({ page }) => {
  writeNotice();
  await page.goto('/');

  const banner = page.locator('#banners .banner.error');
  await expect(banner).toBeVisible({ timeout: 20_000 });
  // The three things a reader needs: what happened, that their data survived,
  // and where it is. The path especially — it is the only route back.
  await expect(banner).toContainText('could not be read');
  await expect(banner).toContainText('Nothing was deleted');
  await expect(banner.locator('.banner-path')).toHaveText(BACKUP_PATH);
});

test('the path is selectable, because the first thing anyone does is copy it', async ({ page }) => {
  await page.goto('/');
  const userSelect = await page
    .locator('#banners .banner-path')
    .evaluate((el) => getComputedStyle(el).userSelect);
  expect(userSelect).not.toBe('none');
});

test('dismissing clears it on the click, not on the next poll', async ({ page }) => {
  await page.goto('/');
  const banner = page.locator('#banners .banner.error');
  await expect(banner).toBeVisible();

  await page.locator('[data-action=dismiss-quarantine]').click();
  // Locally cleared first, so this must not wait out the 4-second poll.
  await expect(banner).toBeHidden({ timeout: 2000 });
});

test('and it stays gone across a reload', async ({ page }) => {
  // Server-owned dismissal: the row is deleted, so unlike the other banners
  // there is no client-side "seen" flag that a reload would forget.
  await page.goto('/');
  await expect(page.locator('#banners .banner.error')).toBeHidden();

  const state = (await (await page.request.get('/api/state')).json()) as { quarantine: unknown };
  expect(state.quarantine).toBeNull();
});
