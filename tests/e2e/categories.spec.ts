import { expect, resetSharedState, test, topicAction, workerBaseURL } from './fixtures.js';

// The section filter bar and sidebar pills (NEWS-97, FR-22.9/22.10).
//
// The mock provider classifies from the topic name, so these names are also the
// expected sections: "Soccer transfers" → Sports · Soccer, "Fashion week" →
// Style · Fashion. A name containing "uncategorized" makes it decline, which is
// how the Uncategorized pill gets something to select.

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  await resetSharedState(workerBaseURL());
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
  // Only the subsections in use (NEWS-114) — Soccer and Tennis here, and no
  // "Other", because no Sports topic lacks a subsection.
  await expect(subs).toHaveText(['All Sports', 'Soccer', 'Tennis']);

  await page.locator('[data-filter-subcategory=soccer]').click();
  await expect.poll(async () => new Set(await page.locator('.item .item-topic').allTextContents())).toEqual(
    new Set(['Soccer transfers']),
  );

  // Switching section resets the subsection — a sub from the old parent would
  // match nothing at all.
  await page.locator('[data-filter-category=style]').click();
  // Style has one subsection in use, so it offers no subsection row (NEWS-114).
  // The feed is what proves the reset: had "soccer" survived the switch, this
  // would be empty rather than showing the Style topic.
  await expect(page.locator('.filter-subpill')).toHaveCount(0);
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

// Empty options are hidden (NEWS-114). A pill for a section nobody watches is a
// button that can only ever produce an empty feed, and a bar full of them crowds
// out the two or three that mean something.

test('the filter bar carries no rule under it (NEWS-155)', async ({ page }) => {
  // The masthead above already has one, and a second hairline 40px below it read
  // as a boxed-in strip rather than as a newspaper's section line. The bar's own
  // two rows — small-caps sections over italic subsections — are distinct enough
  // to be structure without being fenced.
  await page.goto('/');
  await expect(page.locator('.filter-pill').first()).toBeVisible();
  const width = await page
    .locator('.filter-bar')
    .evaluate((el) => Number.parseFloat(getComputedStyle(el).borderBottomWidth));
  expect(width).toBe(0);
});

test('the bar shows only sections in use', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.filter-pill').first()).toBeVisible();

  const labels = await page.locator('.filter-pill').allTextContents();
  // The fixtures cover Sports, Style, Politics — plus All and Uncategorized,
  // since one fixture topic is deliberately unclassified.
  expect(labels).toContain('Sports');
  expect(labels).toContain('Style');
  expect(labels).toContain('Uncategorized');
  // ...and nothing for the sections no fixture uses.
  expect(labels).not.toContain('Health');
  expect(labels).not.toContain('Business');
  expect(labels).not.toContain('Society');
});

test('a section with only one subsection in use offers no subsection row', async ({ page }) => {
  // "All Style" and "Fashion" would select exactly the same stories, so
  // offering both is a control that does nothing.
  await page.goto('/');
  await page.locator('[data-filter-category=style]').click();
  await expect(page.locator('.filter-subpill')).toHaveCount(0);
  // The section filter itself still applies.
  await expect.poll(async () => new Set(await page.locator('.item .item-topic').allTextContents())).toEqual(
    new Set(['Fashion week']),
  );
});

test('the active section stays visible after its last topic goes', async ({ page }) => {
  // Otherwise deleting the last topic in the section you are filtered to removes
  // the only control showing a filter is on — an empty feed with no visible
  // cause and no way back to All.
  await page.goto('/');
  await page.locator('[data-filter-category=style]').click();
  await expect(page.locator('.filter-pill.active')).toHaveText('Style');

  await topicAction(page, page.locator('.topic', { hasText: 'Fashion week' }), 'delete');
  // Wait for the client to have *seen* the deletion before asserting anything
  // about the bar. Without this the pill is still there only because the state
  // hasn't refreshed yet, and the test passes whatever the rule does — verified:
  // it did exactly that before this line was added.
  await expect(page.locator('.topic', { hasText: 'Fashion week' })).toHaveCount(0);

  await expect(page.locator('.filter-pill.active')).toHaveText('Style');
  await page.locator('[data-filter-category=""]').click();
  await expect(page.locator('.filter-pill.active')).toHaveText('All');
  // Now that nothing is filed under it and it isn't selected, it goes.
  await expect.poll(async () => page.locator('.filter-pill').allTextContents()).not.toContain('Style');
});

test('clean up the category topics', async ({ page }) => {
  await resetSharedState(workerBaseURL());
  await page.goto('/');
  for (const name of TOPICS) {
    await expect(page.locator('.topic', { hasText: name })).toHaveCount(0);
  }
});