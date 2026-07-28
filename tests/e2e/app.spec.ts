import type { Page } from '@playwright/test';

import { expect, resetTopics, test, topicAction } from './fixtures.js';

// Tests run serially against one shared server (see playwright.config.ts) and
// build on each other's state where noted. The server runs with --ai-test, so
// news checks return the same two deterministic stories per topic every time —
// which lets us assert deduplication end-to-end.

test.describe.configure({ mode: 'serial' });

// Every attempt starts from an empty server, including a serial retry — see
// `resetTopics` (NEWS-101). Without this a mid-test failure leaves topics
// behind and the replay blames whichever early test trips over them.
test.beforeAll(async () => {
  await resetTopics(test.info().project.use.baseURL ?? '');
});

/** Settings (interval, provider, model/endpoint, API keys) live in a dialog. */
async function openSettings(page: Page): Promise<void> {
  await page.click('[data-action=open-settings]');
  await expect(page.locator('.dialog')).toBeVisible();
}

async function closeSettings(page: Page): Promise<void> {
  await page.locator('.dialog [data-action=close-settings]').click();
  await expect(page.locator('.dialog')).toHaveCount(0);
}

test('loads the app shell', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('h1')).toHaveText('News.');
  await expect(page.locator('.add-topic input')).toBeVisible();
});

test('adds a topic and shows it in the list', async ({ page }) => {
  await page.goto('/');
  await page.fill('.add-topic input', 'Fusion Energy');
  await page.click('.add-topic button[type=submit]');
  await expect(page.locator('.topic-name')).toHaveText(['Fusion Energy']);
  // No assertion on the "checked" status here: the scheduler's startup sweep
  // may legitimately check a brand-new topic within seconds.
});

test('rejects a duplicate topic with an error banner', async ({ page }) => {
  await page.goto('/');
  await page.fill('.add-topic input', 'fusion energy');
  await page.click('.add-topic button[type=submit]');
  await expect(page.locator('.banner.error')).toContainText('already exists');
  await expect(page.locator('.topic')).toHaveCount(1);
});

test('check now finds stories with summaries and source links', async ({ page }) => {
  await page.goto('/');
  await topicAction(page, page.locator('.topic').first(), 'check');
  await expect(page.locator('.item')).toHaveCount(2, { timeout: 15_000 });
  const first = page.locator('.item').first();
  await expect(first.locator('h3')).toContainText('Fusion Energy');
  await expect(first.locator('p')).not.toBeEmpty();
  const link = first.locator('.sources a').first();
  await expect(link).toHaveAttribute('href', /https:\/\//);
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(page.locator('.topic-meta').first()).toContainText('checked');
});

test('a second check deduplicates already-seen stories', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.item')).toHaveCount(2);
  await topicAction(page, page.locator('.topic').first(), 'check');
  // Wait for the check to finish (button re-enables), then confirm no new items.
  await expect(page.locator('.topic .dial.checking')).toHaveCount(0, { timeout: 15_000 });
  await page.waitForTimeout(500);
  await expect(page.locator('.item')).toHaveCount(2);
});

test('a newly added topic is checked automatically, with no manual check (NEWS-54)', async ({ page }) => {
  // The bug: a fresh topic sat unchecked until the next scheduler tick. Adding
  // it must produce stories on its own — this test never invokes Check now.
  await page.goto('/');
  await page.fill('.add-topic input', 'Auto Check Probe');
  await page.press('.add-topic input', 'Enter');
  const row = page.locator('.topic', { hasText: 'Auto Check Probe' });
  await expect(row).toBeVisible();

  const probeItems = page.locator('.item', { has: page.locator('.item-topic', { hasText: 'Auto Check Probe' }) });
  await expect(probeItems).toHaveCount(2, { timeout: 15_000 });

  // Clean up so the serial suite is undisturbed.
  await topicAction(page, row, 'delete');
  await expect(row).toHaveCount(0);
});

test('changing the check interval persists across reload', async ({ page }) => {
  await page.goto('/');
  await openSettings(page);
  await page.selectOption('[data-action=interval]', { label: 'Every hour' });
  await expect(page.locator('[data-action=interval]')).toHaveValue('3600000');
  await page.reload();
  await openSettings(page);
  await expect(page.locator('[data-action=interval]')).toHaveValue('3600000');
});

