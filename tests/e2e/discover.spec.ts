import { expect, resetTopics, test, topicAction } from './fixtures.js';

// Topic discovery — both doors and the result list (NEWS-126, FR-24.1–24.4, 24.17).
//
// The mock provider names its suggestions after the request seed, which for a
// section request is the subcategory slug: browsing Sports ▸ Motorsport returns
// "motorsport topic 2", "motorsport topic 3", … Those names then classify back
// into Sports · Motorsport, so the grouping is exercised too.
//
// It also deliberately suggests the *first already-followed topic* whenever the
// exclusion list is non-empty (NEWS-124), which is what makes FR-24.11's
// second layer observable from the outside.

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  await resetTopics(test.info().project.use.baseURL ?? '');
});

test('the discover dialog opens from beside the add-topic field', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.dialog.discover')).toHaveCount(0);

  await page.click('[data-action=open-discover]');
  await expect(page.locator('.dialog.discover h2')).toHaveText('Discover topics');
});

test('it opens on the section grid, showing the whole taxonomy', async ({ page }) => {
  await page.goto('/');
  await page.click('[data-action=open-discover]');

  await expect(page.locator('.section-tile')).toHaveCount(11);
  await expect(page.locator('.section-tile', { hasText: 'Sports' })).toBeVisible();
  // Both doors are present at once — neither is primary (FR-24.1).
  await expect(page.locator('.discover-search input')).toBeVisible();
});

test('a section drills into its subcategories, with an escape for the whole section', async ({ page }) => {
  await page.goto('/');
  await page.click('[data-action=open-discover]');
  await page.click('.section-tile:has-text("Sports")');

  await expect(page.locator('.section-chips .chip', { hasText: 'Motorsport' })).toBeVisible();
  // For the user who recognises none of the subcategory names (FR-24.2).
  await expect(page.locator('.chip.anything')).toHaveText('Anything in Sports');
});

test('drilling to a subcategory returns grouped, labelled suggestions', async ({ page }) => {
  await page.goto('/');
  await page.click('[data-action=open-discover]');
  await page.click('.section-tile:has-text("Sports")');
  await page.click('.section-chips .chip:has-text("Motorsport")');

  await expect(page.locator('.suggestion').first()).toBeVisible();
  await expect(page.locator('.discover-results-head h3')).toHaveText('Sports · Motorsport');
  // The grouping doubles as a preview of where the topic will file itself.
  // The DOM text — the uppercasing is CSS, which `toHaveText` does not see.
  await expect(page.locator('.suggestion-group-label').first()).toHaveText('Sports · Motorsport');
  // Ongoing vs evergreen is on the card, not hidden (FR-24.10). The mock
  // alternates, so both must appear.
  await expect(page.locator('.suggestion-kind.evergreen').first()).toBeVisible();
  await expect(page.locator('.suggestion-kind.ongoing').first()).toBeVisible();
});

test('adding a suggestion creates the topic and leaves the card in place', async ({ page }) => {
  await page.goto('/');
  await page.click('[data-action=open-discover]');
  await page.click('.section-tile:has-text("Sports")');
  await page.click('.section-chips .chip:has-text("Motorsport")');

  const first = page.locator('.suggestion').first();
  const name = (await first.locator('.suggestion-name').textContent()) ?? '';
  expect(name).not.toBe('');
  await first.locator('[data-add-suggestion]').click();

  // The card stays put and marks itself — a row vanishing under the cursor is
  // how the *next* one gets clicked by accident.
  await expect(first.locator('.suggestion-added')).toBeVisible();
  await expect(first.locator('[data-add-suggestion]')).toHaveCount(0);

  await page.click('[data-action=close-discover]');
  await expect(page.locator('.topic', { hasText: name })).toBeVisible();
});

test('the added topic carries the suggestion’s guidance (FR-24.12)', async ({ page }) => {
  // The steer is what makes the *first* check narrowed rather than a bare name,
  // so it has to arrive with the topic rather than after it.
  await page.goto('/');
  const topic = page.locator('.topic').first();
  await topicAction(page, topic, 'guidance');
  await expect(page.locator('.dialog.guidance textarea')).not.toBeEmpty();
  await page.click('[data-action=close-guidance]');
});

