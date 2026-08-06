import AxeBuilder from '@axe-core/playwright';

import { expect, resetSharedState,seedCheckedTopic, test, topicAction, workerBaseURL } from './fixtures.js';

// The story card and the feed around it: bookmarking, sharing, expanding,
// flagging off-topic, search, the multi-column layout, and outlets (NEWS-322
// split this out of app.spec.ts).

test.describe.configure({ mode: 'serial' });

// Every attempt starts from a known server, including a serial retry — see
// `resetSharedState` (NEWS-101) and `seedCheckedTopic` (NEWS-322). No file
// inherits its precondition from another's leftovers (NEWS-313).
test.beforeAll(async () => {
  const baseURL = workerBaseURL();
  await resetSharedState(baseURL);
  await seedCheckedTopic(baseURL, 'Story Card Topic');
});

test('bookmark a story and filter to saved (NEWS-42)', async ({ page }) => {
  // Needs stories in the feed. Add a topic and check it (mock returns 2).
  await page.goto('/');
  await page.fill('.add-topic input', 'saved probe topic');
  await page.press('.add-topic input', 'Enter');
  const row = page.locator('.topic', { hasText: 'saved probe topic' });
  await expect(row).toBeVisible();
  await topicAction(page, row, 'check');
  await expect(page.locator('.item', { hasText: 'saved probe topic' }).first()).toBeVisible({ timeout: 15_000 });

  const probeItems = page.locator('.item', { has: page.locator('.item-topic', { hasText: 'saved probe topic' }) });
  const before = await probeItems.count();
  expect(before).toBeGreaterThan(0);

  // Bookmark the first of this topic's stories.
  await probeItems.first().locator('[data-save-item]').click();
  await expect(probeItems.first()).toHaveClass(/saved/);
  await expect(probeItems.first().locator('.item-action.bookmark.on')).toHaveCount(1);

  // Filter to saved: only saved stories show, and the banner reports a count.
  await page.click('[data-action=toggle-saved-filter]');
  await expect(page.locator('.banner.saved')).toBeVisible();
  await expect(page.locator('.item:not(.saved)')).toHaveCount(0);
  await expect(page.locator('.item.saved')).not.toHaveCount(0);

  // Unbookmark while filtered removes it from view.
  const savedShown = await page.locator('.item.saved').count();
  await page.locator('.item.saved').first().locator('[data-save-item]').click();
  await expect(page.locator('.item.saved')).toHaveCount(savedShown - 1);

  // The filter is ephemeral — a reload clears it (but not the saved flags).
  await page.reload();
  await expect(page.locator('.banner.saved')).toHaveCount(0);

  // Clean up.
  await topicAction(page, page.locator('.topic', { hasText: 'saved probe topic' }), 'delete');
  await expect(page.locator('.topic', { hasText: 'saved probe topic' })).toHaveCount(0);
});

test('share a story via the OS sheet, or fall back to the clipboard (NEWS-43)', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  await page.fill('.add-topic input', 'share probe topic');
  await page.press('.add-topic input', 'Enter');
  const row = page.locator('.topic', { hasText: 'share probe topic' });
  await expect(row).toBeVisible();
  await topicAction(page, row, 'check');

  const probeItems = page.locator('.item', { has: page.locator('.item-topic', { hasText: 'share probe topic' }) });
  await expect(probeItems.first()).toBeVisible({ timeout: 15_000 });
  const first = probeItems.first();
  const title = (await first.locator('h3').textContent())?.trim() ?? '';
  expect(title).not.toBe('');

  // Share-sheet path: with navigator.share present, the story goes to the OS
  // sheet (title + summary + url) and no clipboard toast appears.
  await page.evaluate(() => {
    (window as unknown as { __shared?: unknown }).__shared = undefined;
    (navigator as unknown as { share: (d: unknown) => Promise<void> }).share = (d: unknown) => {
      (window as unknown as { __shared?: unknown }).__shared = d;
      return Promise.resolve();
    };
  });
  await first.locator('[data-share-item]').click();
  const shared = await page.evaluate(() => (window as unknown as { __shared?: { title?: string; url?: string } }).__shared);
  expect(shared?.title).toBe(title);
  expect(shared?.url).toContain('http');
  await expect(page.locator('.toast')).toHaveCount(0);

  // Fallback path: with no share sheet, the same content lands on the clipboard
  // and a toast confirms it.
  await page.evaluate(() => {
    delete (navigator as unknown as { share?: unknown }).share;
  });
  await first.locator('[data-share-item]').click();
  await expect(page.locator('.toast')).toHaveText('Copied to clipboard');
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toContain(title);
  expect(clip).toContain('http');

  // The toast clears itself.
  await expect(page.locator('.toast')).toHaveCount(0, { timeout: 5_000 });

  // Clean up.
  await topicAction(page, row, 'delete');
  await expect(page.locator('.topic', { hasText: 'share probe topic' })).toHaveCount(0);
});