test('pausing a topic marks it paused', async ({ page }) => {
  await page.goto('/');
  await topicAction(page, page.locator('.topic').first(), 'pause');
  await expect(page.locator('.topic')).toHaveClass(/paused/);
  await expect(page.locator('.topic-meta').first()).toContainText('paused');
  await topicAction(page, page.locator('.topic').first(), 'pause');
  await expect(page.locator('.topic')).not.toHaveClass(/paused/);
});

test('check all works from the header', async ({ page }) => {
  await page.goto('/');
  await page.fill('.add-topic input', 'Quantum Computing');
  await page.click('.add-topic button[type=submit]');
  await expect(page.locator('.topic')).toHaveCount(2);

  await page.click('[data-action=check-all]');
  // The new topic's two stories join the existing two.
  await expect(page.locator('.item')).toHaveCount(4, { timeout: 15_000 });
  await expect(page.locator('.item-topic').first()).toBeVisible();
});

test('a failing topic surfaces a warning banner', async ({ page }) => {
  await page.goto('/');
  await page.fill('.add-topic input', 'this will fail');
  await page.click('.add-topic button[type=submit]');
  const row = page.locator('.topic', { hasText: 'this will fail' });
  await topicAction(page, row, 'check');
  await expect(page.locator('.banner.warn')).toContainText('failed', { timeout: 15_000 });
  // Clean up so later tests aren't affected.
  await topicAction(page, row, 'delete');
  await expect(page.locator('.topic')).toHaveCount(2);
});

test('the provider picker persists a choice across reload', async ({ page }) => {
  await page.goto('/');
  await openSettings(page);
  await expect(page.locator('[data-action=provider]')).toBeVisible();

  await page.selectOption('[data-action=provider]', 'openai');
  // OpenAI is endpoint-configurable, so the endpoint field appears.
  await expect(page.locator('[data-action=endpoint]')).toBeVisible();
  await page.reload();
  await openSettings(page);
  await expect(page.locator('[data-action=provider]')).toHaveValue('openai');

  // Reset to auto so later tests aren't affected. (Checks still run the mock
  // provider — the server is in --ai-test — regardless of this setting.)
  await page.selectOption('[data-action=provider]', 'auto');
  await expect(page.locator('[data-action=endpoint]')).toHaveCount(0);
  await closeSettings(page);
});

test('deleting a topic removes its stories from the feed', async ({ page }) => {
  await page.goto('/');
  const row = page.locator('.topic', { hasText: 'Quantum Computing' });
  await topicAction(page, row, 'delete');
  await expect(page.locator('.topic')).toHaveCount(1);
  await expect(page.locator('.item')).toHaveCount(2);
  await expect(page.locator('.item-topic').first()).not.toContainText('Quantum');
});

test('the client reports foreground so scheduled checks may run', async ({ page }) => {
  // Subscription-backed providers only run scheduled checks while the app is
  // in front of someone (src/attendance.ts). This asserts the client half of
  // that contract: the heartbeat is sent on load, and again on regaining
  // focus. The gate decision itself is unit-tested in attendance.test.ts,
  // where attendance can actually be made stale.
  const beats: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/foreground')) beats.push(r.method());
  });

  await page.goto('/');
  await expect.poll(() => beats.length).toBeGreaterThan(0);
  expect(beats[0]).toBe('POST');

  const afterLoad = beats.length;
  await page.evaluate(() => { window.dispatchEvent(new Event('focus')); });
  await expect.poll(() => beats.length).toBeGreaterThan(afterLoad);
});

