import { acceptConfirm, cancelConfirm, expect, openSettingsTab, resetTopics, test, topicAction } from './fixtures.js';

// Selection, the right-click menu, and solo (NEWS-29). Serial and stateful
// like the rest of the suite: this spec creates its own topics up front and
// deletes them at the end, so it neither depends on nor disturbs the others.

test.describe.configure({ mode: 'serial' });

// Every attempt starts from an empty server, including a serial retry — see
// `resetTopics` (NEWS-101). Without this a mid-test failure leaves topics
// behind and the replay blames whichever early test trips over them.
test.beforeAll(async () => {
  await resetTopics(test.info().project.use.baseURL ?? '');
});

const NAMES = ['Alpha Topic', 'Bravo Topic', 'Charlie Topic', 'Delta Topic'];
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

test('the sidebar sort order changes and persists (NEWS-63)', async ({ page }) => {
  // Runs early, while all four topics exist (later tests delete some).
  await page.goto('/');
  const natoOrder = async (): Promise<string[]> => {
    const all = (await page.locator('.topic-name').allTextContents()).map((t) => t.trim());
    return all.filter((n) => NAMES.includes(n));
  };

  // Default is A→Z.
  await expect.poll(natoOrder).toEqual(['Alpha Topic', 'Bravo Topic', 'Charlie Topic', 'Delta Topic']);

  // Recently added → newest first (they were created Alpha → Delta).
  await page.selectOption('[data-action=topic-sort]', 'added');
  await expect.poll(natoOrder).toEqual(['Delta Topic', 'Charlie Topic', 'Bravo Topic', 'Alpha Topic']);

  // The choice persists across a reload (per-device localStorage).
  await page.reload();
  await expect(page.locator('.topic').first()).toBeVisible();
  await expect.poll(natoOrder).toEqual(['Delta Topic', 'Charlie Topic', 'Bravo Topic', 'Alpha Topic']);
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
  await row(page, 'Charlie Topic').click({ modifiers: ['Meta'] });
  await expect(page.locator('.topic.selected')).toHaveCount(2);

  // Toggling the same row off again is the half a naive implementation misses.
  await row(page, 'Charlie Topic').click({ modifiers: ['Meta'] });
  await expect(page.locator('.topic.selected')).toHaveCount(1);
});

test('shift-click selects a contiguous range', async ({ page }) => {
  await page.goto('/');
  await row(page, 'Alpha Topic').click();
  await row(page, 'Delta Topic').click({ modifiers: ['Shift'] });
  await expect(page.locator('.topic.selected')).toHaveCount(4);

  // Anchored on the last plain click, so a second shift-click re-ranges rather
  // than accumulating.
  await row(page, 'Bravo Topic').click({ modifiers: ['Shift'] });
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

  // Check, Pause, High priority, Rename, Guidance, Solo, Review Flagged, Delete
  // (NEWS-61 added Review Flagged; NEWS-80 Guidance; NEWS-139 Rename).
  await expect(page.locator('.menu-item')).toHaveCount(8);
  await expect(page.locator('.menu .icon')).toHaveCount(8);
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
  await row(page, 'Charlie Topic').click({ button: 'right' });

  // Selection follows the right-click, so the menu never acts on rows the user
  // can't see are targeted.
  await expect(page.locator('.menu-item span').first()).toHaveText('Check now');
  await expect(row(page, 'Charlie Topic')).toHaveClass(/selected/);
  await expect(page.locator('.topic.selected')).toHaveCount(1);
  await page.keyboard.press('Escape');
});

test('right-clicking inside a selection acts on all of it', async ({ page }) => {
  await page.goto('/');
  await row(page, 'Alpha Topic').click();
  await row(page, 'Bravo Topic').click({ modifiers: ['Meta'] });
  await row(page, 'Bravo Topic').click({ button: 'right' });

  await expect(page.locator('.menu-item span').first()).toHaveText('Check now 2 topics');
  await page.keyboard.press('Escape');
});

test('pause works in bulk from the menu', async ({ page }) => {
  await page.goto('/');
  await row(page, 'Alpha Topic').click();
  await row(page, 'Bravo Topic').click({ modifiers: ['Meta'] });
  await topicAction(page, row(page, 'Bravo Topic'), 'pause');

  await expect(row(page, 'Alpha Topic')).toHaveClass(/paused/);
  await expect(row(page, 'Bravo Topic')).toHaveClass(/paused/);

  // The label flips to Resume once every target is paused.
  await row(page, 'Bravo Topic').click({ button: 'right' });
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

  await topicAction(page, row(page, 'Bravo Topic'), 'solo');
  await expect(page.locator('.topic.soloed')).toHaveCount(2);
  await expect(page.locator('.banner.solo')).toContainText('Showing 2 of');

  // Unsolo is the same menu item, flipped, once every target is solo'd.
  await row(page, 'Bravo Topic').click({ button: 'right' });
  // Targeted by action rather than position: menu items get added over time
  // (Guidance, NEWS-80), and an index makes an unrelated feature break this.
  await expect(page.locator('[data-menu-action=solo] span')).toHaveText('Unsolo');
  await page.keyboard.press('Escape');

  await page.locator('[data-action=clear-solo]').click();
  await expect(page.locator('.banner.solo')).toHaveCount(0);
  await expect(page.locator('.topic.solo-dimmed')).toHaveCount(0);
});