test('expanding a story card opens a detail pane in place (NEWS-281)', async ({ page }) => {
  await page.goto('/');
  await page.fill('.add-topic input', 'expand probe topic');
  await page.press('.add-topic input', 'Enter');
  const row = page.locator('.topic', { hasText: 'expand probe topic' });
  await expect(row).toBeVisible();
  await topicAction(page, row, 'check');

  const probeItems = page.locator('.item', { has: page.locator('.item-topic', { hasText: 'expand probe topic' }) });
  await expect(probeItems).toHaveCount(2, { timeout: 15_000 });
  const card = probeItems.first();
  const other = probeItems.nth(1);
  const expander = card.locator('[data-expand-item]');
  const pane = card.locator('.item-pane');

  // The pane is always in the DOM and *empty* while collapsed — it is the
  // expander's `aria-controls` target, and an always-present container is what
  // keeps the card from being restructured (docs/3-ui.md).
  await expect(pane).toHaveCount(1);
  await expect(pane).toBeHidden();
  const paneId = await pane.getAttribute('id');
  expect(paneId).toBeTruthy();
  await expect(expander).toHaveAttribute('aria-controls', paneId ?? '');
  await expect(expander).toHaveAttribute('aria-expanded', 'false');

  // The gesture: a click on the card body expands it in place. It must not open
  // a browser — the source links do that, and this pane is the app-native half.
  await card.locator('h3').click();
  await expect(expander).toHaveAttribute('aria-expanded', 'true');
  await expect(pane).toBeVisible();
  await expect(card).toHaveClass(/expanded/);

  // Clicking the body again collapses it.
  await card.locator('h3').click();
  await expect(expander).toHaveAttribute('aria-expanded', 'false');
  await expect(pane).toBeHidden();

  // An accordion: opening a second story closes the first. The feed's grid rows
  // stretch to the tallest card on the line, so two open panes grow a row twice.
  await card.locator('p').click();
  await other.locator('h3').click();
  await expect(other.locator('[data-expand-item]')).toHaveAttribute('aria-expanded', 'true');
  await expect(expander).toHaveAttribute('aria-expanded', 'false');

  // Escape collapses.
  await page.keyboard.press('Escape');
  await expect(other.locator('[data-expand-item]')).toHaveAttribute('aria-expanded', 'false');

  // THE regression that matters: a source link is followed and the card does not
  // move. Both handlers match the same click — `delegate()` walks up from the
  // target — so without the `ul.sources` guard a link opens a tab *and* toggles.
  // The request is aborted rather than attempted: the mock's URLs are fictional
  // and the suite must not depend on the network.
  await page.context().route('**://*.example.com/**', (r) => void r.abort());
  const link = card.locator('ul.sources a').first();
  expect(await link.getAttribute('href')).toMatch(/^https?:\/\//);
  const popupPromise = page.waitForEvent('popup');
  await link.click();
  const popup = await popupPromise;
  await popup.close();
  await page.context().unroute('**://*.example.com/**');
  await expect(expander).toHaveAttribute('aria-expanded', 'false');

  // Same for the header controls: bookmark still toggles, and the card stays put.
  await card.locator('[data-save-item]').click();
  await expect(card).toHaveClass(/saved/);
  await expect(expander).toHaveAttribute('aria-expanded', 'false');
  await card.locator('[data-save-item]').click();
  await expect(card).not.toHaveClass(/saved/);
  await expect(expander).toHaveAttribute('aria-expanded', 'false');

  await page.evaluate(() => {
    (navigator as unknown as { share: (d: unknown) => Promise<void> }).share = () => Promise.resolve();
  });
  await card.locator('[data-share-item]').click();
  await expect(expander).toHaveAttribute('aria-expanded', 'false');

  // Right-click still opens the story menu, unchanged, and does not expand.
  await card.locator('h3').click({ button: 'right' });
  await expect(page.locator('.menu [data-item-menu-action=flag]')).toBeVisible();
  await expect(expander).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('Escape');
  await expect(page.locator('.menu')).toHaveCount(0);

  // Keyboard-only. The <article> is deliberately NOT focusable — a click handler
  // on it would be a dead end for a keyboard user and an axe failure — so the
  // expander is a real button that Enter and Space both operate.
  expect(await card.evaluate((el) => el.hasAttribute('tabindex'))).toBe(false);
  await expander.press('Enter');
  await expect(expander).toBeFocused();
  await expect(expander).toHaveAttribute('aria-expanded', 'true');
  await expander.press(' ');
  await expect(expander).toHaveAttribute('aria-expanded', 'false');

  // Clean up.
  await topicAction(page, row, 'delete');
  await expect(page.locator('.topic', { hasText: 'expand probe topic' })).toHaveCount(0);
});

test('a flagged one-liner and a review card do not expand (NEWS-281)', async ({ page }) => {
  // Neither variant carries an expander, and the click handler keys off the
  // button's presence — so this asserts the two exemptions in one pass.
  await page.goto('/');
  await page.fill('.add-topic input', 'inert expand topic');
  await page.press('.add-topic input', 'Enter');
  const row = page.locator('.topic', { hasText: 'inert expand topic' });
  await expect(row).toBeVisible();
  const cards = page.locator('.item:not(.flagged-row)', {
    has: page.locator('.item-topic', { hasText: 'inert expand topic' }),
  });
  await expect(cards).toHaveCount(2, { timeout: 15_000 });

  // Expand one story, then flag it: the pane has to go with the card, which is
  // about to become a dimmed one-liner with nothing left to close it.
  await cards.first().locator('h3').click();
  await expect(cards.first().locator('[data-expand-item]')).toHaveAttribute('aria-expanded', 'true');
  await cards.first().click({ button: 'right' });
  await page.locator('[data-item-menu-action=flag]').click();

  const flagged = page.locator('.item.flagged-row', { hasText: 'inert expand topic' });
  await expect(flagged).toHaveCount(1);
  await expect(flagged.locator('[data-expand-item]')).toHaveCount(0);
  await expect(flagged.locator('.item-pane')).toHaveCount(0);
  // A dimmed row is on its way out of the feed: clicking its title does nothing.
  await flagged.locator('.flagged-title').click();
  await expect(flagged.locator('.item-pane')).toHaveCount(0);
  await expect(page.locator('.item-pane:not(:empty)')).toHaveCount(0);

  // Review mode is triage — "is this about my topic?" — so its cards carry the
  // off-topic pill where the expander would be, and the body click is inert.
  await row.click({ button: 'right' });
  await page.locator('[data-menu-action=review-flagged]').click();
  await expect(page.locator('.banner.review')).toBeVisible();
  const reviewCard = page.locator('.item', { has: page.locator('.off-topic-pill.label') }).first();
  await expect(reviewCard).toBeVisible();
  await expect(reviewCard.locator('[data-expand-item]')).toHaveCount(0);
  await reviewCard.locator('h3').click();
  await expect(page.locator('.item-pane:not(:empty)')).toHaveCount(0);

  // Clean up: leave review mode and remove the topic.
  await page.locator('.banner.review [data-action=exit-review]').click();
  await expect(page.locator('.banner.review')).toHaveCount(0);
  await topicAction(page, row, 'delete');
  await expect(page.locator('.topic', { hasText: 'inert expand topic' })).toHaveCount(0);
});

test('an expanded card is accessible in both themes (NEWS-281)', async ({ page }) => {
  await page.goto('/');
  await page.fill('.add-topic input', 'axe expand topic');
  await page.press('.add-topic input', 'Enter');
  const row = page.locator('.topic', { hasText: 'axe expand topic' });
  await expect(row).toBeVisible();
  const cardFor = () =>
    page.locator('.item', { has: page.locator('.item-topic', { hasText: 'axe expand topic' }) }).first();
  await expect(cardFor()).toBeVisible({ timeout: 15_000 });

  for (const scheme of ['light', 'dark'] as const) {
    // Emulate *then* navigate, as `a11y.spec.ts` does. Flipping the scheme on a
    // live page animates every `.btn` through its colour transition, and axe
    // scanning mid-flight reports an interpolated frame that is on screen for
    // 120ms and fails contrast — a violation in neither theme.
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto('/');
    const card = cardFor();
    await expect(card).toBeVisible({ timeout: 15_000 });
    // Expansion is ephemeral, so each reload starts collapsed.
    await card.locator('[data-expand-item]').click();
    await expect(card.locator('.item-pane')).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    expect(serious, `expanded card / ${scheme}`).toEqual([]);
  }
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');

  // Clean up.
  await topicAction(page, row, 'delete');
  await expect(page.locator('.topic', { hasText: 'axe expand topic' })).toHaveCount(0);
});

test('flag a story off-topic: collapse, hide on reload, review, unflag (NEWS-61)', async ({ page }) => {
  await page.goto('/');
  await page.fill('.add-topic input', 'Apple Probe');
  await page.press('.add-topic input', 'Enter');
  const row = page.locator('.topic', { hasText: 'Apple Probe' });
  await expect(row).toBeVisible();
  const cards = page.locator('.item:not(.flagged-row)', { has: page.locator('.item-topic', { hasText: 'Apple Probe' }) });
  await expect(cards).toHaveCount(2, { timeout: 15_000 });

  // Right-click the first story → the item context menu → Flag: Off topic.
  await cards.first().click({ button: 'right' });
  await expect(page.locator('.menu [data-item-menu-action=flag]')).toContainText('Flag: Off topic');
  await page.locator('[data-item-menu-action=flag]').click();

  // It collapses to a dimmed one-liner with the pill; one full card remains.
  const flaggedRow = page.locator('.item.flagged-row', { hasText: 'Apple Probe' });
  await expect(flaggedRow).toHaveCount(1);
  await expect(flaggedRow.locator('.off-topic-pill')).toBeVisible();
  await expect(cards).toHaveCount(1);

  // A flagged story's menu offers ONLY Unflag — no bookmark/share (NEWS-70).
  await flaggedRow.click({ button: 'right' });
  await expect(page.locator('.menu .menu-item')).toHaveCount(1);
  await expect(page.locator('.menu [data-item-menu-action=flag]')).toContainText('Unflag');
  await page.keyboard.press('Escape');
  await expect(page.locator('.menu')).toHaveCount(0);

  // Clicking the pill prompts to unflag; cancelling keeps it flagged.
  await flaggedRow.locator('.off-topic-pill').click();
  await expect(page.locator('.dialog.confirm')).toBeVisible();
  await page.locator('[data-action=confirm-cancel]').click();
  await expect(flaggedRow).toHaveCount(1);

  // Enter review WITHOUT reloading first — the collapsed row must morph into a
  // full card cleanly (a distinct data-key makes kerf swap, not reshape).
  await row.click({ button: 'right' });
  await page.locator('[data-menu-action=review-flagged]').click();
  await expect(page.locator('.banner.review')).toBeVisible();
  await expect(cards).toHaveCount(1);
  await expect(page.locator('.item .off-topic-pill.label')).toHaveCount(1);

  // The way out has to look pressable (NEWS-266). It was `btn subtle`, then
  // `background: none; border-color: transparent`, so the only exit from a mode
  // that filters the whole feed was indistinguishable from the sentence beside it
  // until hovered. Checked by computed style rather than class name: a future
  // change to `.btn` that dropped its border would pass a class assertion while
  // bringing the bug back.
  const exitEdge = await page.evaluate(() => {
    const el = document.querySelector('[data-action=exit-review]');
    if (el === null) throw new Error('exit-review not rendered');
    const cs = getComputedStyle(el);
    return { color: cs.borderTopColor, width: cs.borderTopWidth };
  });
  expect(exitEdge.width, 'the exit needs a visible edge').not.toBe('0px');
  expect(exitEdge.color, 'a transparent border is not an affordance').not.toBe('transparent');
  expect(exitEdge.color).not.toMatch(/rgba\(.*,\s*0\)$/);

  await page.locator('[data-action=exit-review]').click();
  await expect(page.locator('.banner.review')).toHaveCount(0);
  await expect(flaggedRow).toHaveCount(1); // back to the collapsed row

  // On reload the flagged story is hidden entirely (not just collapsed).
  await page.reload();
  await expect(row).toBeVisible();
  await expect(page.locator('.item.flagged-row')).toHaveCount(0);
  await expect(cards).toHaveCount(1);

  // Enter review mode from the topic menu; the badge shows the flagged count.
  await row.click({ button: 'right' });
  const reviewItem = page.locator('[data-menu-action=review-flagged]');
  await expect(reviewItem).toBeEnabled();
  await expect(reviewItem.locator('.count-badge')).toHaveText('1');
  await reviewItem.click();

  // Review shows the banner and ONLY the flagged story, as a card with a pill.
  await expect(page.locator('.banner.review')).toBeVisible();
  await expect(cards).toHaveCount(1);
  await expect(page.locator('.item .off-topic-pill.label')).toHaveCount(1);

  // Unflag it from the item menu; exit review; both stories are back.
  await cards.first().click({ button: 'right' });
  await expect(page.locator('[data-item-menu-action=flag]')).toContainText('Unflag');
  await page.locator('[data-item-menu-action=flag]').click();
  await page.locator('[data-action=exit-review]').click();
  await expect(page.locator('.banner.review')).toHaveCount(0);
  await expect(cards).toHaveCount(2);

  // Clean up.
  await topicAction(page, row, 'delete');
  await expect(row).toHaveCount(0);
});

test('search filters the feed live, and clearing restores it (NEWS-60)', async ({ page }) => {
  await page.goto('/');
  await page.fill('.add-topic input', 'Search Probe');
  await page.press('.add-topic input', 'Enter');
  const row = page.locator('.topic', { hasText: 'Search Probe' });
  await expect(row).toBeVisible();
  const probeItems = page.locator('.item', { has: page.locator('.item-topic', { hasText: 'Search Probe' }) });
  await expect(probeItems).toHaveCount(2, { timeout: 15_000 });

  const box = page.locator('.search');
  const input = page.locator('[data-action=search]');

  // "experts" appears in only one of the two deterministic mock stories.
  await input.fill('experts');
  await expect(box).toHaveClass(/has-query/); // the box widens when it has a query
  await expect(probeItems).toHaveCount(1);
  await expect(probeItems.first()).toContainText(/experts/i);

  // A no-match query shows the empty state (all topics filtered out).
  await input.fill('zzznotarealword');
  await expect(page.locator('#feed .empty')).toContainText('No stories match');

  // Clearing restores the full feed and collapses the box.
  await page.locator('[data-action=clear-search]').click();
  await expect(input).toHaveValue('');
  await expect(box).not.toHaveClass(/has-query/);
  await expect(probeItems).toHaveCount(2);

  // Clean up.
  await topicAction(page, row, 'delete');
  await expect(row).toHaveCount(0);
});

test('the feed lays out as a multi-column grid on a wide display (NEWS-64)', async ({ page }) => {
  // 1100px, not the 1280 this test used before NEWS-96. Removing the shell's
  // 1060px cap means 1280 now has room for two columns *with* the sidebar
  // shown, so it no longer exercises the narrow case this test is about. 1100
  // is the same shape the test always had: one column beside the sidebar, more
  // without it.
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.goto('/');
  await page.fill('.add-topic input', 'Grid Probe');
  await page.press('.add-topic input', 'Enter');
  const row = page.locator('.topic', { hasText: 'Grid Probe' });
  await expect(row).toBeVisible();
  await expect(page.locator('.item:not(.flagged-row)').first()).toBeVisible({ timeout: 15_000 });

  const trackCount = async (): Promise<number> =>
    page.locator('#feed .day').first().evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);

  // Sidebar shown: the feed is narrow → a single column.
  if ((await page.locator('.shell.sidebar-collapsed').count()) > 0) {
    await page.locator('[data-action=toggle-sidebar]').click();
  }
  await expect.poll(trackCount).toBe(1);

  // Hide the sidebar: the feed widens → more columns. Asserted as "strictly
  // more" rather than a fixed number — how much room a column takes is a
  // styling decision (NEWS-96 retuned it), but that reclaimed width must
  // always turn into columns, which is the requirement NEWS-64 states.
  await page.locator('[data-action=toggle-sidebar]').click();
  await expect.poll(trackCount).toBeGreaterThan(1);

  // Clean up (also restores the sidebar for good measure).
  await page.locator('[data-action=toggle-sidebar]').click();
  await topicAction(page, row, 'delete');
  await expect(row).toHaveCount(0);
});

