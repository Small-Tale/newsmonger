import type { Page } from '@playwright/test';

import { expect, test, topicAction } from './fixtures.js';

// Tests run serially against one shared server (see playwright.config.ts) and
// build on each other's state where noted. The server runs with --ai-test, so
// news checks return the same two deterministic stories per topic every time —
// which lets us assert deduplication end-to-end.

test.describe.configure({ mode: 'serial' });

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
  // Stays gone across a poll cycle — the dismissal is remembered by run id.
  await page.waitForTimeout(4500);
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
