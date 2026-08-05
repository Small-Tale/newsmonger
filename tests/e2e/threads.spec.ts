import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

import { expect, resetSharedState, test, topicAction } from './fixtures.js';

// Story threads (NEWS-280): two outlets' coverage of one subject lands in a
// single thread, and unrelated stories in the same topic do not. Then the
// timeline built on that (NEWS-282): expanding a card shows how its subject
// developed, and a story that is the only one on its subject says so.
//
// Serial and self-contained like the rest of the suite: it creates its own
// topics and deletes them at the end.
//
// **A topic name must not contain the series' own words.** The topic's words are
// stopwords inside it (FR-29.10), so a topic called "Riverside…" subtracts the
// word the mock's series threads on and every story stays a thread of one —
// which looks like the feature being broken rather than working as designed.

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  await resetSharedState(test.info().project.use.baseURL ?? '');
});

interface Item {
  id: string;
  title: string;
  threadId: string;
}

/** The stored stories for a topic, straight off the API the feed reads. */
async function items(page: Page, topicId: string): Promise<Item[]> {
  const res = await page.request.get(`/api/items?topics=${encodeURIComponent(topicId)}&limit=50`);
  const body = (await res.json()) as { items: Item[] };
  return body.items;
}

async function addTopic(page: Page, name: string): Promise<string> {
  // Adding a topic checks it immediately (FR-1.12), so the stories arrive on
  // their own — no manual check to trigger.
  const res = await page.request.post('/api/topics', { data: { name } });
  const body = (await res.json()) as { id: string };
  return body.id;
}

test('two outlets covering one subject land in the same thread', async ({ page }) => {
  await page.goto('/');
  // "thread" in the name puts the mock provider on its single-subject pair —
  // a dam collapse reported by two different outlets, which is exactly the case
  // dedupe cannot relate (two hosts, two dedupe keys, one story).
  const topicId = await addTopic(page, 'Dam Thread Probe');

  await expect.poll(async () => (await items(page, topicId)).length, { timeout: 20_000 }).toBe(2);
  const stored = await items(page, topicId);
  expect(stored.map((i) => i.title).sort()).toEqual([
    'Rescue teams reach Riverside Dam flood zone',
    'Riverside Dam collapse floods three towns',
  ]);

  // One thread, named by the story that landed first — and it is a real story's
  // id, not a synthetic group key.
  const threadIds = new Set(stored.map((i) => i.threadId));
  expect(threadIds.size).toBe(1);
  expect(stored.map((i) => i.id)).toContain([...threadIds][0]);

  await page.request.delete(`/api/topics/${encodeURIComponent(topicId)}`);
});