test('a topic already followed is never suggested again (FR-24.11)', async ({ page }) => {
  // The mock plants the first excluded name at the top of its list on purpose,
  // so this fails loudly if the server-side filter stops running.
  await page.goto('/');
  const followed = (await page.locator('.topic .topic-name').first().textContent())?.trim() ?? '';
  expect(followed).not.toBe('');

  await page.click('[data-action=open-discover]');
  await page.click('.section-tile:has-text("Sports")');
  await page.click('.section-chips .chip:has-text("Motorsport")');

  await expect(page.locator('.suggestion').first()).toBeVisible();
  await expect(page.locator('.suggestion-name', { hasText: followed })).toHaveCount(0);
});

test('the free-text box is the other door to the same list', async ({ page }) => {
  await page.goto('/');
  await page.click('[data-action=open-discover]');

  await page.fill('.discover-search input', 'cycling');
  await page.press('.discover-search input', 'Enter');

  await expect(page.locator('.suggestion').first()).toBeVisible();
  await expect(page.locator('.discover-results-head h3')).toContainText('cycling');
});

test('an empty box is “surprise me”, not an error (FR-24.3)', async ({ page }) => {
  await page.goto('/');
  await page.click('[data-action=open-discover]');

  await page.fill('.discover-search input', '');
  await page.click('.discover-search button[type=submit]');

  await expect(page.locator('.discover-results-head h3')).toHaveText('A bit of everything');
  await expect(page.locator('.suggestion').first()).toBeVisible();
  await expect(page.locator('.discover-status.error')).toHaveCount(0);
});

test('Back returns to the section that produced the results', async ({ page }) => {
  await page.goto('/');
  await page.click('[data-action=open-discover]');
  await page.click('.section-tile:has-text("Sports")');
  await page.click('.section-chips .chip:has-text("Motorsport")');
  await expect(page.locator('.suggestion').first()).toBeVisible();

  await page.click('[data-action=discover-back]');
  // Back to Sports' subcategories, not all the way out to the grid — the user
  // was browsing one section and most likely wants its neighbour.
  await expect(page.locator('.chip.anything')).toHaveText('Anything in Sports');

  await page.click('[data-action=discover-back]');
  await expect(page.locator('.section-tile')).toHaveCount(11);
});

test('a provider failure is shown in the dialog with a retry, not as a dead end', async ({ page }) => {
  await page.goto('/');
  await page.click('[data-action=open-discover]');

  // The mock throws on a seed containing "fail" (NEWS-124).
  await page.fill('.discover-search input', 'fail please');
  await page.press('.discover-search input', 'Enter');

  await expect(page.locator('.discover-status.error')).toBeVisible();
  await expect(page.locator('[data-action=discover-retry]')).toBeVisible();
  // The dialog stays open: the user is mid-task, and the error is about this
  // request rather than the app.
  await expect(page.locator('.dialog.discover')).toBeVisible();
});

test('closing works from the ✕ and from the backdrop, but not from inside', async ({ page }) => {
  await page.goto('/');
  await page.click('[data-action=open-discover]');

  await page.locator('.dialog.discover h2').click();
  await expect(page.locator('.dialog.discover')).toBeVisible();

  await page.locator('[data-action=discover-backdrop]').click({ position: { x: 5, y: 5 } });
  await expect(page.locator('.dialog.discover')).toHaveCount(0);

  await page.click('[data-action=open-discover]');
  await page.click('[data-action=close-discover]');
  await expect(page.locator('.dialog.discover')).toHaveCount(0);
});

test('the topics list survives the dialog opening and closing', async ({ page }) => {
  // The kerf structural rule (docs/3-ui.md): a conditional sibling appearing
  // and disappearing must not disturb the keyed topics list beside it.
  await page.goto('/');
  const before = await page.locator('.topic').count();
  expect(before).toBeGreaterThan(0);

  for (let i = 0; i < 3; i++) {
    await page.click('[data-action=open-discover]');
    await page.click('[data-action=close-discover]');
    await expect(page.locator('.dialog.discover')).toHaveCount(0);
  }
  await expect(page.locator('.topic')).toHaveCount(before);
});

test('clean up the topics this spec created', async ({ page }) => {
  await page.goto('/');
  const names = await page.locator('.topic .topic-name').allTextContents();
  for (const name of names) {
    const row = page.locator('.topic', { hasText: name.trim() }).first();
    await topicAction(page, row, 'delete');
  }
  await expect(page.locator('.topic')).toHaveCount(0);
});
