import type { Page } from '@playwright/test';

import { acceptConfirm, expect, openSettingsTab, test, topicAction } from './fixtures.js';

// Runs against the shared server from playwright.config.ts, which sets
// NEWSMONGER_FAKE_KEYCHAIN=1 — the save/remove flows below are real all the way to
// the store, but the store is in-memory rather than the developer's keychain.
//
// Serial and stateful: each test leaves the keys as it found them so the rest
// of the suite (and app.spec.ts) sees an unconfigured app.

test.describe.configure({ mode: 'serial' });

const ANTHROPIC_ROW = '.key-row:has-text("Anthropic")';
const OPENAI_ROW = '.key-row:has-text("OpenAI")';
const SECRET = 'sk-ant-e2e-secret-0123456789';

/**
 * Everything in this spec lives on the Source tab since NEWS-118 — the provider
 * picker and the API keys are the same question ("who do we ask"), so the whole
 * file opens there.
 */
async function openSettings(page: Page): Promise<void> {
  await openSettingsTab(page, 'Source');
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
  // `spellcheck` is an *enumerated* attribute, so the boolean form kerf ≤3 accepted
  // (`spellcheck={false}`) emitted nothing at all and left the browser default in
  // place (NEWS-123). Assert the rendered value, which only the keyword form produces.
  await expect(page.locator(`${ANTHROPIC_ROW} .key-input`)).toHaveAttribute('spellcheck', 'false');
});

test('a key saves itself on blur, with no Save button (NEWS-156)', async ({ page }) => {
  await page.goto('/');
  await openSettings(page);

  // The button is gone, not merely bypassed.
  await expect(page.locator(`${ANTHROPIC_ROW} button[type=submit]`)).toHaveCount(0);

  await page.fill(`${ANTHROPIC_ROW} .key-input`, 'sk-ant-autosave-blur');
  await page.locator(`${ANTHROPIC_ROW} .key-input`).blur();
  await expect(page.locator(`${ANTHROPIC_ROW} .key-state.ok`)).toContainText('stored in');

  await page.click(`${ANTHROPIC_ROW} [data-remove-key]`);
  await acceptConfirm(page);
  await expect(page.locator(`${ANTHROPIC_ROW} .key-input`)).toBeVisible();
});

test('Enter saves a key too, and does not save it twice (NEWS-156)', async ({ page }) => {
  // Enter in a single-input form fires `submit` *and* `change`, so both handlers
  // run for one keypress. `commitKey` empties the field before awaiting, so the
  // second sees a blank field and stops — without that, one Enter sends two
  // vendor verifications and two keychain writes (measured: 2 PUTs).
  //
  // Counting the requests rather than checking the key ended up stored: it ends
  // up stored either way, so the obvious assertion passes on the bug.
  const writes: string[] = [];
  await page.route('**/api/keys/**', (route) => {
    if (route.request().method() === 'PUT') writes.push(route.request().url());
    void route.continue();
  });

  await page.goto('/');
  await openSettings(page);

  await page.fill(`${OPENAI_ROW} .key-input`, 'sk-openai-by-enter');
  await page.press(`${OPENAI_ROW} .key-input`, 'Enter');
  await expect(page.locator(`${OPENAI_ROW} .key-state.ok`)).toContainText('stored in');
  await expect(page.locator(`${OPENAI_ROW} .key-input`)).toHaveCount(0);
  expect(writes).toHaveLength(1);

  await page.click(`${OPENAI_ROW} [data-remove-key]`);
  await acceptConfirm(page);
  await expect(page.locator(`${OPENAI_ROW} .key-input`)).toBeVisible();
});

test('blurring an untouched field saves nothing (NEWS-156)', async ({ page }) => {
  // Clicking into the field and away again is not a request to store anything,
  // and an empty PUT would read as "clear my key".
  await page.goto('/');
  await openSettings(page);

  await page.locator(`${ANTHROPIC_ROW} .key-input`).click();
  await page.locator(`${ANTHROPIC_ROW} .key-input`).blur();
  await expect(page.locator(`${ANTHROPIC_ROW} .key-input`)).toBeVisible();
  await expect(page.locator(`${ANTHROPIC_ROW} .key-state.ok`)).toHaveCount(0);
});

test('saving a key stores it and swaps the field for a status line', async ({ page }) => {
  await page.goto('/');
  await openSettings(page);

  await page.fill(`${ANTHROPIC_ROW} .key-input`, SECRET);
  await page.locator(`${ANTHROPIC_ROW} .key-input`).blur();

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
  await openSettings(page);

  await page.click(`${ANTHROPIC_ROW} [data-remove-key]`);
  await acceptConfirm(page);
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
  await openSettings(page);

  await page.fill(`${OPENAI_ROW} .key-input`, 'sk-openai-first');
  await page.locator(`${OPENAI_ROW} .key-input`).blur();
  await expect(page.locator(`${OPENAI_ROW} .key-state`)).toContainText('stored in');

  await page.click(`${OPENAI_ROW} [data-remove-key]`);
  await acceptConfirm(page);
  await expect(page.locator(`${OPENAI_ROW} .key-input`)).toBeVisible();

  await page.fill(`${OPENAI_ROW} .key-input`, 'sk-openai-second');
  await page.locator(`${OPENAI_ROW} .key-input`).blur();
  await expect(page.locator(`${OPENAI_ROW} .key-state`)).toContainText('stored in');

  await page.click(`${OPENAI_ROW} [data-remove-key]`);
  await acceptConfirm(page);
  await expect(page.locator(`${OPENAI_ROW} .key-input`)).toBeVisible();
});

test('an empty key submission is ignored', async ({ page }) => {
  await page.goto('/');
  await openSettings(page);

  await page.fill(`${OPENAI_ROW} .key-input`, '   ');
  await page.locator(`${OPENAI_ROW} .key-input`).blur();

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

  await topicAction(page, page.locator('.topic', { hasText: 'Dialog Structural Check' }), 'delete');
  await expect(page.locator('.topic')).toHaveCount(before - 1);
});
