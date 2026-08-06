import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Page } from '@playwright/test';

import { expect, resetSharedState, test, workerBaseURL } from './fixtures.js';

/**
 * The backup offer, end to end (NEWS-230, FR-27.2–27.5).
 *
 * Every other spec suppresses this dialog in `resetSharedState` — it fires on the
 * third topic and would swallow clicks in tests that have nothing to do with
 * backups. This one clears the flag and drives the real thing.
 *
 * Serial and self-contained: it creates its own topics and answers the dialog
 * every time, so it never leaves a modal standing for whatever runs next.
 */
test.describe.configure({ mode: 'serial' });

const baseURL = (): string => workerBaseURL();

/** Clear both dismissal flags, so the offer is armed again. */
async function armOffer(): Promise<void> {
  await fetch(`${baseURL()}/api/settings`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ backupPromptNever: false, backupPromptSnoozedUntil: '', backupDir: '' }),
  });
}

async function addTopics(page: Page, names: string[]): Promise<void> {
  for (const name of names) {
    await page.fill('.add-topic input', name);
    await page.click('.add-topic button[type=submit]');
    await expect(page.locator(`.topic-name:has-text("${name}")`)).toBeVisible();
  }
}

test.beforeEach(async () => {
  await resetSharedState(baseURL());
  await armOffer();
});

test.afterAll(async () => {
  // Leave the shared server the way every other spec expects to find it.
  await resetSharedState(baseURL());
});

test('does not appear before the third topic, then does (FR-27.2)', async ({ page }) => {
  // Counting `/api/state` responses, not sleeping: the offer is decided on each
  // poll, so "two polls have happened and it still isn't there" is the real
  // claim. A fixed wait would assert nothing except that time passed.
  let statePolls = 0;
  page.on('response', (r) => {
    if (r.url().includes('/api/state')) statePolls += 1;
  });

  await page.goto('/');
  await addTopics(page, ['Backup One', 'Backup Two']);
  // Two topics: the app has not earned the right to interrupt yet.
  await expect.poll(() => statePolls, { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
  await expect(page.locator('.backup-offer')).toHaveCount(0);

  await addTopics(page, ['Backup Three']);
  await expect(page.locator('.backup-offer')).toBeVisible();
  await expect(page.locator('.backup-offer h2')).toContainText('Keep a backup');

  // The copy promises a backup, never a move — the live database stays local,
  // and saying otherwise would promise the thing the design refuses.
  const body = (await page.locator('.backup-offer').textContent()) ?? '';
  expect(body).not.toMatch(/move your data|moves your data/i);
  expect(body).toMatch(/API keys are never included/i);

  await page.click('[data-action=backup-offer-never]');
  await expect(page.locator('.backup-offer')).toHaveCount(0);
});

test('an outside click does not dismiss it (FR-27.3)', async ({ page }) => {
  await page.goto('/');
  await addTopics(page, ['Outside One', 'Outside Two', 'Outside Three']);
  await expect(page.locator('.backup-offer')).toBeVisible();

  // The backdrop, well clear of the dialog. Every other dialog in the app closes
  // on this; this one must not, because a stray click is not an answer and the
  // two real answers differ in whether it ever asks again.
  await page.locator('.dialog-backdrop').click({ position: { x: 5, y: 5 } });
  await expect(page.locator('.backup-offer')).toBeVisible();

  // Escape is not an exit either, for the same reason.
  await page.keyboard.press('Escape');
  await expect(page.locator('.backup-offer')).toBeVisible();

  await page.click('[data-action=backup-offer-never]');
  await expect(page.locator('.backup-offer')).toHaveCount(0);
});

test('"Don\'t ask again" is permanent, across a reload (FR-27.4)', async ({ page }) => {
  await page.goto('/');
  await addTopics(page, ['Never One', 'Never Two', 'Never Three']);
  await expect(page.locator('.backup-offer')).toBeVisible();
  await page.click('[data-action=backup-offer-never]');
  await expect(page.locator('.backup-offer')).toHaveCount(0);

  // A reload is the cheap way to prove it is stored server-side rather than
  // held in a signal — and adding a fourth topic re-runs the whole decision.
  await page.reload();
  await addTopics(page, ['Never Four']);
  await expect(page.locator('.backup-offer')).toHaveCount(0);
});

test('"Not now" also holds across a reload (FR-27.4)', async ({ page }) => {
  await page.goto('/');
  await addTopics(page, ['Later One', 'Later Two', 'Later Three']);
  await expect(page.locator('.backup-offer')).toBeVisible();
  await page.click('[data-action=backup-offer-later]');
  await expect(page.locator('.backup-offer')).toHaveCount(0);

  await page.reload();
  await addTopics(page, ['Later Four']);
  await expect(page.locator('.backup-offer')).toHaveCount(0);

  // ...and it is a *snooze*, not a permanent no — the stored timestamp is what
  // makes it lapse tomorrow. (The lapse itself is unit-tested; asserting it here
  // would mean either waiting a day or faking the browser's clock.)
  const settings = (await (await fetch(`${baseURL()}/api/state`)).json()) as {
    settings: { backupPromptNever: boolean; backupPromptSnoozedUntil: string };
  };
  expect(settings.settings.backupPromptNever).toBe(false);
  expect(Date.parse(settings.settings.backupPromptSnoozedUntil)).toBeGreaterThan(Date.now());
});

test('a typed ~ path is resolved, not taken literally (NEWS-237)', async ({ page }) => {
  await page.goto('/');
  await addTopics(page, ['Tilde One', 'Tilde Two', 'Tilde Three']);
  await expect(page.locator('.backup-offer')).toBeVisible();

  // The most natural thing to type. Stored verbatim it would create a literal
  // `~` directory beside the server and report success, which is the failure
  // that only shows up when the backup is needed.
  await page.fill('[data-action=backup-offer-input]', '~/nm-tilde-e2e');
  await page.click('[data-action=backup-offer-save]');
  await expect(page.locator('.backup-offer')).toHaveCount(0);

  const settings = (await (await fetch(`${baseURL()}/api/state`)).json()) as {
    settings: { backupDir: string };
  };
  expect(settings.settings.backupDir.startsWith('~')).toBe(false);
  expect(settings.settings.backupDir).toContain('nm-tilde-e2e');
  expect(path.isAbsolute(settings.settings.backupDir)).toBe(true);

  // Turn backups off **before** deleting the folder (NEWS-312).
  //
  // Saving a folder also writes a first snapshot into it (FR-27.4), and that
  // write is still in flight here. Deleting first raced it: the backup failed,
  // the server answered 500, and the client's unhandled rejection surfaced as an
  // uncaught page error in whichever test was running when it landed — a failure
  // that moved between runs and named an innocent spec.
  //
  // The client bug is fixed and guarded (`tests/unit/unhandled-rejection.test.ts`),
  // so this ordering is no longer load-bearing for *correctness*. It stays because
  // a test should not deliberately provoke a failure it is not asserting on.
  await fetch(`${baseURL()}/api/settings`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ backupDir: '' }),
  });
  fs.rmSync(settings.settings.backupDir, { recursive: true, force: true });
});

