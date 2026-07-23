import type { Page } from '@playwright/test';

import { expect, test } from './fixtures.js';

// Runs against the shared server from playwright.config.ts, which sets
// NEWS_FAKE_KEYCHAIN=1 — the save/remove flows below are real all the way to
// the store, but the store is in-memory rather than the developer's keychain.
//
// Serial and stateful: each test leaves the keys as it found them so the rest
// of the suite (and app.spec.ts) sees an unconfigured app.

test.describe.configure({ mode: 'serial' });

const ANTHROPIC_ROW = '.key-row:has-text("Anthropic")';
const OPENAI_ROW = '.key-row:has-text("OpenAI")';
const SECRET = 'sk-ant-e2e-secret-0123456789';

async function openSettings(page: Page): Promise<void> {
  await page.click('[data-action=open-settings]');
  await expect(page.locator('.dialog')).toBeVisible();
}

test('the settings dialog opens and closes', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.dialog')).toHaveCount(0);

  await openSettings(page);
  await expect(page.locator('.dialog h2')).toHaveText('Settings');

  await page.locator('.dialog [data-action=close-settings]').click();
  await expect(page.locator('.dialog')).toHaveCount(0);
});

test('clicking the backdrop closes the dialog, clicking inside does not', async ({ page }) => {
  await page.goto('/');
  await openSettings(page);

  // A click inside must not dismiss — the dialog is nested in the backdrop, so
  // this is exactly the case that broke when both shared one close action.
  await page.locator('.dialog h2').click();
  await expect(page.locator('.dialog')).toBeVisible();

  // Well outside the dialog box.
  await page.locator('.dialog-backdrop').click({ position: { x: 5, y: 5 } });
  await expect(page.locator('.dialog')).toHaveCount(0);
});

test('lists both keyed providers as unconfigured', async ({ page }) => {
  await page.goto('/');
  await openSettings(page);

  await expect(page.locator('.key-row')).toHaveCount(2);
  await expect(page.locator(`${ANTHROPIC_ROW} .key-input`)).toBeVisible();
  await expect(page.locator(`${OPENAI_ROW} .key-input`)).toBeVisible();
  // Keys must never render as readable text.
  await expect(page.locator(`${ANTHROPIC_ROW} .key-input`)).toHaveAttribute('type', 'password');
});

test('saving a key stores it and swaps the field for a status line', async ({ page }) => {
  await page.goto('/');
  await openSettings(page);

  await page.fill(`${ANTHROPIC_ROW} .key-input`, SECRET);
  await page.click(`${ANTHROPIC_ROW} button[type=submit]`);

  await expect(page.locator(`${ANTHROPIC_ROW} .key-state`)).toContainText('stored in');
  // With a key stored there is no input at all — nothing to read back.
  await expect(page.locator(`${ANTHROPIC_ROW} .key-input`)).toHaveCount(0);
  await expect(page.locator(`${ANTHROPIC_ROW} [data-remove-key]`)).toBeVisible();

  // The saved value must not survive anywhere in the page.
  expect(await page.content()).not.toContain(SECRET);
});

test('a stored key makes the provider available', async ({ page }) => {
  await page.goto('/');
  await openSettings(page);
  await page.selectOption('[data-action=provider]', 'anthropic');

  await expect(page.locator('.source-status')).toContainText('ready');
});

test('the stored key survives a reload', async ({ page }) => {
  await page.goto('/');
  await openSettings(page);
  await expect(page.locator(`${ANTHROPIC_ROW} .key-state`)).toContainText('stored in');
  await expect(page.locator(`${ANTHROPIC_ROW} .key-input`)).toHaveCount(0);
});

test('removing a key restores the input', async ({ page }) => {
  await page.goto('/');
  page.on('dialog', (d) => void d.accept());
  await openSettings(page);

  await page.click(`${ANTHROPIC_ROW} [data-remove-key]`);
  await expect(page.locator(`${ANTHROPIC_ROW} .key-input`)).toBeVisible();
  await expect(page.locator(`${ANTHROPIC_ROW} .key-state`)).toHaveCount(0);
});

test('a removed key makes the provider unavailable again', async ({ page }) => {
  await page.goto('/');
  await openSettings(page);
  await expect(page.locator('[data-action=provider]')).toHaveValue('anthropic');

  await expect(page.locator('.source-status')).toContainText('no API key');

  // Leave the app as the rest of the suite expects it.
  await page.selectOption('[data-action=provider]', 'auto');
});

test('saving, removing and re-saving leaves a working key', async ({ page }) => {
  // The transition a single save test never reaches: the row has to move
  // through all three states and come back with the field wired up again.
  await page.goto('/');
  page.on('dialog', (d) => void d.accept());
  await openSettings(page);

  await page.fill(`${OPENAI_ROW} .key-input`, 'sk-openai-first');
  await page.click(`${OPENAI_ROW} button[type=submit]`);
  await expect(page.locator(`${OPENAI_ROW} .key-state`)).toContainText('stored in');

  await page.click(`${OPENAI_ROW} [data-remove-key]`);
  await expect(page.locator(`${OPENAI_ROW} .key-input`)).toBeVisible();

  await page.fill(`${OPENAI_ROW} .key-input`, 'sk-openai-second');
  await page.click(`${OPENAI_ROW} button[type=submit]`);
  await expect(page.locator(`${OPENAI_ROW} .key-state`)).toContainText('stored in');

  await page.click(`${OPENAI_ROW} [data-remove-key]`);
  await expect(page.locator(`${OPENAI_ROW} .key-input`)).toBeVisible();
});

test('an empty key submission is ignored', async ({ page }) => {
  await page.goto('/');
  await openSettings(page);

  await page.fill(`${OPENAI_ROW} .key-input`, '   ');
  await page.click(`${OPENAI_ROW} button[type=submit]`);

  // Still unconfigured, and no error banner — nothing was attempted.
  await expect(page.locator(`${OPENAI_ROW} .key-input`)).toBeVisible();
  await expect(page.locator('.key-notes .banner')).toHaveCount(0);
});

test('the topics list survives opening and closing the dialog', async ({ page }) => {
  // Guards the kerf structural rule (KF-377): a conditional sibling appearing
  // and disappearing must not empty the keyed topics list beside it.
  await page.goto('/');
  await page.fill('.add-topic input', 'Dialog Structural Check');
  await page.press('.add-topic input', 'Enter');
  await expect(page.locator('.topic', { hasText: 'Dialog Structural Check' })).toBeVisible();

  const before = await page.locator('.topic').count();
  for (let i = 0; i < 3; i++) {
    await openSettings(page);
    await page.locator('.dialog [data-action=close-settings]').click();
    await expect(page.locator('.dialog')).toHaveCount(0);
  }
  await expect(page.locator('.topic')).toHaveCount(before);

  page.on('dialog', (d) => void d.accept());
  await page.locator('.topic', { hasText: 'Dialog Structural Check' }).locator('[data-delete-topic]').click();
  await expect(page.locator('.topic')).toHaveCount(before - 1);
});