test('double-clicking a topic toggles solo (NEWS-95)', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.banner.solo')).toHaveCount(0);

  // Double-click solos, without ever opening the menu.
  await row(page, 'Alpha Topic').dblclick();
  await expect(page.locator('.topic.soloed')).toHaveCount(1);
  await expect(row(page, 'Alpha Topic')).toHaveClass(/soloed/);
  await expect(page.locator('.banner.solo')).toBeVisible();

  // Additive, exactly like the menu item: a second double-click widens the
  // filter rather than replacing it.
  await row(page, 'Bravo Topic').dblclick();
  await expect(page.locator('.topic.soloed')).toHaveCount(2);
  await expect(page.locator('.banner.solo')).toContainText('Showing 2 of');

  // ...and double-clicking a soloed row toggles it back off.
  await row(page, 'Bravo Topic').dblclick();
  await expect(page.locator('.topic.soloed')).toHaveCount(1);
  await expect(row(page, 'Alpha Topic')).toHaveClass(/soloed/);

  // The gesture and the menu drive one filter, not two: the menu must now
  // offer "Unsolo" for the row the double-click solo'd.
  await row(page, 'Alpha Topic').click({ button: 'right' });
  await expect(page.locator('[data-menu-action=solo] span')).toHaveText('Unsolo');
  await page.keyboard.press('Escape');

  await row(page, 'Alpha Topic').dblclick();
  await expect(page.locator('.topic.soloed')).toHaveCount(0);
  await expect(page.locator('.banner.solo')).toHaveCount(0);
});

test('a double-click leaves no stray text selection (NEWS-95)', async ({ page }) => {
  // A double-click normally selects the word under the cursor; on a row whose
  // whole job is to be clicked, that blue smear looks like a bug. `.topic` is
  // `user-select: none`, and this is what keeps it that way.
  await page.goto('/');
  await row(page, 'Alpha Topic').dblclick();
  expect(await page.evaluate(() => (window.getSelection()?.toString() ?? '').trim())).toBe('');
  await page.locator('[data-action=clear-solo]').click();
  await expect(page.locator('.banner.solo')).toHaveCount(0);
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

  await row(page, 'Charlie Topic').click();
  await page.keyboard.press('Delete');
  await cancelConfirm(page);
  await expect(page.locator('.topic')).toHaveCount(before);
  await expect(row(page, 'Charlie Topic')).toBeVisible();
});

test('mark a topic high priority and show a star, then clear it (NEWS-56)', async ({ page }) => {
  await page.goto('/');
  const target = row(page, 'Alpha Topic');
  await expect(target).toBeVisible();
  await expect(target).not.toHaveClass(/high-priority/);

  // Mark it via the right-click menu.
  await target.click({ button: 'right' });
  await expect(page.locator('.menu-item span', { hasText: 'High priority' })).toBeVisible();
  await page.locator('[data-menu-action=priority]').click();
  await expect(target).toHaveClass(/high-priority/);
  await expect(target.locator('.topic-flags .flag.high-priority')).toHaveCount(1);

  // The menu now offers the reverse, and it persists across reload.
  await page.reload();
  await expect(row(page, 'Alpha Topic')).toHaveClass(/high-priority/);

  await row(page, 'Alpha Topic').click({ button: 'right' });
  await expect(page.locator('.menu-item span', { hasText: 'Normal priority' })).toBeVisible();
  await page.locator('[data-menu-action=priority]').click();
  await expect(row(page, 'Alpha Topic')).not.toHaveClass(/high-priority/);
});

