import { describe, expect, it } from 'vitest';

import { Store } from '../../src/db/store.js';
import { tmpDataDir } from '../helpers/tmp.js';

/** A store with `apple`/`banana` topics and a handful of items. */
function seeded() {
  const store = new Store(tmpDataDir());
  const apple = store.addTopic('Apple');
  const banana = store.addTopic('Banana');
  // foundAt ascending here; the query returns newest-first.
  const mk = (topicId: string, title: string, summary: string, min: number) =>
    store.addItems([
      {
        topicId,
        title,
        summary,
        sources: [],
        dedupeKey: `${title}-${String(min)}`,
        foundAt: `2026-07-24T00:${String(min).padStart(2, '0')}:00Z`,
      },
    ])[0];
  const a1 = mk(apple.id, 'Apple pie recipe', 'a tasty pie', 1);
  const a2 = mk(apple.id, 'Apple stock rises', 'the company gained', 2);
  const b1 = mk(banana.id, 'Banana bread', 'baking news', 3);
  return { store, apple, banana, ids: { a1: a1.id, a2: a2.id, b1: b1.id } };
}

describe('Store.queryItems (NEWS-74)', () => {
  it('returns everything newest-first for the default normal view', () => {
    const { store, ids } = seeded();
    const { items, total, nextCursor } = store.queryItems({ mode: 'normal', limit: 100 });
    expect(items.map((i) => i.id)).toEqual([ids.b1, ids.a2, ids.a1]); // newest → oldest
    expect(total).toBe(3);
    expect(nextCursor).toBeNull();
  });

  it('filters by topic (solo)', () => {
    const { store, apple, ids } = seeded();
    const { items, total } = store.queryItems({ mode: 'normal', topicIds: [apple.id], limit: 100 });
    expect(items.map((i) => i.id)).toEqual([ids.a2, ids.a1]);
    expect(total).toBe(2);
  });

  it('filters by saved', () => {
    const { store, ids } = seeded();
    store.setItemSaved(ids.a2, true);
    const { items, total } = store.queryItems({ mode: 'normal', saved: true, limit: 100 });
    expect(items.map((i) => i.id)).toEqual([ids.a2]);
    expect(total).toBe(1);
  });

  it('searches title, summary, and topic name', () => {
    const { store, ids } = seeded();
    expect(store.queryItems({ mode: 'normal', q: 'pie', limit: 100 }).items.map((i) => i.id)).toEqual([ids.a1]);
    expect(store.queryItems({ mode: 'normal', q: 'gained', limit: 100 }).items.map((i) => i.id)).toEqual([ids.a2]);
    // "banana" matches only the Banana-topic item via the topic name.
    expect(store.queryItems({ mode: 'normal', q: 'banana', limit: 100 }).items.map((i) => i.id)).toEqual([ids.b1]);
  });

  it('excludes off-topic stories from the normal view; the review view shows only them', () => {
    const { store, apple, ids } = seeded();
    store.setItemOffTopic(ids.a1, true);
    expect(store.queryItems({ mode: 'normal', limit: 100 }).items.map((i) => i.id)).toEqual([ids.b1, ids.a2]);
    // Review is scoped to the given topics and shows only their flagged items.
    const review = store.queryItems({ mode: 'review', topicIds: [apple.id], limit: 100 });
    expect(review.items.map((i) => i.id)).toEqual([ids.a1]);
    expect(review.total).toBe(1);
  });

  it('cursor-pages without gaps or duplicates', () => {
    const { store } = seeded();
    const p1 = store.queryItems({ mode: 'normal', limit: 2 });
    expect(p1.items).toHaveLength(2);
    expect(p1.total).toBe(3);
    expect(p1.nextCursor).not.toBeNull();

    const p2 = store.queryItems({ mode: 'normal', limit: 2, before: p1.nextCursor });
    expect(p2.items).toHaveLength(1); // the last one
    expect(p2.nextCursor).toBeNull(); // no more

    const seen = [...p1.items, ...p2.items].map((i) => i.id);
    expect(new Set(seen).size).toBe(3); // no dupes
  });

  it('total reflects the filter, not the whole store', () => {
    const { store, apple } = seeded();
    expect(store.queryItems({ mode: 'normal', topicIds: [apple.id], limit: 1 }).total).toBe(2);
  });
});