test('stories show the outlet they came from (NEWS-82)', async ({ page }) => {
  await page.goto('/');
  await page.fill('.add-topic input', 'Attribution Probe');
  await page.press('.add-topic input', 'Enter');
  const row = page.locator('.topic', { hasText: 'Attribution Probe' });
  await expect(row).toBeVisible();

  const outlet = page.locator('.item .source-outlet').first();
  await expect(outlet).toBeVisible({ timeout: 15_000 });
  // The mock supplies no outlet, so this is the domain fallback doing its job —
  // which is the branch that runs for most real sources too.
  await expect(outlet).toHaveText(/example\.com/);

  // The attribution lines up with the headline, and is part of the same link
  // (NEWS-279). It used to be a sibling of the anchor with `margin-left: 8px`,
  // which put its left edge under the *middle of the favicon* — visible as a
  // ragged second column down the whole card.
  //
  // Measured, because "aligned" is a pixel fact no functional assertion reaches:
  // the old markup rendered the right words in the right order, and looked wrong.
  const geometry = await page.evaluate(() => {
    const meta = document.querySelector('.item .source-meta');
    if (meta === null) throw new Error('no source attribution rendered');
    const link = meta.closest('a');
    // Deliberately not a hard throw: pre-NEWS-279 the attribution was a *sibling*
    // of the anchor, so this is null there and the assertion below reports the
    // half of the bug it is about rather than an unrelated missing-element error.
    if (link === null) return { insideLink: false, metaLeft: 0, headlineLeft: 0, href: '' };
    // The headline's left edge measured from the text itself, not from a
    // wrapper, so it means the same thing whatever markup surrounds it.
    const headline = link.querySelector('.source-title') ?? link;
    const range = document.createRange();
    range.selectNodeContents(headline);
    return {
      insideLink: true,
      metaLeft: meta.getBoundingClientRect().left,
      headlineLeft: range.getBoundingClientRect().left,
      href: link.getAttribute('href') ?? '',
    };
  });
  expect(geometry.insideLink, 'the attribution is inside the link').toBe(true);
  expect(
    Math.abs(geometry.metaLeft - geometry.headlineLeft),
    'attribution aligns with the headline',
  ).toBeLessThan(1);
  expect(geometry.href).toMatch(/^https?:/);

  // …and clicking it really does follow the link rather than falling through to
  // the card. The click delegate bails inside `ul.sources`, so this also pins
  // that the enlarged target did not start swallowing the expand gesture.
  await expect(page.locator('.item.expanded')).toHaveCount(0);
  await page.locator('.item .source-meta').first().click({ modifiers: ['Alt'] });
  await expect(page.locator('.item.expanded'), 'the card must not expand').toHaveCount(0);

  await topicAction(page, row, 'delete');
  await expect(row).toHaveCount(0);
});