test('the high-priority interval is clamped to the default (NEWS-56)', async ({ page }) => {
  // Longer assertion timeout than the 5 s default (NEWS-131). Every expectation
  // below waits on a full round trip — PATCH, server-side clamp, state refresh —
  // and this suite is serial against one shared server that is also running mock
  // check sweeps for every topic the earlier specs created. Under that load the
  // round trip has been seen to exceed 5 s once in ~13 runs.
  //
  // Not papering over a product bug: the three mechanisms that would have been
  // one were each ruled out empirically. The NEWS-104 sequence guard discards
  // older-issued responses correctly; the morph *preserves* the <select> and its
  // <option> nodes across a poll (probed directly with expando properties), so
  // no interaction is lost to node replacement; and the live value survives a
  // change followed by a poll. What is left is latency, which is what a timeout
  // is for.
  //
  // It has to be on the `expect` calls: `test.slow()` raises the *test* budget,
  // but the 5 s that actually elapsed is `expect`'s own retry window.
  const SETTLE = { timeout: 15_000 };
  const HOUR = 60 * 60 * 1000;
  await page.goto('/');
  // The intervals live on the Schedule tab since NEWS-118.
  await openSettingsTab(page, 'Schedule');
  const dflt = page.locator('[data-action=interval]');
  const hp = page.locator('[data-action=hp-interval]');

  // Default 6h, high-priority 3h — valid (<=).
  await dflt.selectOption(String(6 * HOUR));
  await hp.selectOption(String(3 * HOUR));
  await expect(hp).toHaveValue(String(3 * HOUR), SETTLE);

  // Shorten the default below high-priority → high-priority follows *down*.
  await dflt.selectOption(String(HOUR));
  await expect(hp).toHaveValue(String(HOUR), SETTLE);

  // Lengthen high-priority above the default → the default follows *up*.
  await hp.selectOption(String(12 * HOUR));
  await expect(dflt).toHaveValue(String(12 * HOUR), SETTLE);

  // Restore a sane default so later serial tests aren't on a short interval.
  await dflt.selectOption(String(24 * HOUR));
  await page.locator('.dialog [data-action=close-settings]').click();
});

test('add, edit and clear a topic\u2019s guidance (NEWS-80)', async ({ page }) => {
  await page.goto('/');
  const target = row(page, 'Bravo Topic');
  await expect(target).toBeVisible();
  await expect(target.locator('.topic-flags .flag.guided')).toHaveCount(0);

  // The menu offers "Add guidance" while there is none.
  await target.click({ button: 'right' });
  await expect(page.locator('.menu-item span', { hasText: 'Add guidance' })).toBeVisible();
  await page.locator('[data-menu-action=guidance]').click();

  const dialog = page.locator('.dialog.guidance');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('textarea')).toHaveValue('');
  await dialog.locator('textarea').fill('Regulatory news only, not stock moves.');
  await dialog.locator('button[type=submit]').click();
  await expect(dialog).toHaveCount(0);

  // The row picks up a badge carrying the text, and it survives a reload.
  const badge = row(page, 'Bravo Topic').locator('.topic-flags .flag.guided');
  await expect(badge).toHaveCount(1);
  await expect(badge).toHaveAttribute('title', /Regulatory news only/);
  await page.reload();
  await expect(row(page, 'Bravo Topic').locator('.topic-flags .flag.guided')).toHaveCount(1);

  // Reopening shows what was saved, and the menu now offers Edit.
  await row(page, 'Bravo Topic').click({ button: 'right' });
  await expect(page.locator('.menu-item span', { hasText: 'Edit guidance' })).toBeVisible();
  await page.locator('[data-menu-action=guidance]').click();
  await expect(page.locator('.dialog.guidance textarea')).toHaveValue(
    'Regulatory news only, not stock moves.',
  );

  // Cancel leaves the saved text alone even after typing over it.
  await page.locator('.dialog.guidance textarea').fill('scratch that');
  await page.locator('[data-action=close-guidance]').click();
  await expect(page.locator('.dialog.guidance')).toHaveCount(0);
  await row(page, 'Bravo Topic').click({ button: 'right' });
  await page.locator('[data-menu-action=guidance]').click();
  await expect(page.locator('.dialog.guidance textarea')).toHaveValue(
    'Regulatory news only, not stock moves.',
  );

  // Clearing it removes the badge.
  await page.locator('.dialog.guidance textarea').fill('   ');
  await page.locator('.dialog.guidance button[type=submit]').click();
  await expect(page.locator('.dialog.guidance')).toHaveCount(0);
  await expect(row(page, 'Bravo Topic').locator('.topic-flags .flag.guided')).toHaveCount(0);
});