test('the expanded pane shows the story so far, capped, with a way to see all of it (NEWS-282)', async ({ page }) => {
  await page.goto('/');
  // Added through the UI, because this test is about what the card shows. The
  // first check runs on creation (FR-1.12) and each later one extends the
  // series by two, so three checks build a six-story thread — more than
  // `THREAD_ROW_CAP`, which is the only way to reach "show all".
  await page.fill('.add-topic input', 'timeline thread topic');
  await page.press('.add-topic input', 'Enter');
  const row = page.locator('.topic', { hasText: 'timeline thread topic' });
  await expect(row).toBeVisible();

  const cards = page.locator('.item:not(.flagged-row)', {
    has: page.locator('.item-topic', { hasText: 'timeline thread topic' }),
  });
  await expect(cards).toHaveCount(2, { timeout: 20_000 });
  await topicAction(page, row, 'check');
  await expect(cards).toHaveCount(4, { timeout: 20_000 });
  await topicAction(page, row, 'check');
  await expect(cards).toHaveCount(6, { timeout: 20_000 });

  // The feed is newest-first, so the first card is one of the latest pair.
  const card = cards.first();
  const cardTitle = (await card.locator('h3').textContent())?.trim() ?? '';
  await card.locator('h3').click();
  const pane = card.locator('.item-pane');
  await expect(pane).toBeVisible();
  await expect(pane.locator('.thread-heading')).toHaveText('The story so far');

  // Capped at four of the six, and the button says how many there are in total.
  const rows = pane.locator('.thread-row');
  await expect(rows).toHaveCount(4);
  const showAll = pane.locator('[data-action=show-all-thread]');
  await expect(showAll).toHaveText('Show all 6 stories');

  // The story being read is in its own timeline, marked rather than filtered
  // out — that is what gives the pane a "you are here".
  const current = pane.locator('.thread-row.current');
  await expect(current).toHaveCount(1);
  await expect(current).toContainText(cardTitle);
  await expect(current).toContainText('this story');
  await expect(current).toHaveAttribute('aria-current', 'true');
  // …and it is not a link, because you are already there.
  await expect(current.locator('a')).toHaveCount(0);

  // Every other row's headline **is** a link to that story's own source, and
  // every row is dated and attributed.
  const other = rows.filter({ hasNot: page.locator('.thread-here') }).first();
  await expect(other.locator('a.thread-title')).toHaveAttribute('href', /^https?:\/\//);
  await expect(other.locator('.thread-outlet')).not.toBeEmpty();
  await expect(other.locator('.thread-when')).toHaveText('Today');

  // Show all: the two oldest instalments appear, chronologically first — the
  // cap keeps the *recent* rows, so these are what it was holding back.
  await showAll.click();
  await expect(rows).toHaveCount(6);
  await expect(pane.locator('[data-action=show-all-thread]')).toHaveCount(0);
  const first = await rows.first().locator('.thread-title').textContent();
  const second = await rows.nth(1).locator('.thread-title').textContent();
  expect([first, second].sort()).toEqual([
    'Rescue teams reach Riverside Dam flood zone',
    'Riverside Dam collapse floods three towns',
  ]);

  // Re-opening the card puts the cap back — a lifted cap belongs to the pane
  // that was open, not to the reader.
  await card.locator('h3').click();
  await expect(pane).toBeHidden();
  await card.locator('h3').click();
  await expect(pane.locator('.thread-row')).toHaveCount(4);

  // The pane with a real timeline in it, scanned in both schemes. The NEWS-281
  // axe test covers the *empty* pane, which is a different DOM: this one has a
  // heading, an ordered list, `aria-current` rows and two dimmed text colours.
  //
  // **Emulate, then navigate**, as `a11y.spec.ts` and the NEWS-281 axe test do.
  // Flipping the scheme on a live page runs every colour transition, and axe
  // scanning mid-flight reports an interpolated frame — verified the hard way
  // here: an in-place flip failed on a *source link* at 4.11:1, a value neither
  // theme actually paints. Expansion is ephemeral, so each pass re-expands.
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto('/');
    const reopened = cards.first();
    await expect(reopened).toBeVisible({ timeout: 20_000 });
    await reopened.locator('[data-expand-item]').click();
    await expect(reopened.locator('.thread-row')).toHaveCount(4);
    const results = await new AxeBuilder({ page })
      .include('.item.expanded')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    expect(serious, `thread timeline / ${scheme}`).toEqual([]);
  }
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');

  await topicAction(page, row, 'delete');
  await expect(page.locator('.topic', { hasText: 'timeline thread topic' })).toHaveCount(0);
});

test('a story that is the only one on its subject says so, with no stray heading (NEWS-282)', async ({ page }) => {
  const threadRequests: string[] = [];
  page.on('request', (req) => {
    if (req.url().includes('/thread')) threadRequests.push(req.url());
  });
  await page.goto('/');
  // No "thread" in the name, so the mock's default pair — unrelated stories that
  // share only the topic's own words, which threading discounts. Two threads of
  // one, which is what most stories are.
  await page.fill('.add-topic input', 'lone story topic');
  await page.press('.add-topic input', 'Enter');
  const row = page.locator('.topic', { hasText: 'lone story topic' });
  await expect(row).toBeVisible();
  const cards = page.locator('.item:not(.flagged-row)', {
    has: page.locator('.item-topic', { hasText: 'lone story topic' }),
  });
  await expect(cards).toHaveCount(2, { timeout: 20_000 });

  const card = cards.first();
  await card.locator('h3').click();
  const pane = card.locator('.item-pane');
  await expect(pane).toBeVisible();
  // One honest line, and **no heading**: "The story so far" over nothing reads
  // as a bug rather than as an answer.
  await expect(pane.locator('.item-pane-note')).toHaveText(
    'Nothing else on this subject yet — later stories about it will collect here.',
  );
  await expect(pane.locator('.thread-heading')).toHaveCount(0);
  await expect(pane.locator('.thread-row')).toHaveCount(0);
  // And it cost nothing: the feed already said the thread holds one story, so
  // the common expansion makes no request at all.
  expect(threadRequests).toEqual([]);

  // No badge either (NEWS-283) — that is the point of it: one on every card
  // would say nothing about which cards hold history.
  await expect(card.locator('.thread-badge')).toHaveCount(0);
  await expect(card.locator('[data-expand-item]')).toHaveAttribute('aria-label', 'Hide story detail');

  await topicAction(page, row, 'delete');
  await expect(page.locator('.topic', { hasText: 'lone story topic' })).toHaveCount(0);
});

