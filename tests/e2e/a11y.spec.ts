import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

import { expect, test } from './fixtures.js';

// Accessibility regression net (NEWS-90). Runs axe against the real rendered
// app in both colour schemes, then checks the keyboard paths axe cannot see —
// axe finds missing labels and poor contrast, but it can't tell you that the
// only route to a topic's actions is a right-click.

test.describe.configure({ mode: 'serial' });

/** Serious/critical only: axe's "minor" bucket is mostly advisory. */
async function scan(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  return results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
}

test('the main view has no serious accessibility violations (light)', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  await expect(page.locator('h1')).toBeVisible();
  expect(await scan(page)).toEqual([]);
});

test('...and none in dark mode either', async ({ page }) => {
  // Contrast is theme-specific, so a single-theme scan proves half the point.
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  await expect(page.locator('h1')).toBeVisible();
  expect(await scan(page)).toEqual([]);
});

test('the settings dialog has no serious accessibility violations', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  await page.click('[data-action=open-settings]');
  await expect(page.locator('.dialog')).toBeVisible();
  expect(await scan(page)).toEqual([]);
  await page.locator('.dialog [data-action=close-settings]').click();
});

test('topic rows are reachable and operable from the keyboard (NEWS-90)', async ({ page }) => {
  await page.goto('/');
  await page.fill('.add-topic input', 'Keyboard Topic');
  await page.press('.add-topic input', 'Enter');
  const row = page.locator('.topic', { hasText: 'Keyboard Topic' });
  await expect(row).toBeVisible();

  // Focusable, and Enter selects — neither was true when the row was a plain
  // <li> with a click handler.
  await row.focus();
  await page.keyboard.press('Enter');
  await expect(row).toHaveClass(/selected/);

  // Shift+F10 opens the same menu the right-click does, anchored to the row.
  await page.keyboard.press('Shift+F10');
  await expect(page.locator('.menu')).toBeVisible();
  await expect(page.locator('[data-menu-action=check]')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.locator('.menu')).toHaveCount(0);
});

test('Escape closes each dialog, innermost first (NEWS-90)', async ({ page }) => {
  await page.goto('/');
  const row = page.locator('.topic', { hasText: 'Keyboard Topic' });
  await row.click({ button: 'right' });
  await page.locator('[data-menu-action=guidance]').click();
  await expect(page.locator('.dialog.guidance')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.dialog.guidance')).toHaveCount(0);

  await page.click('[data-action=open-settings]');
  await expect(page.locator('.dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.dialog')).toHaveCount(0);
});

test('Tab stays inside an open dialog (NEWS-90)', async ({ page }) => {
  await page.goto('/');
  await page.click('[data-action=open-settings]');
  const dialog = page.locator('.dialog');
  await expect(dialog).toBeVisible();

  // Tab a generous number of times; focus must never escape the dialog. Without
  // the trap it walks out into the page behind within a handful of presses.
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press('Tab');
    const inside = await dialog.evaluate((el) => el.contains(document.activeElement));
    expect(inside, `focus left the dialog after ${String(i + 1)} tabs`).toBe(true);
  }

  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('clean up the topic this spec created', async ({ page }) => {
  await page.goto('/');
  const row = page.locator('.topic', { hasText: 'Keyboard Topic' });
  if ((await row.count()) === 0) return;
  await row.click();
  await page.keyboard.press('Delete');
  await page.locator('[data-action=confirm-ok]').click();
  await expect(row).toHaveCount(0);
});
