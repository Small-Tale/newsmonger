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

  // Check, Pause, High priority, Edit topic, Guidance, Solo, Review Flagged, Delete
  // (NEWS-61 added Review Flagged; NEWS-80 Guidance; NEWS-139 the topic edit).
  await expect(page.locator('.menu-item')).toHaveCount(8);
  await expect(page.locator('.menu .icon')).toHaveCount(8);
  await expect(page.locator('.menu-sep')).toHaveCount(2);
  await expect(page.locator('.menu-item span').first()).toHaveText('Check now');

  // "Edit topic", never "Rename" (NEWS-162). A rename reads as relabelling
  // something; the name is the question put to the model, so changing it changes
  // what gets found. The dialog's hint has always said so — the menu item was
  // the thing contradicting it.
  await expect(page.locator('[data-menu-action=rename] span')).toHaveText('Edit topic…');
  await expect(page.locator('.menu')).not.toContainText('Rename');

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
  // `expect.poll`, not a bare `allTextContents()` (NEWS-238). Solo is filtered
  // **server-side** since NEWS-76, so the banner going up proves only that the
  // *store* knows — the feed arrives on a separate `/api/items` round trip a
  // moment later. A one-shot read samples the window in between and sees the
  // unfiltered feed, which is what failed here on loaded runners while passing
  // everywhere quiet: the assertion was right and had no way to wait for it.
  const shownTopics = async (): Promise<string[]> =>
    [...new Set((await page.locator('.item .item-topic').allTextContents()).map((t) => t.trim()))].sort();
  await expect.poll(shownTopics, { timeout: 15_000 }).toEqual(['Alpha Topic']);

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
  //
  // Raised 15 s → 30 s after this flaked again on a GitHub windows-latest runner
  // (NEWS-235). Before widening it I re-probed the mechanism, since a 15 s wait
  // for two localhost round trips is a fair thing to be suspicious of — the
  // specific worry being that a `<select>` the user has already changed is
  // "dirty", and per the HTML spec does not move when `selected` is written onto
  // its options, which is exactly what a morph does. **Measured: it is not that.**
  // On an idle machine the clamp lands within 250 ms with `value`, `selectedIndex`
  // and the `selected` attribute all moving together.
  //
  // So the number is headroom for a starved runner, not cover for a bug: typical
  // is ~250 ms, and a real regression — a clamp that never arrives — fails at any
  // timeout, because the value simply never changes.
  //
  // **The window must stay below the test's own budget.** `playwright.config.ts`
  // sets `timeout: 30_000` for the whole test, so a 30 s expect window can never
  // be exhausted — the test dies first and reports "Test timeout exceeded"
  // instead of naming the assertion that failed. That is what v0.2.0-beta.8's
  // Windows run produced, and it cost real time to read. `test.slow()` triples
  // the *test* budget, which is what makes a long expect window usable at all.
  test.slow();
  const SETTLE = { timeout: 30_000 };
  const HOUR = 60 * 60 * 1000;

  /**
   * The clamp is a *server* rule (NEWS-56); the UI merely reflects it. Asserting
   * both, in that order, makes a future failure say which half broke — a bare UI
   * timeout cannot distinguish "the server never clamped" from "the server
   * clamped and the render lagged", and those have nothing in common.
   */
  const expectServerSettings = async (checkIntervalMs: number, highPriorityIntervalMs: number): Promise<void> => {
    await expect
      .poll(
        async () => {
          const res = await page.request.get('/api/state');
          const body = (await res.json()) as {
            settings: { checkIntervalMs: number; highPriorityIntervalMs: number };
          };
          return `${String(body.settings.checkIntervalMs)}/${String(body.settings.highPriorityIntervalMs)}`;
        },
        { timeout: 15_000 },
      )
      .toBe(`${String(checkIntervalMs)}/${String(highPriorityIntervalMs)}`);
  };
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
  await expectServerSettings(HOUR, HOUR);
  await expect(hp).toHaveValue(String(HOUR), SETTLE);

  // Lengthen high-priority above the default → the default follows *up*.
  await hp.selectOption(String(12 * HOUR));
  await expectServerSettings(12 * HOUR, 12 * HOUR);
  await expect(dflt).toHaveValue(String(12 * HOUR), SETTLE);

  // Restore a sane default so later serial tests aren't on a short interval.
  await dflt.selectOption(String(24 * HOUR));
  await page.locator('.dialog [data-action=close-settings]').click();
});