test('a collapsed card advertises its thread, without crowding the header (NEWS-283)', async ({ page }) => {
  await page.goto('/');
  // One check is enough here: the mock's first answer is two stories on one
  // subject, so the pair is a thread of two — the smallest thing a badge has to
  // describe, and it exercises both phrasings at once.
  await page.fill('.add-topic input', 'badge thread topic');
  await page.press('.add-topic input', 'Enter');
  const row = page.locator('.topic', { hasText: 'badge thread topic' });
  await expect(row).toBeVisible();
  const cards = page.locator('.item:not(.flagged-row)', {
    has: page.locator('.item-topic', { hasText: 'badge thread topic' }),
  });
  await expect(cards).toHaveCount(2, { timeout: 20_000 });

  // The newer story is the 2nd update; the one that started the thread says how
  // many followed it, because "1st update" would be wrong.
  await expect(cards.first().locator('.thread-badge')).toHaveText('2nd update');
  await expect(cards.nth(1).locator('.thread-badge')).toHaveText('1 follow-up');

  // The badge **is** the expander, so its accessible name says what pressing it
  // does and carries the date the card has no room to show.
  const expander = cards.first().locator('[data-expand-item]');
  await expect(expander).toHaveAttribute('aria-label', 'Show the story so far — 2nd update · since today');
  await expect(expander).toHaveAttribute('title', '2nd update · since today');

  // …and pressing it opens the timeline, which is the whole point of the badge.
  await expander.click();
  await expect(cards.first().locator('.thread-row')).toHaveCount(2);
  await expect(expander).toHaveAttribute('aria-label', 'Hide the story so far — 2nd update · since today');
  await expander.click();
  await expect(cards.first().locator('.item-pane')).toBeHidden();

  // No collision with bookmark and share, at the narrow viewport where the
  // header has least room. Asserted as geometry rather than as a class, because
  // "does not crowd" is a question about pixels — and a long topic name beside a
  // header's controls has read as cramped before (NEWS-71).
  await page.setViewportSize({ width: 420, height: 900 });
  const boxes = await Promise.all(
    ['[data-save-item]', '[data-share-item]', '.thread-badge'].map((sel) =>
      cards.first().locator(sel).boundingBox(),
    ),
  );
  const [save, share, badge] = boxes;
  expect(save).not.toBeNull();
  expect(share).not.toBeNull();
  expect(badge).not.toBeNull();
  if (save === null || share === null || badge === null) return;
  // Left to right, in order, with no overlap…
  expect(save.x + save.width).toBeLessThanOrEqual(share.x);
  expect(share.x + share.width).toBeLessThanOrEqual(badge.x);
  // …on one row (centres within a couple of pixels), and inside the card.
  const centre = (b: { y: number; height: number }) => b.y + b.height / 2;
  expect(Math.abs(centre(badge) - centre(save))).toBeLessThan(3);
  const card = await cards.first().boundingBox();
  expect(card).not.toBeNull();
  if (card !== null) expect(badge.x + badge.width).toBeLessThanOrEqual(card.x + card.width);
  await page.setViewportSize({ width: 1280, height: 900 });

  await topicAction(page, row, 'delete');
  await expect(page.locator('.topic', { hasText: 'badge thread topic' })).toHaveCount(0);
});

test('unrelated stories in one topic stay separate threads', async ({ page }) => {
  await page.goto('/');
  // The mock's default pair shares only the topic's own name, which threading
  // discounts — so these must stay two threads of one.
  const topicId = await addTopic(page, 'Unrelated Probe');

  await expect.poll(async () => (await items(page, topicId)).length, { timeout: 20_000 }).toBe(2);
  const stored = await items(page, topicId);
  expect(new Set(stored.map((i) => i.threadId)).size).toBe(2);
  // Each is a thread of one, which means its thread id is its own id.
  for (const item of stored) expect(item.threadId).toBe(item.id);

  await page.request.delete(`/api/topics/${encodeURIComponent(topicId)}`);
});
