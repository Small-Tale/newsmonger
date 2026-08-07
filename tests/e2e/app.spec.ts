import { closeSettings, expect, openSettings, resetSharedState,test, topicAction, workerBaseURL } from './fixtures.js';

// The application shell, topics, and the check loop (NEWS-322 split this out of
// the original 2,484-line app.spec.ts).
//
// This file keeps the tests that **build the world**: adding a topic, checking
// it, deduplicating a second check, pausing, deleting, and the scheduling
// warnings around all of that. It seeds nothing in `beforeAll` on purpose —
// these tests are the ones that create the state the other files now ask for
// explicitly via `seedCheckedTopic`.

test.describe.configure({ mode: 'serial' });

// Every attempt starts from a known server, including a serial retry — see
// `resetSharedState` (NEWS-101) and `seedCheckedTopic` (NEWS-322). No file
// inherits its precondition from another's leftovers (NEWS-313).
test.beforeAll(async () => {
  const baseURL = workerBaseURL();
  await resetSharedState(baseURL);
});

test('loads the app shell', async ({ page }) => {
  await page.goto('/');
  // The masthead is the wordmark asset (NEWS-175), so the accessible name comes
  // from the markup rather than from text content. Asserted as the *computed*
  // name, not as an `alt` attribute: since NEWS-377 both marks ship and CSS
  // hides one, so the name lives on the <h1> and the images are decorative.
  // Which element carries it is an implementation detail; that a screen reader
  // reads "Newsmonger" is not.
  await expect(page.locator('h1')).toHaveAccessibleName('Newsmonger');
  await expect(page.locator('.add-topic input')).toBeVisible();
});

test('the masthead wordmark actually loads', async ({ page }) => {
  await page.goto('/');
  // `alt` alone would still pass with a 404 behind it, and the asset reaches
  // dist/client only via the build's copy list — exactly the step a future
  // change forgets. Assert the decoded image, not just the markup.
  // The *visible* mark, since both are in the DOM and one is display:none.
  const decoded = await page
    .locator('h1 img:visible')
    .evaluate((el) => (el as HTMLImageElement).decode().then(() => (el as HTMLImageElement).naturalWidth));
  expect(decoded).toBeGreaterThan(0);

  for (const file of ['wordmark-light.svg', 'wordmark-dark.svg']) {
    const res = await page.request.get(`/static/${file}`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('image/svg+xml');
  }
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

  // Every source link carries exactly one leading mark (NEWS-169): the outlet's
  // favicon where one resolved, the arrow glyph where it didn't. Under
  // `--ai-test` no favicons are fetched at all — the mock's URLs are fictional
  // — so this run exercises the fallback, which is the branch that also serves
  // the roughly-one-in-three real outlets with no reachable icon.
  await expect(link.locator('.icon')).toHaveCount(1);
  await expect(link.locator('img.favicon')).toHaveCount(0);
});

test('the day heading reads as structure, not a fenced-off block (NEWS-183)', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.day h2')).toHaveText(['Today']);

  // Sized against the `.eyebrow` base it inherits rather than a magic number,
  // because that comparison *is* the complaint: at 11px the heading dividing
  // the feed by day was the smallest type on the page, while being the
  // structure the eye scans. Same correction NEWS-154 made in the sidebar.
  const type = await page.evaluate(() => {
    const heading = document.querySelector('.day h2');
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
  // No rule: the cards below carry their own borders, so a hairline here fenced
  // the group off from a page that separates by whitespace everywhere else —
  // and sat a few pixels above the first card's own top edge, reading doubled.
  expect(type?.border).toBe(0);
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

  // Put it back. The suite is serial against one shared server, so this used to
  // leave **every later test running on a 1-hour interval** instead of the
  // 1-day default — which changes when the scheduler decides a topic is due,
  // and so changes how much background checking happens under the tests that
  // follow. That is invisible on a fast machine and not the sort of thing a
  // loaded runner should have to absorb.
  await page.selectOption('[data-action=interval]', { label: 'Every day' });
  await expect(page.locator('[data-action=interval]')).toHaveValue(String(24 * 60 * 60 * 1000));
  await page.locator('.dialog [data-action=close-settings]').click();
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

test('the server reports when checking last became possible (NEWS-247)', async ({ page }) => {
  // The falling-behind banner measures lateness from this rather than from
  // `lastCheckedAt` alone, because the wall clock cannot tell "we cannot keep
  // up" from "we were not permitted to try" — a subscription provider only runs
  // scheduled checks while the app is attended, so a day in the background used
  // to make every topic look badly overdue and produce advice about a problem
  // the user did not have.
  //
  // This asserts the plumbing: the field exists, parses, and describes *this*
  // server session. The behaviour it drives is unit-tested on both sides —
  // `schedule.test.ts` for the banner and `attendance.test.ts` for the deferral
  // watermark — because producing a real deferral needs an *attended* provider
  // and the `--ai-test` mock is deliberately unattended.
  await page.goto('/');
  const body = (await (await page.request.get('/api/state')).json()) as { checksPossibleSince?: string };
  expect(body.checksPossibleSince, 'the field must be served').toBeDefined();
  const since = Date.parse(body.checksPossibleSince ?? '');
  expect(Number.isNaN(since), 'must be a parseable timestamp').toBe(false);

  // Not the epoch default, and not the future: it should name a moment in this
  // server's lifetime. A wiring break — the field dropped, defaulted, or
  // serialised wrong — lands outside this window rather than passing silently.
  expect(since).toBeGreaterThan(Date.now() - 6 * 60 * 60 * 1000);
  expect(since).toBeLessThanOrEqual(Date.now() + 1000);
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
