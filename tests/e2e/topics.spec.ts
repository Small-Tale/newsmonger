import { acceptConfirm, cancelConfirm, expect, test, topicAction } from './fixtures.js';

// Selection, the right-click menu, and solo (NEWS-29). Serial and stateful
// like the rest of the suite: this spec creates its own topics up front and
// deletes them at the end, so it neither depends on nor disturbs the others.

test.describe.configure({ mode: 'serial' });

const NAMES = ['Alpha Topic', 'Beta Topic', 'Gamma Topic', 'Delta Topic'];
const row = (page: Parameters<typeof topicAction>[0], name: string) =>
  page.locator('.topic', { hasText: name });

test('set up topics for the selection tests', async ({ page }) => {
  await page.goto('/');
  for (const name of NAMES) {
    await page.fill('.add-topic input', name);
    await page.press('.add-topic input', 'Enter');
    await expect(row(page, name)).toBeVisible();
  }
});

test('rows carry no always-visible action buttons', async ({ page }) => {
  // The point of the change: the old buttons were hidden until hover but still
  // reserved their width, truncating every topic name to pay for them.
  await page.goto('/');
  await expect(page.locator('.topic .chip')).toHaveCount(0);
  await expect(page.locator('.topic-actions')).toHaveCount(0);
});

test('clicking selects, and clicking away deselects', async ({ page }) => {
  await page.goto('/');
  await row(page, 'Alpha Topic').click();
  await expect(page.locator('.topic.selected')).toHaveCount(1);
  await expect(row(page, 'Alpha Topic')).toHaveAttribute('aria-selected', 'true');

  await page.locator('#feed').click({ position: { x: 5, y: 5 } });
  await expect(page.locator('.topic.selected')).toHaveCount(0);
});

test('cmd/ctrl-click toggles individual rows', async ({ page }) => {
  await page.goto('/');
  await row(page, 'Alpha Topic').click();
  await row(page, 'Gamma Topic').click({ modifiers: ['Meta'] });
  await expect(page.locator('.topic.selected')).toHaveCount(2);

  // Toggling the same row off again is the half a naive implementation misses.
  await row(page, 'Gamma Topic').click({ modifiers: ['Meta'] });
  await expect(page.locator('.topic.selected')).toHaveCount(1);
});

test('shift-click selects a contiguous range', async ({ page }) => {
  await page.goto('/');
  await row(page, 'Alpha Topic').click();
  await row(page, 'Delta Topic').click({ modifiers: ['Shift'] });
  await expect(page.locator('.topic.selected')).toHaveCount(4);

  // Anchored on the last plain click, so a second shift-click re-ranges rather
  // than accumulating.
  await row(page, 'Beta Topic').click({ modifiers: ['Shift'] });
  await expect(page.locator('.topic.selected')).toHaveCount(2);
});

test('Escape clears the selection', async ({ page }) => {
  await page.goto('/');
  await row(page, 'Alpha Topic').click();
  await expect(page.locator('.topic.selected')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('.topic.selected')).toHaveCount(0);
});

test('right-click opens a menu with icons and separators', async ({ page }) => {
  await page.goto('/');
  await row(page, 'Alpha Topic').click({ button: 'right' });
  await expect(page.locator('.menu')).toBeVisible();

  await expect(page.locator('.menu-item')).toHaveCount(4);
  await expect(page.locator('.menu .icon')).toHaveCount(4);
  await expect(page.locator('.menu-sep')).toHaveCount(2);
  await expect(page.locator('.menu-item span').first()).toHaveText('Check now');

  // Clicking inside the menu must not dismiss it before the item handler runs —
  // the backdrop wraps the menu, so this is the trap the settings dialog hit.
  await page.locator('.menu-sep').first().click({ force: true });
  await expect(page.locator('.menu')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.locator('.menu')).toHaveCount(0);
});

test('right-clicking an unselected row targets just that row', async ({ page }) => {
  await page.goto('/');
  await row(page, 'Alpha Topic').click();
  await row(page, 'Gamma Topic').click({ button: 'right' });

  // Selection follows the right-click, so the menu never acts on rows the user
  // can't see are targeted.
  await expect(page.locator('.menu-item span').first()).toHaveText('Check now');
  await expect(row(page, 'Gamma Topic')).toHaveClass(/selected/);
  await expect(page.locator('.topic.selected')).toHaveCount(1);
  await page.keyboard.press('Escape');
});

test('right-clicking inside a selection acts on all of it', async ({ page }) => {
  await page.goto('/');
  await row(page, 'Alpha Topic').click();
  await row(page, 'Beta Topic').click({ modifiers: ['Meta'] });
  await row(page, 'Beta Topic').click({ button: 'right' });

  await expect(page.locator('.menu-item span').first()).toHaveText('Check now 2 topics');
  await page.keyboard.press('Escape');
});

test('pause works in bulk from the menu', async ({ page }) => {
  await page.goto('/');
  await row(page, 'Alpha Topic').click();
  await row(page, 'Beta Topic').click({ modifiers: ['Meta'] });
  await topicAction(page, row(page, 'Beta Topic'), 'pause');

  await expect(row(page, 'Alpha Topic')).toHaveClass(/paused/);
  await expect(row(page, 'Beta Topic')).toHaveClass(/paused/);

  // The label flips to Resume once every target is paused.
  await row(page, 'Beta Topic').click({ button: 'right' });
  await expect(page.locator('.menu-item span').nth(1)).toHaveText('Resume 2 topics');
  await page.locator('[data-menu-action=pause]').click();
  await expect(page.locator('.topic.paused')).toHaveCount(0);
});