test('choosing a folder saves it and writes a backup (FR-27.2, FR-27.6)', async ({ page }) => {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'newsmonger-offer-e2e-'));
  await page.goto('/');
  await addTopics(page, ['Save One', 'Save Two', 'Save Three']);
  await expect(page.locator('.backup-offer')).toBeVisible();

  // Saving nothing is not an answer — it would close the dialog having changed
  // nothing and, since the offer only fires once, quietly never ask again.
  await page.click('[data-action=backup-offer-save]');
  await expect(page.locator('.backup-offer')).toBeVisible();
  await expect(page.locator('.toast')).toContainText('Choose a folder');

  await page.fill('[data-action=backup-offer-input]', dest);
  await page.click('[data-action=backup-offer-save]');
  await expect(page.locator('.backup-offer')).toHaveCount(0);

  // The folder reaches Settings → Data, and a snapshot actually lands.
  await expect
    .poll(() => fs.existsSync(path.join(dest, 'newsmonger-backup.json')), { timeout: 15_000 })
    .toBe(true);
  const backup = JSON.parse(
    fs.readFileSync(path.join(dest, 'newsmonger-backup.json'), 'utf8'),
  ) as { topics: { name: string }[]; settings: Record<string, unknown> };
  expect(backup.settings['backupDir']).toBe(dest);
  expect(backup.topics.map((t) => t.name)).toContain('Save Three');

  // Turn it back off so later specs start from the default.
  await fetch(`${baseURL()}/api/settings`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ backupDir: '' }),
  });
  fs.rmSync(dest, { recursive: true, force: true });
});