test('add, edit and clear a topic\u2019s guidance (NEWS-80)', async ({ page }) => {
  await page.goto('/');
  const target = row(page, 'Bravo Topic');
  await expect(target).toBeVisible();
  // Guidance shows as text under the name since NEWS-143, not as a badge.
  await expect(target.locator('.topic-guidance')).toHaveCount(0);

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

  // The row shows the guidance itself, and it survives a reload.
  const preview = row(page, 'Bravo Topic').locator('.topic-guidance');
  await expect(preview).toHaveText(/Regulatory news only/);
  await page.reload();
  await expect(row(page, 'Bravo Topic').locator('.topic-guidance')).toHaveText(/Regulatory news only/);

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

  // Clearing it removes the preview.
  await page.locator('.dialog.guidance textarea').fill('   ');
  await page.locator('.dialog.guidance button[type=submit]').click();
  await expect(page.locator('.dialog.guidance')).toHaveCount(0);
  await expect(row(page, 'Bravo Topic').locator('.topic-guidance')).toHaveCount(0);
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

  // A heading reads as structure, not as a fenced-off block (NEWS-154). Sized
  // against the "Watching" eyebrow rather than a magic number, because that
  // comparison *is* the complaint: the headings dividing the list were a hair
  // smaller than the label for the list itself, which is backwards.
  const type = await page.evaluate(() => {
    const heading = document.querySelector('.topic-section');
    const eyebrow = document.querySelector('.topics-panel .eyebrow');
    if (!heading || !eyebrow) return null;
    const h = getComputedStyle(heading);
    return {
      size: Number.parseFloat(h.fontSize),
      eyebrowSize: Number.parseFloat(getComputedStyle(eyebrow).fontSize),
      border: Number.parseFloat(h.borderBottomWidth),
    };
  });
  expect(type).not.toBeNull();
  expect(type?.size ?? 0).toBeGreaterThan(type?.eyebrowSize ?? 0);
  // The rule went with the row rules (NEWS-151) — an underlined heading in a
  // list with no other rules is the one thing fenced in.
  expect(type?.border).toBe(0);

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

  // The dialog says Edit/Save too, not Rename (NEWS-162).
  await expect(page.locator('.dialog.rename h2')).toContainText('Edit');
  await expect(page.locator('.dialog.rename button[type=submit]')).toHaveText('Save');
  await expect(page.locator('.dialog.rename')).toHaveAttribute('aria-label', /^Edit topic /);
  await page.fill('.dialog.rename input[name=topic-name]', 'Renamed Topic');
  await page.click('.dialog.rename button[type=submit]');

  await expect(page.locator('.dialog.rename')).toHaveCount(0);
  await expect(page.locator('.topic', { hasText: 'Renamed Topic' })).toBeVisible();
  await expect(page.locator('.item')).toHaveCount(before);
});

