import type { Page } from '@playwright/test';

import { expect, test } from './fixtures.js';

// Tests run serially against one shared server (see playwright.config.ts) and
// build on each other's state where noted. The server runs with --ai-test, so
// news checks return the same two deterministic stories per topic every time —
// which lets us assert deduplication end-to-end.

test.describe.configure({ mode: 'serial' });

/** Settings (interval, provider, model/endpoint, API keys) live in a dialog. */
async function openSettings(page: Page): Promise<void> {
  await page.click('[data-action=open-settings]');
  await expect(page.locator('.dialog')).toBeVisible();
}

async function closeSettings(page: Page): Promise<void> {
  await page.locator('.dialog [data-action=close-settings]').click();
  await expect(page.locator('.dialog')).toHaveCount(0);
}

test('loads the app shell', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('h1')).toHaveText('News.');
  await expect(page.locator('.add-topic input')).toBeVisible();
});

test('adds a topic and shows it in the list', async ({ page }) => {
  await page.goto('/');
  await page.fill('.add-topic input', 'Fusion Energy');
  await page.click('.add-topic button[type=submit]');
  await expect(page.locator('.topic-name')).toHaveText(['Fusion Energy']);
  // No assertion on the "checked" status here: the scheduler's startup sweep
  // may legitimately check a brand-new topic within seconds.
});

test('rejects a duplicate topic with an error banner', async ({ page }) => {
  await page.goto('/');
  await page.fill('.add-topic input', 'fusion energy');
  await page.click('.add-topic button[type=submit]');
  await expect(page.locator('.banner.error')).toContainText('already exists');
  await expect(page.locator('.topic')).toHaveCount(1);
});

test('check now finds stories with summaries and source links', async ({ page }) => {
  await page.goto('/');
  await page.click('[data-check-topic]');
  await expect(page.locator('.item')).toHaveCount(2, { timeout: 15_000 });
  const first = page.locator('.item').first();
  await expect(first.locator('h3')).toContainText('Fusion Energy');
  await expect(first.locator('p')).not.toBeEmpty();
  const link = first.locator('.sources a').first();
  await expect(link).toHaveAttribute('href', /https:\/\//);
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(page.locator('.topic-meta').first()).toContainText('checked');
});

test('a second check deduplicates already-seen stories', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.item')).toHaveCount(2);
  await page.click('[data-check-topic]');
  // Wait for the check to finish (button re-enables), then confirm no new items.
  await expect(page.locator('[data-check-topic]')).toBeEnabled({ timeout: 15_000 });
  await page.waitForTimeout(500);
  await expect(page.locator('.item')).toHaveCount(2);
});

test('changing the check interval persists across reload', async ({ page }) => {
  await page.goto('/');
  await openSettings(page);
  await page.selectOption('[data-action=interval]', { label: 'Every hour' });
  await expect(page.locator('[data-action=interval]')).toHaveValue('3600000');
  await page.reload();
  await openSettings(page);
  await expect(page.locator('[data-action=interval]')).toHaveValue('3600000');
});

test('pausing a topic marks it paused', async ({ page }) => {
  await page.goto('/');
  await page.click('[data-toggle-topic]');
  await expect(page.locator('.topic')).toHaveClass(/paused/);
  await expect(page.locator('.topic-meta').first()).toContainText('paused');
  await page.click('[data-toggle-topic]');
  await expect(page.locator('.topic')).not.toHaveClass(/paused/);
});

test('check all works from the header', async ({ page }) => {
  await page.goto('/');
  await page.fill('.add-topic input', 'Quantum Computing');
  await page.click('.add-topic button[type=submit]');
  await expect(page.locator('.topic')).toHaveCount(2);

  await page.click('[data-action=check-all]');
  // The new topic's two stories join the existing two.
  await expect(page.locator('.item')).toHaveCount(4, { timeout: 15_000 });
  await expect(page.locator('.item-topic').first()).toBeVisible();
});

test('a failing topic surfaces a warning banner', async ({ page }) => {
  await page.goto('/');
  await page.fill('.add-topic input', 'this will fail');
  await page.click('.add-topic button[type=submit]');
  const row = page.locator('.topic', { hasText: 'this will fail' });
  await row.locator('[data-check-topic]').click();
  await expect(page.locator('.banner.warn')).toContainText('failed', { timeout: 15_000 });
  // Clean up so later tests aren't affected.
  page.on('dialog', (d) => void d.accept());
  await row.locator('[data-delete-topic]').click();
  await expect(page.locator('.topic')).toHaveCount(2);
});

test('the provider picker persists a choice across reload', async ({ page }) => {
  await page.goto('/');
  await openSettings(page);
  await expect(page.locator('[data-action=provider]')).toBeVisible();

  await page.selectOption('[data-action=provider]', 'openai');
  // OpenAI is endpoint-configurable, so the endpoint field appears.
  await expect(page.locator('[data-action=endpoint]')).toBeVisible();
  await page.reload();
  await openSettings(page);
  await expect(page.locator('[data-action=provider]')).toHaveValue('openai');

  // Reset to auto so later tests aren't affected. (Checks still run the mock
  // provider — the server is in --ai-test — regardless of this setting.)
  await page.selectOption('[data-action=provider]', 'auto');
  await expect(page.locator('[data-action=endpoint]')).toHaveCount(0);
  await closeSettings(page);
});

test('deleting a topic removes its stories from the feed', async ({ page }) => {
  await page.goto('/');
  page.on('dialog', (d) => void d.accept());
  const row = page.locator('.topic', { hasText: 'Quantum Computing' });
  await row.locator('[data-delete-topic]').click();
  await expect(page.locator('.topic')).toHaveCount(1);
  await expect(page.locator('.item')).toHaveCount(2);
  await expect(page.locator('.item-topic').first()).not.toContainText('Quantum');
});

test('the client reports foreground so scheduled checks may run', async ({ page }) => {
  // Subscription-backed providers only run scheduled checks while the app is
  // in front of someone (src/attendance.ts). This asserts the client half of
  // that contract: the heartbeat is sent on load, and again on regaining
  // focus. The gate decision itself is unit-tested in attendance.test.ts,
  // where attendance can actually be made stale.
  const beats: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/foreground')) beats.push(r.method());
  });

  await page.goto('/');
  await expect.poll(() => beats.length).toBeGreaterThan(0);
  expect(beats[0]).toBe('POST');

  const afterLoad = beats.length;
  await page.evaluate(() => { window.dispatchEvent(new Event('focus')); });
  await expect.poll(() => beats.length).toBeGreaterThan(afterLoad);
});