test('the topics sidebar collapses and the choice persists', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.topics-panel')).toBeVisible();
  const expandedFeed = (await page.locator('#feed').boundingBox())?.width ?? 0;
  // Captured rather than hardcoded: the suite is serial and stateful, so the
  // invariant is "the list is unchanged", not any particular count.
  const topicCount = await page.locator('.topic').count();

  await page.click('[data-action=toggle-sidebar]');
  await expect(page.locator('.topics-panel')).toBeHidden();
  await expect(page.locator('[data-action=toggle-sidebar]')).toHaveAttribute('aria-expanded', 'false');

  // The feed takes the reclaimed width rather than leaving a gap.
  const collapsedFeed = (await page.locator('#feed').boundingBox())?.width ?? 0;
  expect(collapsedFeed).toBeGreaterThan(expandedFeed);

  // Hidden, but still mounted: unmounting a sibling ahead of the keyed topics
  // list is the kerf KF-377 hazard, so this asserts we didn't reintroduce it.
  await expect(page.locator('#topics-panel')).toHaveCount(1);

  await page.reload();
  await expect(page.locator('.topics-panel')).toBeHidden();

  // Restore, and confirm the keyed list survived the round trip — the failure
  // mode KF-377 produces is a permanently empty list, not an error.
  await page.click('[data-action=toggle-sidebar]');
  await expect(page.locator('.topics-panel')).toBeVisible();
  await expect(page.locator('.topic')).toHaveCount(topicCount);
});

test('every icon is Lucide artwork, never a text glyph', async ({ page }) => {
  // NEWS-35: emoji and symbol characters render as someone else's artwork at
  // someone else's weight and colour, which no CSS brings into line with a
  // stroked icon set. This fails loudly if one creeps back in.
  await page.goto('/');
  await expect(page.locator('.topic').first()).toBeVisible();

  const glyphs = await page.evaluate(() => {
    // Arrows, dingbats, symbols, and emoji — deliberately NOT matching
    // typographic punctuation (em dash, curly quotes, ellipsis, middle dot),
    // which is prose rather than iconography.
    const iconish = /[\u2190-\u21FF\u2300-\u23FF\u2500-\u27BF\u2B00-\u2BFF\u{1F300}-\u{1FAFF}]/u;
    const found: string[] = [];
    document.querySelectorAll('body *').forEach((el) => {
      el.childNodes.forEach((n) => {
        if (n.nodeType === Node.TEXT_NODE && iconish.test(n.textContent ?? '')) {
          found.push(`${el.tagName}: ${(n.textContent ?? '').trim().slice(0, 40)}`);
        }
      });
    });
    return found;
  });
  expect(glyphs).toEqual([]);

  // And the icon-only controls really are rendered icons.
  await expect(page.locator('[data-action=open-settings] svg.icon')).toHaveCount(1);
  await expect(page.locator('[data-action=toggle-sidebar] svg.icon')).toHaveCount(1);
});

test('the model field is a combobox with per-provider suggestions (NEWS-37)', async ({ page }) => {
  await page.goto('/');
  await openSettings(page);
  await page.selectOption('[data-action=provider]', 'anthropic');

  const model = page.locator('[data-action=model]');
  // Still a free-text input, just backed by a datalist — custom gateways and
  // models newer than the list must remain typeable.
  await expect(model).toHaveAttribute('type', 'text');
  await expect(model).toHaveAttribute('list', 'model-suggestions');
  await expect(page.locator('#model-suggestions option').first()).toHaveAttribute('value', 'claude-opus-4-8');

  // Suggestions track the provider.
  await page.selectOption('[data-action=provider]', 'openai');
  await expect(page.locator('#model-suggestions option').first()).toHaveAttribute('value', 'gpt-5');

  // A value not in the list is still accepted and persists.
  await model.fill('my-custom-model');
  await model.blur();
  await page.reload();
  await openSettings(page);
  await expect(page.locator('[data-action=model]')).toHaveValue('my-custom-model');

  // Reset so later tests see a clean provider config.
  await page.locator('[data-action=model]').fill('');
  await page.locator('[data-action=model]').blur();
  await page.selectOption('[data-action=provider]', 'auto');
});

test('notification toggle persists when permission is granted (NEWS-38)', async ({ page, context }) => {
  await context.grantPermissions(['notifications']);
  await page.addInitScript(() => {
    class Rec {
      static permission = 'granted';
      static requestPermission = () => Promise.resolve('granted');
      close() {}
    }
    (window as unknown as { Notification: unknown }).Notification = Rec;
  });
  await page.goto('/');
  await openSettings(page);

  await page.check('[data-action=notify-toggle]');
  await expect(page.locator('[data-action=notify-toggle]')).toBeChecked();
  // Survives a reload — it's a real persisted setting.
  await page.reload();
  await openSettings(page);
  await expect(page.locator('[data-action=notify-toggle]')).toBeChecked();
  await expect(page.locator('.notify-note .note')).toHaveCount(0);

  // Turn it back off so later tests see a clean app.
  await page.uncheck('[data-action=notify-toggle]');
  await expect(page.locator('[data-action=notify-toggle]')).not.toBeChecked();
});