test('guidance is offered for one topic at a time (NEWS-80)', async ({ page }) => {
  // It is a paragraph about *this* topic, so a mixed selection has nothing
  // sensible to write \u2014 the menu item is disabled rather than absent.
  await page.goto('/');
  await row(page, 'Alpha Topic').click();
  await row(page, 'Bravo Topic').click({ modifiers: ['ControlOrMeta'] });
  await row(page, 'Bravo Topic').click({ button: 'right' });
  await expect(page.locator('[data-menu-action=guidance]')).toBeDisabled();
  await page.keyboard.press('Escape');
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

test('sorting by section groups the rail under headings (NEWS-140)', async ({ page }) => {
  await page.goto('/');
  // The mock classifies from the name, so these are also their own expectations:
  // "Soccer transfers" → Sports, "Fashion week" → Style.
  for (const name of ['Soccer transfers', 'Fashion week']) {
    await page.fill('.add-topic input', name);
    await page.press('.add-topic input', 'Enter');
    await expect(page.locator('.topic', { hasText: name })).toBeVisible();
  }
  // Classification lands on the first check, which runs in the background.
  await expect(page.locator('.topic-category', { hasText: 'Sports' }).first()).toBeVisible({ timeout: 15_000 });

  await page.selectOption('[data-action=topic-sort]', 'category');

  const headings = page.locator('.topic-section');
  await expect(headings.first()).toBeVisible();
  // A heading is structure, not an option — a listbox may only contain options,
  // and claiming otherwise would make it selectable to a screen reader.
  await expect(headings.first()).toHaveAttribute('role', 'presentation');
  await expect(page.locator('.topic-section', { hasText: 'Sports' })).toHaveCount(1);

  // Restore the default for the rest of the serial suite.
  await page.selectOption('[data-action=topic-sort]', 'alpha');
  await expect(page.locator('.topic-section')).toHaveCount(0);
});

test('renaming a topic keeps its stories by default (NEWS-139)', async ({ page }) => {
  await page.goto('/');
  await page.fill('.add-topic input', 'Renameable');
  await page.press('.add-topic input', 'Enter');
  const row = page.locator('.topic', { hasText: 'Renameable' });
  await expect(row).toBeVisible();
  // Wait for the first check so there are stories to keep.
  await expect(page.locator('.item', { hasText: 'Renameable' }).first()).toBeVisible({ timeout: 15_000 });
  const before = await page.locator('.item').count();

  await topicAction(page, row, 'rename');
  await expect(page.locator('.dialog.rename')).toBeVisible();
  // The clear option is offered because there is something to clear, and it is
  // unticked: renaming is usually a correction, not a reset.
  const clear = page.locator('.dialog.rename input[name=clear-items]');
  await expect(clear).toBeVisible();
  await expect(clear).not.toBeChecked();

  await page.fill('.dialog.rename input[name=topic-name]', 'Renamed Topic');
  await page.click('.dialog.rename button[type=submit]');

  await expect(page.locator('.dialog.rename')).toHaveCount(0);
  await expect(page.locator('.topic', { hasText: 'Renamed Topic' })).toBeVisible();
  await expect(page.locator('.item')).toHaveCount(before);
});

test('renaming can clear that topic’s stories, and only that topic’s', async ({ page }) => {
  await page.goto('/');
  const otherBefore = await page.locator('.item').count();
  const target = page.locator('.topic', { hasText: 'Renamed Topic' });
  const targetStories = await page.locator('.item', { hasText: 'Renamed Topic' }).count();
  expect(targetStories).toBeGreaterThan(0);

  await topicAction(page, target, 'rename');
  await page.fill('.dialog.rename input[name=topic-name]', 'Cleared Topic');
  await page.check('.dialog.rename input[name=clear-items]');
  await page.click('.dialog.rename button[type=submit]');

  await expect(page.locator('.dialog.rename')).toHaveCount(0);
  await expect(page.locator('.topic', { hasText: 'Cleared Topic' })).toBeVisible();
  // Its stories are gone; every other topic's are untouched.
  await expect(page.locator('.item', { hasText: 'Cleared Topic' })).toHaveCount(0);
  await expect(page.locator('.item')).toHaveCount(otherBefore - targetStories);
});

test('a duplicate name is refused without closing the dialog', async ({ page }) => {
  await page.goto('/');
  await page.fill('.add-topic input', 'Occupied Name');
  await page.press('.add-topic input', 'Enter');
  await expect(page.locator('.topic', { hasText: 'Occupied Name' })).toBeVisible();

  await topicAction(page, page.locator('.topic', { hasText: 'Cleared Topic' }), 'rename');
  await page.fill('.dialog.rename input[name=topic-name]', 'Occupied Name');
  await page.click('.dialog.rename button[type=submit]');

  // Stays open so the name can be corrected where the user is already looking.
  await expect(page.locator('.dialog.rename')).toBeVisible();
  await expect(page.locator('#banners')).toContainText('already exists');
  await page.click('[data-action=close-rename]');

  for (const name of ['Cleared Topic', 'Occupied Name']) {
    await topicAction(page, page.locator('.topic', { hasText: name }), 'delete');
  }
});
