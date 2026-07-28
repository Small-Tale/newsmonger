import { expect, resetTopics, test } from './fixtures.js';

// The section filter bar and sidebar pills (NEWS-97, FR-22.9/22.10).
//
// The mock provider classifies from the topic name, so these names are also the
// expected sections: "Soccer transfers" → Sports · Soccer, "Fashion week" →
// Style · Fashion. A name containing "uncategorized" makes it decline, which is
// how the Uncategorized pill gets something to select.

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  await resetTopics(test.info().project.use.baseURL ?? '');
});

const TOPICS = ['Soccer transfers', 'Tennis majors', 'Fashion week', 'An uncategorized thing'];

test('set up topics that classify themselves', async ({ page }) => {
  await page.goto('/');
  for (const name of TOPICS) {
    await page.fill('.add-topic input', name);
    await page.press('.add-topic input', 'Enter');
    await expect(page.locator('.topic', { hasText: name })).toBeVisible();
  }
  // Classification lands on the check the new topic triggers.
  await expect(page.locator('.topic', { hasText: 'Soccer transfers' }).locator('.topic-category')).toHaveText(
    'Soccer',
    { timeout: 15_000 },
  );
});

test('the sidebar shows the most specific section per topic (FR-22.9)', async ({ page }) => {
  await page.goto('/');
  const pill = (name: string) => page.locator('.topic', { hasText: name }).locator('.topic-category');

  await expect(pill('Soccer transfers')).toHaveText('Soccer');
  await expect(pill('Fashion week')).toHaveText('Fashion');
  // The full path is in the tooltip, where there is room for it.
  await expect(pill('Soccer transfers')).toHaveAttribute('title', 'Section: Sports · Soccer');

  // A topic the model declined to classify has no pill at all — an
  // "Uncategorized" badge on every unclassified row would be noise.
  await expect(page.locator('.topic', { hasText: 'An uncategorized thing' }).locator('.topic-category')).toHaveCount(0);
});

test('the filter bar narrows the feed to a section (FR-22.10)', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.item').first()).toBeVisible({ timeout: 15_000 });

  await page.locator('[data-filter-category=sports]').click();
  await expect.poll(async () => new Set(await page.locator('.item .item-topic').allTextContents())).toEqual(
    new Set(['Soccer transfers', 'Tennis majors']),
  );

  // "All" restores everything, including the unclassified topic.
  await page.locator('[data-filter-category=""]').click();
  await expect
    .poll(async () => (await page.locator('.item .item-topic').allTextContents()).length)
    .toBeGreaterThan(4);
});

test('selecting a section reveals its subsections (FR-22.10)', async ({ page }) => {
  await page.goto('/');
  // Nothing is selected, so there is no second row.
  await expect(page.locator('.filter-subpill')).toHaveCount(0);

  await page.locator('[data-filter-category=sports]').click();
  const subs = page.locator('.filter-subpill');
  await expect(subs.first()).toHaveText('All Sports');
  // "Other" is the rendered fallback for `sports`/null, not a stored row.
  await expect(subs.last()).toHaveText('Other');

  await page.locator('[data-filter-subcategory=soccer]').click();
  await expect.poll(async () => new Set(await page.locator('.item .item-topic').allTextContents())).toEqual(
    new Set(['Soccer transfers']),
  );

  // Switching section resets the subsection — a sub from the old parent would
  // match nothing at all.
  await page.locator('[data-filter-category=style]').click();
  await expect(page.locator('.filter-subpill.active')).toHaveText('All Style');
  await expect.poll(async () => new Set(await page.locator('.item .item-topic').allTextContents())).toEqual(
    new Set(['Fashion week']),
  );
});

test('the Uncategorized pill selects topics with no section', async ({ page }) => {
  await page.goto('/');
  await page.locator('[data-filter-category=uncategorized]').click();
  await expect.poll(async () => new Set(await page.locator('.item .item-topic').allTextContents())).toEqual(
    new Set(['An uncategorized thing']),
  );
  // It has no subsections to offer.
  await expect(page.locator('.filter-subpill')).toHaveCount(0);
});

test('the filter does not survive a reload', async ({ page }) => {
  // Ephemeral like Solo and for the same reason: a filter that quietly survived
  // a restart would hide news days later, and "the app stopped finding
  // anything" is a far worse failure than re-applying a filter.
  await page.goto('/');
  await page.locator('[data-filter-category=sports]').click();
  // The DOM text, not the rendered one — the upper-casing is CSS.
  await expect(page.locator('.filter-pill.active')).toHaveText('Sports');

  await page.reload();
  await expect(page.locator('.filter-pill.active')).toHaveText('All');
});

test('the bar composes with search rather than replacing it', async ({ page }) => {
  await page.goto('/');
  await page.locator('[data-filter-category=sports]').click();
  await page.fill('.search-input', 'tennis');
  await expect.poll(async () => new Set(await page.locator('.item .item-topic').allTextContents())).toEqual(
    new Set(['Tennis majors']),
  );

  // A search that only matches outside the section yields nothing, rather than
  // the filter being quietly dropped.
  await page.fill('.search-input', 'fashion');
  await expect.poll(async () => page.locator('.item').count()).toBe(0);
  await page.locator('[data-action=clear-search]').click();
});

test('clean up the category topics', async ({ page }) => {
  await resetTopics(test.info().project.use.baseURL ?? '');
  await page.goto('/');
  for (const name of TOPICS) {
    await expect(page.locator('.topic', { hasText: name })).toHaveCount(0);
  }
});