test('a refused notification permission shows a note and leaves the toggle off (NEWS-38)', async ({ page }) => {
  await page.addInitScript(() => {
    class Rec {
      static permission = 'default';
      static requestPermission = () => Promise.resolve('denied');
      close() {}
    }
    (window as unknown as { Notification: unknown }).Notification = Rec;
  });
  await page.goto('/');
  await openSettings(page);

  await page.click('[data-action=notify-toggle]');
  await expect(page.locator('.notify-note .note')).toBeVisible();
  await expect(page.locator('[data-action=notify-toggle]')).not.toBeChecked();

  // And nothing was persisted.
  const persisted = await page.evaluate(async () => {
    const r = await fetch('/api/state');
    return ((await r.json()) as { settings: { notifyOnNewItems: boolean } }).settings.notifyOnNewItems;
  });
  expect(persisted).toBe(false);
});

test('the error banner can be dismissed (NEWS-41)', async ({ page }) => {
  await page.goto('/');
  // A duplicate topic raises the error banner.
  await page.fill('.add-topic input', 'Dismiss Error Probe');
  await page.press('.add-topic input', 'Enter');
  await expect(page.locator('.topic', { hasText: 'Dismiss Error Probe' })).toBeVisible();
  await page.fill('.add-topic input', 'Dismiss Error Probe');
  await page.press('.add-topic input', 'Enter');

  await expect(page.locator('.banner.error')).toBeVisible();
  await page.locator('.banner.error [data-action=dismiss-error]').click();
  await expect(page.locator('.banner.error')).toHaveCount(0);

  // Clean up the topic this test created (assert it's gone so a botched cleanup
  // can't leave residue for the count-sensitive earlier tests on a retry).
  await page.fill('.add-topic input', '');
  await topicAction(page, page.locator('.topic', { hasText: 'Dismiss Error Probe' }), 'delete');
  await expect(page.locator('.topic', { hasText: 'Dismiss Error Probe' })).toHaveCount(0);
});

test('the failure warning can be dismissed and stays dismissed, but a new failure reappears (NEWS-41)', async ({
  page,
}) => {
  // The mock provider throws for a topic whose name contains "fail".
  await page.goto('/');
  await page.fill('.add-topic input', 'fail banner probe');
  await page.press('.add-topic input', 'Enter');
  const row = page.locator('.topic', { hasText: 'fail banner probe' });
  await expect(row).toBeVisible();

  await topicAction(page, row, 'check');
  await expect(page.locator('.banner.warn')).toBeVisible();

  await page.locator('.banner.warn [data-action=dismiss-warn]').click();
  await expect(page.locator('.banner.warn')).toHaveCount(0);
  // Stays gone across poll cycles — the dismissal is remembered by run id.
  // Waits for the client's own polls to land rather than sleeping past them: a
  // fixed 4.5s sleep leaves 500ms of margin on a 4s poll, which is exactly the
  // budget a loaded machine eats (NEWS-101). Deliberately NOT triggering a
  // check to force the wait — a new check would be a new failure, which is the
  // one thing that legitimately brings this banner back.
  await page.waitForResponse((r) => r.url().includes('/api/state'), { timeout: 15_000 });
  await page.waitForResponse((r) => r.url().includes('/api/state'), { timeout: 15_000 });
  await expect(page.locator('.banner.warn')).toHaveCount(0);

  // A fresh failure is a new run id, so the banner comes back.
  await topicAction(page, row, 'check');
  await expect(page.locator('.banner.warn')).toBeVisible();

  // Clean up.
  await topicAction(page, row, 'delete');
  await expect(row).toHaveCount(0);
});

