import { describe, expect, it } from 'vitest';

import { createMockProvider } from '../../src/ai/providers/index.js';
import { CheckRunner } from '../../src/checks.js';
import { createApp } from '../../src/server.js';
import { asResolver } from '../helpers/provider.js';
import { tmpStore } from '../helpers/tmp.js';

function seededStore() {
  const store = tmpStore();
  const topic = store.addTopic('fusion');
  const [item] = store.addItems([
    { topicId: topic.id, title: 't', summary: 's', sources: [], dedupeKey: 'k', foundAt: '2026-07-24T00:00:00.000Z' },
  ]);
  return { store, topic, itemId: item.id };
}

describe('Store.setItemSaved', () => {
  it('new stories are not saved', () => {
    const { store, itemId } = seededStore();
    expect(store.listItems().find((i) => i.id === itemId)?.saved).toBe(false);
  });

  it('toggles the saved flag and persists it', () => {
    const { store, itemId } = seededStore();
    expect(store.setItemSaved(itemId, true)?.saved).toBe(true);
    expect(store.listItems()[0]?.saved).toBe(true);
    expect(store.setItemSaved(itemId, false)?.saved).toBe(false);
    expect(store.listItems()[0]?.saved).toBe(false);
  });

  it('survives a reload from disk', () => {
    const { store, itemId } = seededStore();
    store.setItemSaved(itemId, true);
    // A fresh Store over the same dir reads the flag back.
    const reopened = tmpStore(store.dataDir);
    expect(reopened.listItems()[0]?.saved).toBe(true);
  });

  it('returns null for an unknown item', () => {
    const { store } = seededStore();
    expect(store.setItemSaved('nope', true)).toBeNull();
  });

  it("a topic delete takes its saved stories with it", () => {
    // The save flag lives on the item, so it goes when the item does.
    const { store, topic, itemId } = seededStore();
    store.setItemSaved(itemId, true);
    store.deleteTopic(topic.id);
    expect(store.listItems()).toEqual([]);
  });
});

describe('PATCH /api/items/:id', () => {
  function makeApp() {
    const store = tmpStore();
    const topic = store.addTopic('fusion');
    const [item] = store.addItems([
      { topicId: topic.id, title: 't', summary: 's', sources: [], dedupeKey: 'k', foundAt: '2026-07-24T00:00:00.000Z' },
    ]);
    const runner = new CheckRunner(store, asResolver(createMockProvider()));
    return { app: createApp({ store, runner }), store, itemId: item.id };
  }

  it('saves and unsaves an item', async () => {
    const { app, store, itemId } = makeApp();
    let res = await app.request(`/api/items/${itemId}`, { method: 'PATCH', body: JSON.stringify({ saved: true }) });
    expect(res.status).toBe(200);
    expect(store.listItems()[0]?.saved).toBe(true);

    res = await app.request(`/api/items/${itemId}`, { method: 'PATCH', body: JSON.stringify({ saved: false }) });
    expect(res.status).toBe(200);
    expect(store.listItems()[0]?.saved).toBe(false);
  });

  it('404s for an unknown item', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/items/nope', { method: 'PATCH', body: JSON.stringify({ saved: true }) });
    expect(res.status).toBe(404);
  });

  it('rejects a malformed body', async () => {
    const { app, itemId } = makeApp();
    expect((await app.request(`/api/items/${itemId}`, { method: 'PATCH', body: '{}' })).status).toBe(400);
    expect(
      (await app.request(`/api/items/${itemId}`, { method: 'PATCH', body: JSON.stringify({ saved: 'yes' }) })).status,
    ).toBe(400);
  });

  it('the saved flag rides through the feed endpoint', async () => {
    const { app, itemId } = makeApp();
    await app.request(`/api/items/${itemId}`, { method: 'PATCH', body: JSON.stringify({ saved: true }) });
    const feed = (await (await app.request('/api/items')).json()) as { items: { id: string; saved: boolean }[] };
    expect(feed.items.find((i) => i.id === itemId)?.saved).toBe(true);
  });
});
