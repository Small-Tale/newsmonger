import type { Page } from '@playwright/test';

import { expect, resetTopics, test } from './fixtures.js';

// Wide-window layout (NEWS-96). The shell used to be capped at 1060px and
// centred, which left the feed at a fixed ~650px no matter how much room the
// window had. These tests assert the two halves of the fix: the shell fills the
// window, and the extra room becomes extra story columns.
//
// This is a CSS-only feature, so there is nothing to unit test — a rendered
// layout is the only place the behaviour exists. Measuring it here is also the
// only way it can regress *noisily*: a stray `max-width` would otherwise sail
// through every other test in the suite.

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  await resetTopics(test.info().project.use.baseURL ?? '');
});

const TOPICS = ['Layout One', 'Layout Two', 'Layout Three', 'Layout Four'];

/**
 * Story cards on the topmost row of the first day group — i.e. the column
 * count. Read from the live geometry rather than from the CSS, so it reflects
 * what a reader would actually see.
 */
async function measure(page: Page): Promise<{
  shellLeft: number;
  shellWidth: number;
  columns: number;
  scrollWidth: number;
}> {
  return page.evaluate(() => {
    const shell = document.querySelector('.shell');
    const rect = shell?.getBoundingClientRect();
    const cards = [...(document.querySelector('.day')?.querySelectorAll(':scope > .item') ?? [])];
    const tops = cards.map((c) => Math.round(c.getBoundingClientRect().top));
    const first = tops.length > 0 ? Math.min(...tops) : 0;
    return {
      shellLeft: Math.round(rect?.left ?? -1),
      shellWidth: Math.round(rect?.width ?? -1),
      columns: tops.filter((t) => t === first).length,
      scrollWidth: document.documentElement.scrollWidth,
    };
  });
}

test('set up topics with stories to lay out', async ({ page }) => {
  await page.goto('/');
  for (const name of TOPICS) {
    await page.fill('.add-topic input', name);
    await page.press('.add-topic input', 'Enter');
    await expect(page.locator('.topic', { hasText: name })).toBeVisible();
  }
  // The mock provider files two stories per topic on the check that a new topic
  // triggers; the column assertions below need enough cards to fill a row.
  await expect.poll(async () => page.locator('.day > .item').count()).toBeGreaterThanOrEqual(8);
});

test('the shell fills the window instead of centring (NEWS-96)', async ({ page }) => {
  for (const width of [1280, 1920, 2560]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/');
    await expect(page.locator('.day > .item').first()).toBeVisible();

    const m = await measure(page);
    expect(m.shellLeft, `flush left at ${width}px`).toBe(0);
    expect(m.shellWidth, `full width at ${width}px`).toBe(width);
    // Filling the width must not mean overflowing it.
    expect(m.scrollWidth, `no horizontal overflow at ${width}px`).toBe(width);
  }
});

test('extra window width becomes extra story columns (NEWS-96)', async ({ page }) => {
  const columnsAt = async (width: number): Promise<number> => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/');
    await expect(page.locator('.day > .item').first()).toBeVisible();
    return (await measure(page)).columns;
  };

  // The exact thresholds are a styling decision and may be tuned; what must
  // hold is that more room never means fewer columns, and that a wide monitor
  // genuinely gets more than a laptop.
  const narrow = await columnsAt(1100);
  const laptop = await columnsAt(1440);
  const wide = await columnsAt(2560);

  expect(narrow).toBe(1);
  expect(laptop).toBeGreaterThan(narrow);
  expect(wide).toBeGreaterThan(laptop);
});

test('clean up the layout topics', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await resetTopics(test.info().project.use.baseURL ?? '');
  await page.goto('/');
  for (const name of TOPICS) {
    await expect(page.locator('.topic', { hasText: name })).toHaveCount(0);
  }
});
