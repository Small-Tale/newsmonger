import AxeBuilder from '@axe-core/playwright';

import { expect, resetSharedState, seedCheckedTopic, test, topicAction, workerBaseURL } from './fixtures.js';

test.describe.configure({ mode: 'serial' });

const TOPIC = 'Energy pulse thread';

test.beforeAll(async () => {
  await resetSharedState(workerBaseURL());
  await seedCheckedTopic(workerBaseURL(), TOPIC);
});

test('solo reveals a compact deterministic pulse and a full 7/30/90-day drill-down', async ({ page }) => {
  await page.goto('/');
  const topic = page.locator('.topic', { hasText: TOPIC });
  await expect(topic).toBeVisible();
  await expect(topic.locator('.topic-sparkline')).toBeVisible();
  await expect(topic.locator('.topic-sparkline')).toHaveAttribute('aria-label', /2 stories in the last 7 days/);

  await topicAction(page, topic, 'solo');
  const compact = page.locator('.compact-pulse');
  await expect(compact).toBeVisible();
  await expect(compact).toContainText('30-day pulse');
  await expect(compact).toContainText('2 stories');
  await expect(compact).toContainText('news.example.com');
  await expect(compact).not.toContainText('top source');
  await expect(compact).toContainText('Small sample');
  await expect(page.locator('.banner.solo')).toBeVisible();

  await compact.locator('[data-open-pulse-kind]').click();
  const dialog = page.locator('.pulse-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('#pulse-dialog-title')).toHaveText(TOPIC);
  await expect(dialog.locator('.pulse-stat-grid')).toContainText('2');
  await expect(dialog.locator('.pulse-stat-grid')).toContainText('news.example.com');
  await expect(dialog.locator('[data-pulse-days="30"]')).toHaveClass(/active/);
  await expect(dialog).toContainText('No AI analysis');

  await dialog.locator('summary', { hasText: 'View data table' }).click();
  await expect(dialog.locator('.pulse-table-wrap table')).toBeVisible();
  await dialog.locator('[data-pulse-days="7"]').click();
  await expect(dialog.locator('[data-pulse-days="7"]')).toHaveClass(/active/);
  await expect(dialog.locator('.pulse-bars .pulse-day')).toHaveCount(7);

  const violations = (await new AxeBuilder({ page }).include('.pulse-dialog').analyze()).violations.filter(
    (violation) => violation.impact === 'serious' || violation.impact === 'critical',
  );
  expect(violations).toEqual([]);

  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('category rollup opens the same drill-down and the compact hierarchy fits a mobile viewport', async ({ page }) => {
  await page.goto('/');
  await page.locator('[data-filter-category="environment"]').click();
  const rollup = page.locator('.category-pulse');
  await expect(rollup).toBeVisible();
  await expect(rollup).toContainText('Environment');
  await expect(rollup).toContainText('2 stories · last 30 days');
  await rollup.click();
  await expect(page.locator('.pulse-dialog #pulse-dialog-title')).toContainText('Environment');
  await page.keyboard.press('Escape');

  await page.setViewportSize({ width: 420, height: 900 });
  const topic = page.locator('.topic', { hasText: TOPIC });
  await topicAction(page, topic, 'solo');
  await expect(page.locator('.compact-pulse')).toBeVisible();
  await expect(page.locator('.compact-pulse [data-open-pulse-kind]')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