test('a dismissed failure warning stays dismissed after an app relaunch (NEWS-41)', async ({ page }) => {
  // The reopened bug: the warning is derived from server state that survives a
  // reload, and the dismissal used to live only in memory — so relaunching the
  // app resurrected a warning the user had already closed.
  await page.goto('/');
  await page.fill('.add-topic input', 'relaunch fail probe');
  await page.press('.add-topic input', 'Enter');
  const row = page.locator('.topic', { hasText: 'relaunch fail probe' });
  await expect(row).toBeVisible();

  await topicAction(page, row, 'check');
  await expect(page.locator('.banner.warn')).toBeVisible();
  await page.locator('.banner.warn [data-action=dismiss-warn]').click();
  await expect(page.locator('.banner.warn')).toHaveCount(0);

  // Relaunch = reload. The failed run is still in server state, but the
  // dismissal now persists, so the warning must not reappear.
  await page.reload();
  await expect(row).toBeVisible();
  await page.waitForTimeout(4500); // a full poll cycle
  await expect(page.locator('.banner.warn')).toHaveCount(0);

  // Clean up.
  await topicAction(page, row, 'delete');
  await expect(row).toHaveCount(0);
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

test('warns when checks fall behind the chosen interval (NEWS-59)', async ({ page }) => {
  const HOUR = 60 * 60 * 1000;
  // Freeze the client clock at "now" so we can jump it forward past the interval.
  await page.clock.install({ time: Date.now() });
  await page.goto('/');

  // Use a 1-hour interval so the 2x "behind" threshold is reachable by fast-forward.
  await page.click('[data-action=open-settings]');
  await page.selectOption('[data-action=interval]', String(HOUR));
  await page.locator('.dialog [data-action=close-settings]').click();

  await page.fill('.add-topic input', 'Behind Probe');
  await page.press('.add-topic input', 'Enter');
  const row = page.locator('.topic', { hasText: 'Behind Probe' });
  await expect(row).toBeVisible();
  // Adding checks it (NEWS-54); wait for the check to land so lastCheckedAt is set.
  await expect(row.locator('.topic-meta')).toContainText('checked', { timeout: 15_000 });

  const banner = page.locator('.banner.warn', { hasText: 'falling behind' });
  await expect(banner).toHaveCount(0); // fresh check → not behind yet

  // Jump 3 hours ahead: the topic is now ~3h stale against a 1h interval → behind.
  await page.clock.fastForward(3 * HOUR);
  await expect(banner).toBeVisible();

  // Dismissible, and it stays dismissed across the 4s poll.
  await banner.locator('[data-action=dismiss-behind]').click();
  await expect(page.locator('.banner.warn', { hasText: 'falling behind' })).toHaveCount(0);

  // Clean up: delete the probe and restore the default interval.
  await topicAction(page, row, 'delete');
  await page.click('[data-action=open-settings]');
  await page.selectOption('[data-action=interval]', String(24 * HOUR));
  await page.locator('.dialog [data-action=close-settings]').click();
});

test('shortening the interval does not immediately warn (NEWS-67)', async ({ page }) => {
  const HOUR = 60 * 60 * 1000;
  await page.clock.install({ time: Date.now() });
  await page.goto('/');
  await page.fill('.add-topic input', 'Grace Probe');
  await page.press('.add-topic input', 'Enter');
  const row = page.locator('.topic', { hasText: 'Grace Probe' });
  await expect(row).toBeVisible();
  await expect(row.locator('.topic-meta')).toContainText('checked', { timeout: 15_000 });

  // Age the topic 7h. The default interval is 1 day, so it isn't behind yet.
  await page.clock.fastForward(7 * HOUR);
  const banner = page.locator('.banner.warn', { hasText: 'falling behind' });
  await expect(banner).toHaveCount(0);

  // Shorten to 3h. 7h > 2×3h, so without the grace this would fire instantly —
  // but the topic just hasn't been re-checked yet, so it must stay quiet.
  await page.click('[data-action=open-settings]');
  await page.selectOption('[data-action=interval]', String(3 * HOUR));
  await page.locator('.dialog [data-action=close-settings]').click();
  await page.waitForTimeout(500);
  await expect(banner).toHaveCount(0);

  // Clean up.
  await topicAction(page, row, 'delete');
  await page.click('[data-action=open-settings]');
  await page.selectOption('[data-action=interval]', String(24 * HOUR));
  await page.locator('.dialog [data-action=close-settings]').click();
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

test('the local API refuses requests from a page on another origin (NEWS-86)', async ({ request }) => {
  // Straight HTTP against the running server, not through the page: the point
  // is that the middleware is wired into what actually gets served, and a
  // Playwright page is always same-origin so it cannot forge this itself.
  const created = await request.post('/api/topics', { data: { name: 'Origin Guard Probe' } });
  expect(created.ok()).toBeTruthy();
  const topic = (await created.json()) as { id: string };

  const evil = { origin: 'https://evil.com' };

  const read = await request.get('/api/state', { headers: evil });
  expect(read.status()).toBe(403);

  // A no-CORS DELETE still reaches the server even though the attacking page
  // could never read the reply — so it has to be refused before it acts.
  const destroy = await request.delete(`/api/topics/${topic.id}`, { headers: evil });
  expect(destroy.status()).toBe(403);

  // ...and burning API credit is just as much of an attack as deleting data.
  const check = await request.post('/api/check', { headers: evil, data: { topicId: topic.id } });
  expect(check.status()).toBe(403);

  const state = (await (await request.get('/api/state')).json()) as { topics: { id: string }[] };
  expect(state.topics.map((t) => t.id)).toContain(topic.id);

  expect((await request.delete(`/api/topics/${topic.id}`)).ok()).toBeTruthy();
});

test('settings offers nothing about money (NEWS-119)', async ({ page }) => {
  // Spend, the monthly budget and the price-manifest field are gone. Asserting
  // their absence is what stops one drifting back in unnoticed — the removal is
  // the requirement, so it needs a test like any other.
  await page.goto('/');
  await openSettings(page);

  await expect(page.locator('.spend')).toHaveCount(0);
  await expect(page.locator('[data-action=budget]')).toHaveCount(0);
  await expect(page.locator('[data-action=price-manifest]')).toHaveCount(0);
  await expect(page.locator('.dialog')).not.toContainText('Spending');
  await expect(page.locator('.dialog')).not.toContainText('budget');

  await closeSettings(page);
});

test('the first-run guide walks through setup and is re-openable (NEWS-78)', async ({ page }) => {
  // By this point the suite has topics and a working (mock) provider, so the
  // guide must NOT auto-open — that is the assertion protecting every existing
  // user from a wizard on every reload.
  await page.goto('/');
  await expect(page.locator('.dialog.onboarding')).toHaveCount(0);

  // Settings reopens it on demand.
  await openSettings(page);
  await page.locator('[data-action=rerun-onboarding]').click();
  const wizard = page.locator('.dialog.onboarding');
  await expect(wizard).toBeVisible();
  await expect(page.locator('.dialog:not(.onboarding)')).toHaveCount(0);

  // Welcome → source → topics.
  await expect(wizard.locator('h2')).toHaveText('News watches topics, not feeds.');
  await wizard.locator('[data-action=onboarding-next]').click();
  await expect(wizard.locator('h2')).toHaveText('Where should the news come from?');
  await wizard.locator('[data-action=onboarding-next]').click();
  await expect(wizard.locator('h2')).toHaveText('What should News watch?');

  // Starter topics toggle, and the count reflects it.
  const first = wizard.locator('.chip.starter').first();
  await first.click();
  await expect(first).toHaveAttribute('aria-pressed', 'true');
  await expect(wizard.locator('.note')).toContainText('1 chosen');
  await first.click();
  await expect(first).toHaveAttribute('aria-pressed', 'false');

  // Schedule is the last step; skipping there closes without creating anything.
  await wizard.locator('[data-action=onboarding-next]').click();
  await expect(wizard.locator('h2')).toHaveText('How often should it check?');
  const before = await page.locator('.topic').count();
  await wizard.locator('[data-action=onboarding-skip]').click();
  await expect(wizard).toHaveCount(0);
  await expect(page.locator('.topic')).toHaveCount(before);
});

test('Settings discloses what leaves the machine (NEWS-91)', async ({ page }) => {
  await page.goto('/');
  await openSettings(page);
  const privacy = page.locator('.privacy');
  await expect(privacy).toBeVisible();
  // The three claims the note has to make, each load-bearing: what is sent,
  // what is stored locally, and that keys are not in the data file.
  await expect(privacy).toContainText('Sent on every check');
  await expect(privacy).toContainText('~/.news');
  await expect(privacy).toContainText('API keys are not stored there');
  await expect(privacy).toContainText('no telemetry');
  await closeSettings(page);
});

test('Settings shows recent checks and copies a diagnostics bundle (NEWS-88)', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');

  // Self-sufficient rather than relying on earlier specs: adding a topic fires
  // its own first check (FR-1.12), which is the run this asserts on.
  await page.fill('.add-topic input', 'Diagnostics Probe');
  await page.press('.add-topic input', 'Enter');
  const row = page.locator('.topic', { hasText: 'Diagnostics Probe' });
  await expect(row).toBeVisible();

  await openSettings(page);
  await expect(page.locator('.diagnostics .run').first()).toBeVisible({ timeout: 15_000 });

  await page.locator('[data-action=copy-diagnostics]').click();
  await expect(page.locator('.toast')).toContainText('Diagnostics copied');

  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain('# News diagnostics');
  expect(copied).toContain('provider setting:');
  expect(copied).toContain('## Recent checks');
  // Redacted by default: the run lines refer to "topic N", never a real name.
  expect(copied).toContain('Topic names redacted');
  expect(copied).toMatch(/- .* (succeeded|failed|running) topic \d+/);
  expect(copied).not.toContain('Diagnostics Probe');

  await closeSettings(page);
  await topicAction(page, row, 'delete');
  await expect(row).toHaveCount(0);
});

test('the feed and exports are served over HTTP (NEWS-85)', async ({ page, request }) => {
  await page.goto('/');
  await openSettings(page);
  await expect(page.locator('.export-row')).toBeVisible();
  // The download links are real hrefs, not JS handlers — so they work in the
  // Tauri webview too, where a blob download would have nowhere to go.
  await expect(page.locator('.export-row a').first()).toHaveAttribute('href', /export\.md/);
  await closeSettings(page);

  const feed = await request.get('/feed.xml');
  expect(feed.status()).toBe(200);
  expect(feed.headers()['content-type']).toContain('application/atom+xml');
  const xml = await feed.text();
  expect(xml).toContain('<feed xmlns="http://www.w3.org/2005/Atom">');
  expect(xml).toContain('</feed>');

  const md = await request.get('/api/export.md?scope=all');
  expect(md.headers()['content-disposition']).toContain('attachment');
  expect(await md.text()).toContain('# All stories');
});

test('the schedule can be switched to set times of day (NEWS-84)', async ({ page, request }) => {
  await page.goto('/');
  await openSettings(page);

  // Interval mode is the default and shows the "Check every" dropdown.
  await expect(page.locator('[data-action=interval]')).toBeVisible();
  await expect(page.locator('[data-action=daily-times]')).toHaveCount(0);

  await page.locator('[data-action=schedule-mode]').selectOption('daily');
  const times = page.locator('[data-action=daily-times]');
  await expect(times).toBeVisible();
  await expect(page.locator('[data-action=interval]')).toHaveCount(0);

  await times.fill('18:30, 07:15');
  await times.blur();
  await expect
    .poll(async () => {
      const s = (await (await request.get('/api/state')).json()) as { settings: { dailyTimes: string[] } };
      return s.settings.dailyTimes;
    })
    // Sorted server-side, so every reader sees the same canonical list.
    .toEqual(['07:15', '18:30']);

  // Garbage is refused and the saved value is put back, rather than silently
  // clearing the schedule out from under the user.
  await times.fill('lunchtime');
  await times.blur();
  await expect(page.locator('.toast')).toContainText('Times must look like 08:00');
  await expect(times).toHaveValue('07:15, 18:30');

  // Restore interval mode so later specs are unaffected.
  await page.locator('[data-action=schedule-mode]').selectOption('interval');
  await expect(page.locator('[data-action=interval]')).toBeVisible();
  await closeSettings(page);
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

  await topicAction(page, row, 'delete');
  await expect(row).toHaveCount(0);
});
