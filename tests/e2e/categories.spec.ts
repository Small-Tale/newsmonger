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

const TOPICS = [
  'Soccer transfers',
  'Tennis majors',
  'Fashion week',
  'An uncategorized thing',
  // Added mid-spec by the NEWS-111 truncation test; listed so cleanup covers it.
  'Biology & Medicine Research funding',
];

test('set up topics that classify themselves', async ({ page }) => {
  await page.goto('/');
  for (const name of TOPICS) {
    await page.fill('.add-topic input', name);
    await page.press('.add-topic input', 'Enter');
    await expect(page.locator('.topic', { hasText: name })).toBeVisible();
  }
  // Classification lands on the check the new topic triggers.
  await expect(page.locator('.topic', { hasText: 'Soccer transfers' }).locator('.topic-category')).toHaveText(
    'Sports · Soccer',
    { timeout: 15_000 },
  );
});

test('the sidebar shows the full section path per topic (FR-22.9)', async ({ page }) => {
  await page.goto('/');
  const pill = (name: string) => page.locator('.topic', { hasText: name }).locator('.topic-category');

  // The whole path, not just the subcategory — the label has its own line since
  // NEWS-111, so there is room for it.
  await expect(pill('Soccer transfers')).toHaveText('Sports · Soccer');
  await expect(pill('Fashion week')).toHaveText('Style · Fashion');

  // A topic the model declined to classify has no pill at all — an
  // "Uncategorized" badge on every unclassified row would be noise.
  await expect(page.locator('.topic', { hasText: 'An uncategorized thing' }).locator('.topic-category')).toHaveCount(0);
});

test('a long section label is not truncated (NEWS-111)', async ({ page }) => {
  // The reason the label moved to its own line: sharing the row with the topic
  // name meant both competed for ~320px and both lost. Measured rather than
  // eyeballed, and against the *longest* label the built-in taxonomy can produce.
  await page.goto('/');
  await page.fill('.add-topic input', 'Biology & Medicine Research funding');
  await page.press('.add-topic input', 'Enter');

  const pill = page.locator('.topic', { hasText: 'Biology & Medicine Research' }).locator('.topic-category');
  await expect(pill).toHaveText('Science · Biology & Medicine Research', { timeout: 15_000 });
  // Measured, with a guard against the vacuous pass: a row that has just been
  // re-rendered by the 4 s poll can report scrollWidth === clientWidth === 0 for
  // an instant, and `0 <= 0 + 1` would "prove" the label fits. Requiring a real
  // width first is what makes this assert anything. (It didn't, at first — the
  // test passed against a deliberately re-broken layout until this was added.)
  await expect
    .poll(async () => pill.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth })))
    .toEqual(expect.objectContaining({ client: expect.any(Number) }));
  const box = await pill.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
  expect(box.client, 'the label should have been measured, not mid-render').toBeGreaterThan(20);
  expect(box.scroll, 'the section label should not be clipped').toBeLessThanOrEqual(box.client + 1);

  // And the label sits below the name rather than beside it, which is what
  // gives both the room.
  const [nameBox, pillBox] = await Promise.all([
    page.locator('.topic', { hasText: 'Biology & Medicine Research' }).locator('.topic-name').boundingBox(),
    pill.boundingBox(),
  ]);
  expect(pillBox?.y ?? 0).toBeGreaterThan((nameBox?.y ?? 0) + (nameBox?.height ?? 0) - 1);
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
