import type { Page } from '@playwright/test';

import { expect, resetTopics, test } from './fixtures.js';

// Story threads (NEWS-280): two outlets' coverage of one subject lands in a
// single thread, and unrelated stories in the same topic do not.
//
// Serial and self-contained like the rest of the suite: it creates its own
// topics and deletes them at the end.

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  await resetTopics(test.info().project.use.baseURL ?? '');
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