test('solo filters the feed to the chosen topics', async ({ page }) => {
  await page.goto('/');
  await topicAction(page, row(page, 'Alpha Topic'), 'check');
  await expect(page.locator('.item')).not.toHaveCount(0, { timeout: 15_000 });

  // Counted, not assumed: the suite is serial, so topics from other specs may
  // still be present.
  const totalTopics = await page.locator('.topic').count();

  await topicAction(page, row(page, 'Alpha Topic'), 'solo');
  await expect(page.locator('.banner.solo')).toBeVisible();
  await expect(page.locator('.banner.solo')).toContainText(`of ${String(totalTopics)} topics`);

  // Assert the invariant — every remaining story belongs to the solo'd topic —
  // rather than comparing item counts before and after. Counts race the 4 s
  // poll: snapshot the "before" total a beat too early and the two are equal.
  await expect(page.locator('.item')).not.toHaveCount(0);
  const shown = await page.locator('.item .item-topic').allTextContents();
  expect(new Set(shown.map((t) => t.trim()))).toEqual(new Set(['Alpha Topic']));

  await expect(page.locator('.topic.soloed')).toHaveCount(1);
  await expect(page.locator('.topic.solo-dimmed')).toHaveCount(totalTopics - 1);
});

test('solo is additive and Show all clears it', async ({ page }) => {
  // Self-contained: solo is ephemeral, so the goto() above already cleared
  // whatever the previous test solo'd. Both topics get solo'd here.
  await page.goto('/');
  await topicAction(page, row(page, 'Alpha Topic'), 'solo');
  await expect(page.locator('.topic.soloed')).toHaveCount(1);

  await topicAction(page, row(page, 'Beta Topic'), 'solo');
  await expect(page.locator('.topic.soloed')).toHaveCount(2);
  await expect(page.locator('.banner.solo')).toContainText('Showing 2 of');

  // Unsolo is the same menu item, flipped, once every target is solo'd.
  await row(page, 'Beta Topic').click({ button: 'right' });
  await expect(page.locator('.menu-item span').nth(2)).toHaveText('Unsolo');
  await page.keyboard.press('Escape');

  await page.locator('[data-action=clear-solo]').click();
  await expect(page.locator('.banner.solo')).toHaveCount(0);
  await expect(page.locator('.topic.solo-dimmed')).toHaveCount(0);
});

test('solo does not survive a reload', async ({ page }) => {
  // Ephemeral by design: a solo that persisted would silently hide news days
  // later, and "the app stopped finding anything" is the worse failure.
  await page.goto('/');
  await topicAction(page, row(page, 'Alpha Topic'), 'solo');
  await expect(page.locator('.banner.solo')).toBeVisible();

  await page.reload();
  await expect(page.locator('.topic').first()).toBeVisible();
  await expect(page.locator('.banner.solo')).toHaveCount(0);
});

test('Backspace while typing does not delete a topic', async ({ page }) => {
  // The keyboard shortcut must never steal Backspace from the add-topic field.
  await page.goto('/');
  const before = await page.locator('.topic').count();
  await page.fill('.add-topic input', 'typing');
  await page.locator('.add-topic input').press('Backspace');

  await expect(page.locator('.add-topic input')).toHaveValue('typin');
  await expect(page.locator('.topic')).toHaveCount(before);
  await page.fill('.add-topic input', '');
});

test('delete uses an in-app dialog, not window.confirm', async ({ page }) => {
  // NEWS-39: window.confirm is a silent no-op in the Tauri WKWebView, so a
  // native confirm made delete do nothing in the desktop app. The dialog must
  // be a real in-DOM element. A stray native dialog here fails the test.
  let nativeDialogs = 0;
  page.on('dialog', (d) => {
    nativeDialogs++;
    void d.dismiss();
  });
  await page.goto('/');

  await row(page, 'Delta Topic').click();
  await page.keyboard.press('Delete');
  await expect(page.locator('.dialog.confirm')).toBeVisible();
  await expect(page.locator('.confirm-message')).toContainText('Delta Topic');
  expect(nativeDialogs).toBe(0);

  await acceptConfirm(page);
  await expect(row(page, 'Delta Topic')).toHaveCount(0);
});

test('a cancelled confirmation deletes nothing', async ({ page }) => {
  await page.goto('/');
  const before = await page.locator('.topic').count();

  await row(page, 'Gamma Topic').click();
  await page.keyboard.press('Delete');
  await cancelConfirm(page);
  await expect(page.locator('.topic')).toHaveCount(before);
  await expect(row(page, 'Gamma Topic')).toBeVisible();
});

test('clean up the topics this spec created', async ({ page }) => {
  await page.goto('/');
  for (const name of NAMES) {
    const target = row(page, name);
    if ((await target.count()) === 0) continue;
    await target.click();
    await page.keyboard.press('Delete');
    await acceptConfirm(page);
    await expect(target).toHaveCount(0);
  }
});