test('renaming can clear that topic’s stories, and only that topic’s', async ({ page }) => {
  await page.goto('/');
  const target = page.locator('.topic', { hasText: 'Renamed Topic' });
  // Wait for the feed to be on screen **before counting anything**. Counting
  // straight after `goto` reads a half-rendered feed: `otherBefore` was captured
  // at 2 while `targetStories` resolved to 4 a moment later, so the assertion at
  // the end expected **-2** items — an impossible count, which is what gave it
  // away. Found on a slower machine (Windows under Parallels, NEWS-209); macOS
  // renders fast enough to hide it, and Playwright's retry papered over it by
  // re-running against different state.
  await expect(page.locator('.item', { hasText: 'Renamed Topic' }).first()).toBeVisible({ timeout: 15_000 });
  const otherBefore = await page.locator('.item').count();
  const targetStories = await page.locator('.item', { hasText: 'Renamed Topic' }).count();
  expect(targetStories).toBeGreaterThan(0);
  // The arithmetic below is only meaningful if both counts came from the same
  // settled render. Asserting it here fails with something readable instead of an
  // expected count that cannot exist.
  expect(otherBefore).toBeGreaterThanOrEqual(targetStories);

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

test('the context menu stays on screen near the window edge (NEWS-149)', async ({ page }) => {
  // The menu is `position: fixed` inside a full-screen backdrop, so an item that
  // lands past the bottom edge cannot be scrolled back — it is simply
  // unreachable. Delete is the last of eight items, so the bottom edge takes the
  // most destructive action away first.
  //
  // A short viewport is what makes this deterministic: the menu is ~300px tall,
  // so in 420px of height there is nowhere below a topic row for it to fit, and
  // the old raw-cursor placement ran straight off the bottom.
  await page.setViewportSize({ width: 1280, height: 420 });
  await page.goto('/');
  await page.fill('.add-topic input', 'Edge Case');
  await page.press('.add-topic input', 'Enter');
  const row = page.locator('.topic', { hasText: 'Edge Case' });
  await expect(row).toBeVisible();

  await row.click({ button: 'right' });
  await expect(page.locator('.menu')).toBeVisible();

  const fits = await page.evaluate(() => {
    const menu = document.querySelector('.menu');
    const last = document.querySelector('[data-menu-action=delete]');
    if (!menu || !last) return null;
    const m = menu.getBoundingClientRect();
    const l = last.getBoundingClientRect();
    return {
      menuBottom: m.bottom,
      viewport: window.innerHeight,
      menuInside: m.left >= 0 && m.top >= 0 && m.right <= window.innerWidth && m.bottom <= window.innerHeight,
      // The real question is not "is the box on screen" but "can this be
      // clicked" — a menu whose box fits while its last item does not is the
      // exact bug, so the last item is what gets asserted.
      lastInside: l.bottom <= window.innerHeight && l.right <= window.innerWidth,
    };
  });
  expect(fits).not.toBeNull();
  expect(fits?.menuInside, `menu bottom ${String(fits?.menuBottom)} vs ${String(fits?.viewport)}`).toBe(true);
  expect(fits?.lastInside).toBe(true);

  // And it is genuinely clickable, not merely measured to be inside.
  await page.locator('[data-menu-action=delete]').click();
  await acceptConfirm(page);
  await expect(page.locator('.topic', { hasText: 'Edge Case' })).toHaveCount(0);

  await page.setViewportSize({ width: 1280, height: 800 });
});

test('a cleared topic can be undone from the toast (NEWS-145)', async ({ page }) => {
  // Deleting a topic asks for confirmation while clearing its stories was only a
  // checkbox — and clearing is just as permanent. The Undo is what makes that
  // asymmetry defensible rather than an accident of implementation.
  await page.goto('/');
  await page.fill('.add-topic input', 'Undoable');
  await page.press('.add-topic input', 'Enter');
  const row = page.locator('.topic', { hasText: 'Undoable' });
  await expect(row).toBeVisible();
  await expect(page.locator('.item', { hasText: 'Undoable' }).first()).toBeVisible({ timeout: 15_000 });
  const stories = await page.locator('.item', { hasText: 'Undoable' }).count();
  expect(stories).toBeGreaterThan(0);

  // Bookmark one, to prove the restore brings back the *same* stories and not
  // fresh copies of them — a new id would keep the text and lose the bookmark.
  const first = page.locator('.item', { hasText: 'Undoable' }).first();
  await first.locator('[data-save-item]').click();
  await expect(first.locator('[data-save-item][data-saved=true]')).toBeVisible();

  await topicAction(page, row, 'rename');
  await page.fill('.dialog.rename input[name=topic-name]', 'Undone');
  await page.check('.dialog.rename input[name=clear-items]');
  await page.click('.dialog.rename button[type=submit]');
  await expect(page.locator('.dialog.rename')).toHaveCount(0);
  await expect(page.locator('.item', { hasText: 'Undone' })).toHaveCount(0);

  // The toast names what was lost rather than saying "some stories", and the
  // count comes from the number the dialog already had (FR-25.5a).
  const toast = page.locator('.toast');
  await expect(toast).toContainText(`cleared ${String(stories)}`);
  await toast.locator('.toast-undo').click();

  await expect(page.locator('.item', { hasText: 'Undone' })).toHaveCount(stories);
  await expect(page.locator('.toast')).toContainText('Stories restored');
  // The bookmark survived, so these are the original rows.
  await expect(page.locator('.item', { hasText: 'Undone' }).locator('[data-save-item][data-saved=true]')).toHaveCount(1);

  await topicAction(page, page.locator('.topic', { hasText: 'Undone' }), 'delete');
});

test('a plain toast offers no undo, and does not block clicks (NEWS-145)', async ({ page }) => {
  // `.toast` is `pointer-events: none` precisely so a transient notice can't
  // swallow a click meant for the page; only the actionable one opts back in.
  await page.goto('/');
  await page.fill('.add-topic input', 'Plain Toast');
  await page.press('.add-topic input', 'Enter');
  const row = page.locator('.topic', { hasText: 'Plain Toast' });
  await expect(row).toBeVisible();

  await topicAction(page, row, 'rename');
  await page.fill('.dialog.rename input[name=topic-name]', 'Plain Toasted');
  await page.click('.dialog.rename button[type=submit]');
  await expect(page.locator('.dialog.rename')).toHaveCount(0);

  const toast = page.locator('.toast');
  await expect(toast).toBeVisible();
  await expect(toast.locator('.toast-undo')).toHaveCount(0);
  await expect(toast).not.toHaveClass(/actionable/);
  expect(await toast.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none');

  await topicAction(page, page.locator('.topic', { hasText: 'Plain Toasted' }), 'delete');
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

test('a long topic name wraps instead of being truncated (NEWS-142)', async ({ page }) => {
  // A topic name is the question the app asks, so an ellipsis hides the part
  // that tells two similar topics apart.
  await page.goto('/');
  const long = '3D chip stacking and advanced packaging for AI accelerators';
  await page.fill('.add-topic input', long);
  await page.press('.add-topic input', 'Enter');
  const name = page.locator('.topic', { hasText: long }).locator('.topic-name');
  await expect(name).toBeVisible();

  const box = await name.boundingBox();
  // Guard against a zero-sized box making the overflow check vacuous (NEWS-111).
  expect(box?.width ?? 0).toBeGreaterThan(50);

  const metrics = await name.evaluate((el) => ({
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
    lines: Math.round(el.getBoundingClientRect().height / Number.parseFloat(getComputedStyle(el).lineHeight)),
  }));
  // It actually wrapped…
  expect(metrics.lines).toBeGreaterThan(1);
  // …and nothing is spilling sideways out of the rail.
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);

  await topicAction(page, page.locator('.topic', { hasText: long }), 'delete');
});

test('guidance shows as text, and expands for a sole selection (NEWS-143)', async ({ page }) => {
  await page.goto('/');
  await page.fill('.add-topic input', 'Guided Topic');
  await page.press('.add-topic input', 'Enter');
  const row = page.locator('.topic', { hasText: 'Guided Topic' });
  await expect(row).toBeVisible();

  const guidance = Array.from({ length: 12 }, (_, i) => `Guidance line number ${String(i + 1)} of the steer.`).join(' ');
  await topicAction(page, row, 'guidance');
  await page.fill('.dialog.guidance textarea', guidance);
  await page.click('.dialog.guidance button[type=submit]');
  await expect(page.locator('.dialog.guidance')).toHaveCount(0);

  // The text itself, not an icon standing for it.
  const preview = row.locator('.topic-guidance');
  await expect(preview).toBeVisible();
  await expect(preview).toContainText('Guidance line number 1');
  await expect(row.locator('.flag.guided')).toHaveCount(0);

  const clamped = await preview.evaluate((el) => el.clientHeight);
  await row.click();
  await expect(row).toHaveClass(/selected/);
  const expanded = await preview.evaluate((el) => el.clientHeight);
  // A sole selection is the one moment the user is asking about this topic.
  expect(expanded).toBeGreaterThan(clamped);

  await page.keyboard.press('Escape');
  await topicAction(page, row, 'delete');
});

test('the sidebar shows today\'s story count and can sort by newest (NEWS-242, NEWS-241)', async ({
  page,
}) => {
  await page.goto('/');
  await page.fill('.add-topic input', 'Badge Probe');
  await page.press('.add-topic input', 'Enter');
  const row = page.locator('.topic', { hasText: 'Badge Probe' });
  await expect(row).toBeVisible();

  // Adding a topic fires an immediate check (FR-1.12) and the mock returns two
  // stories, so a badge should appear on its own without a manual check.
  await expect(row.locator('.today-count')).toHaveText('2', { timeout: 20_000 });
  await expect(row.locator('.today-count')).toHaveAttribute('title', /2 stories found today/);

  // A topic with nothing today shows no badge at all — not a zero. The "empty"
  // topic never checks successfully, so it never has stories.
  // Name deliberately shares no substring with the one above — `hasText` is a
  // case-insensitive substring match, so "empty badge probe" would also match
  // the "Badge Probe" locator and both would resolve to two elements.
  // "empty" is what makes the mock provider return no stories.
  await page.fill('.add-topic input', 'Quiet empty subject');
  await page.press('.add-topic input', 'Enter');
  const quiet = page.locator('.topic', { hasText: 'Quiet empty subject' });
  await expect(quiet).toBeVisible();
  await expect(quiet.locator('.today-count')).toHaveCount(0);

  // The new sort option exists and is selectable.
  const sort = page.locator('[data-action=topic-sort]');
  await sort.selectOption('recent');
  await expect(sort).toHaveValue('recent');
  // The topic with stories sorts above the one without — an absent timestamp
  // must sink, not float.
  await expect(page.locator('.topic-name').first()).toHaveText('Badge Probe');

  // It persists across a reload, like the other sort choices (NEWS-63).
  await page.reload();
  await expect(page.locator('[data-action=topic-sort]')).toHaveValue('recent');

  await sort.selectOption('alpha');
  await topicAction(page, row, 'delete');
  await topicAction(page, quiet, 'delete');
});
