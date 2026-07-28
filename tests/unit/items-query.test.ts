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

describe('category filtering (NEWS-97)', () => {
  /** Two topics in different sections, one uncategorized, one story each. */
  function categorised(): { store: Store; ids: Record<string, string> } {
    const store = new Store(tmpDataDir());
    const soccer = store.addTopic('Soccer');
    const tennis = store.addTopic('Tennis');
    const sportsOnly = store.addTopic('Skiing');
    const none = store.addTopic('Unlabelled');
    store.setTopicCategory(soccer.id, 'sports', 'soccer', 'auto');
    store.setTopicCategory(tennis.id, 'sports', 'tennis', 'auto');
    // A category with no subcategory — the "Other" case (FR-22.6).
    store.setTopicCategory(sportsOnly.id, 'sports', null, 'auto');
    const culture = store.addTopic('Books');
    store.setTopicCategory(culture.id, 'culture', 'books', 'auto');

    let n = 0;
    for (const t of [soccer, tennis, sportsOnly, none, culture]) {
      n += 1;
      store.addItems([
        {
          topicId: t.id,
          title: `${t.name} story`,
          summary: 's',
          sources: [],
          dedupeKey: `k${String(n)}`,
          foundAt: `2026-07-2${String(n)}T00:00:00.000Z`,
        },
      ]);
    }
    return {
      store,
      ids: { soccer: soccer.id, tennis: tennis.id, sportsOnly: sportsOnly.id, none: none.id, culture: culture.id },
    };
  }

  const titles = (r: { items: { title: string }[] }): string[] => r.items.map((i) => i.title).sort();

  it('filters to a category, including its subcategories', () => {
    const { store } = categorised();
    const r = store.queryItems({ mode: 'normal', category: 'sports', limit: 50 });
    expect(titles(r)).toEqual(['Skiing story', 'Soccer story', 'Tennis story']);
    // `total` must reflect the filter too, or "Show more" would lie.
    expect(r.total).toBe(3);
  });

  it('filters to a subcategory', () => {
    const { store } = categorised();
    expect(titles(store.queryItems({ mode: 'normal', category: 'sports', subcategory: 'soccer', limit: 50 }))).toEqual(
      ['Soccer story'],
    );
  });

  it('selects topics in a category with no subcategory via the "other" sentinel', () => {
    const { store } = categorised();
    expect(titles(store.queryItems({ mode: 'normal', category: 'sports', subcategory: 'other', limit: 50 }))).toEqual(
      ['Skiing story'],
    );
  });

  it('selects uncategorized topics via the sentinel', () => {
    const { store } = categorised();
    expect(titles(store.queryItems({ mode: 'normal', category: 'uncategorized', limit: 50 }))).toEqual([
      'Unlabelled story',
    ]);
  });

  it('returns everything with no category filter', () => {
    const { store } = categorised();
    expect(store.queryItems({ mode: 'normal', limit: 50 }).items).toHaveLength(5);
  });

  it('returns nothing for a category no topic holds', () => {
    const { store } = categorised();
    expect(store.queryItems({ mode: 'normal', category: 'health', limit: 50 }).items).toEqual([]);
  });

  it('composes with search and saved rather than replacing them', () => {
    const { store, ids } = categorised();
    const soccerItem = store.listItems(ids.soccer)[0];
    store.setItemSaved(soccerItem.id, true);

    // Sports + saved → only the saved sports story.
    expect(titles(store.queryItems({ mode: 'normal', category: 'sports', saved: true, limit: 50 }))).toEqual([
      'Soccer story',
    ]);
    // Sports + a search that only the tennis story matches.
    expect(titles(store.queryItems({ mode: 'normal', category: 'sports', q: 'tennis', limit: 50 }))).toEqual([
      'Tennis story',
    ]);
    // Culture + a sports search → nothing, because they intersect.
    expect(store.queryItems({ mode: 'normal', category: 'culture', q: 'tennis', limit: 50 }).items).toEqual([]);
  });

  it('paginates within the filter', () => {
    const { store } = categorised();
    // Newest first, so the three sports stories page as Skiing/Tennis, then
    // Soccer — asserted in order, since a cursor bug shows up as a wrong split
    // rather than a wrong count.
    const first = store.queryItems({ mode: 'normal', category: 'sports', limit: 2 });
    expect(first.items.map((i) => i.title)).toEqual(['Skiing story', 'Tennis story']);
    expect(first.total).toBe(3);
    expect(first.nextCursor).not.toBeNull();

    const second = store.queryItems({ mode: 'normal', category: 'sports', limit: 2, before: first.nextCursor });
    // No overlap, still only sports, and the page ends there.
    expect(second.items.map((i) => i.title)).toEqual(['Soccer story']);
    expect(second.nextCursor).toBeNull();
  });

  it('counts a story whose topic is gone as uncategorized', () => {
    // Orphans stay visible in the feed by design (the LEFT JOIN, NEWS-94/105).
    // They have no topic and therefore no category, so this is where they land —
    // worth pinning, since it falls out of the join rather than being written.
    const { store, ids } = categorised();
    store.deleteTopic(ids.tennis);
    store.addItems([
      {
        topicId: ids.tennis,
        title: 'Orphan story',
        summary: 's',
        sources: [],
        dedupeKey: 'orphan',
        foundAt: '2026-07-28T00:00:00.000Z',
      },
    ]);

    expect(titles(store.queryItems({ mode: 'normal', category: 'uncategorized', limit: 50 }))).toContain(
      'Orphan story',
    );
  });
});
