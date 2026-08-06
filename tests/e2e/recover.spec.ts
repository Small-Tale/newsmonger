import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Store } from '../../src/db/store.js';
import { expect, openSettingsTab, resetSharedState, test, workerBaseURL, workerDataDir } from './fixtures.js';

// Recovering a database FR-4.9 set aside (NEWS-342).
//
// FR-4.17's banner tells the user where their old database went; this is the
// answer to the question that follows. The candidate file is staged directly,
// because a set-aside file is produced by a startup failure that no request can
// provoke on a server that is already running — the same reason
// `quarantine.spec.ts` stages its notice.
//
// The recovery replaces the whole database, so this file cleans up after itself
// and every other file resets in its own `beforeAll` (NEWS-313).

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  await resetSharedState(workerBaseURL());
});

const RECOVERED_TOPIC = 'Recovered from a set-aside database';
const SET_ASIDE = 'newsmonger.db.corrupt-1700000000000';

/**
 * Build a real, readable set-aside database holding one recognisable topic.
 *
 * Built through `Store`, not by copying the live file. Copying it was the first
 * attempt and it failed with `no such table: items`: the database runs in WAL
 * mode, so a freshly written schema is still in `newsmonger.db-wal` and the main
 * file alone is empty or stale. That is NEWS-337's lesson, and it applies to a
 * test harness exactly as it applies to a rescue copy. `Store.close()`
 * checkpoints, so the file this copies is complete.
 */
function stageSetAside(): void {
  const dir = workerDataDir();
  const file = path.join(dir, SET_ASIDE);
  fs.rmSync(file, { force: true });

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'newsmonger-e2e-stage-'));
  try {
    const seed = new Store(scratch);
    seed.addTopic(RECOVERED_TOPIC);
    seed.close();
    fs.copyFileSync(path.join(scratch, 'newsmonger.db'), file);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

test('offers a set-aside database, saying what is in it', async ({ page }) => {
  stageSetAside();
  await page.goto('/');
  await openSettingsTab(page, 'Data');

  const row = page.locator('.recover-row');
  await expect(row).toHaveCount(1, { timeout: 20_000 });
  await expect(row).toContainText('1 topic');
  await expect(row.locator('.recover-path')).toHaveText(SET_ASIDE);
  await expect(row.locator('[data-action=recover-db]')).toBeVisible();
});

test('recovering swaps the data in and leaves the file where it was', async ({ page }) => {
  await page.goto('/');
  await page.request.post('/api/topics', { data: { name: 'Typed since the loss' } });
  await openSettingsTab(page, 'Data');

  await page.locator('[data-action=recover-db]').click();
  await page.getByRole('button', { name: 'Recover', exact: true }).click();

  // The toast names where the replaced data went — this is the second
  // irreversible-looking step in a story that began with one, so it must not be.
  await expect(page.locator('.toast')).toContainText('pre-recover-', { timeout: 20_000 });

  await page.keyboard.press('Escape');
  await expect(page.locator('.topic').filter({ hasText: RECOVERED_TOPIC })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.topic').filter({ hasText: 'Typed since the loss' })).toHaveCount(0);

  // Recovering is a copy, not a move: the file is still there to try again from.
  expect(fs.existsSync(path.join(workerDataDir(), SET_ASIDE))).toBe(true);
  const safety = fs.readdirSync(workerDataDir()).filter((f) => f.startsWith('pre-recover-'));
  expect(safety.length).toBeGreaterThan(0);
});

test('the group is absent when there is nothing to recover', async ({ page }) => {
  // The normal state of every install. A "Recovery" heading over nothing is a
  // question with no answer (NEWS-307).
  fs.rmSync(path.join(workerDataDir(), SET_ASIDE), { force: true });
  await page.goto('/');
  await openSettingsTab(page, 'Data');

  await expect(page.locator('.recover-row')).toHaveCount(0, { timeout: 20_000 });
  await expect(page.locator('.settings-panel')).not.toContainText('Recovery');
});

test.afterAll(async () => {
  // This file replaced the whole database; put the server back for the next one.
  const dir = workerDataDir();
  fs.rmSync(path.join(dir, SET_ASIDE), { force: true });
  for (const f of fs.readdirSync(dir).filter((n) => n.startsWith('pre-recover-'))) {
    fs.rmSync(path.join(dir, f), { force: true });
  }
  await resetSharedState(workerBaseURL());
});
