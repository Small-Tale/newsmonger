import { describe, expect, it } from 'vitest';

import type { StateResp } from '../../src/api/schemas.js';
import type { RowRenderState } from '../../src/client/topic-sort.js';
import { isHeading, sortTopics, topicRowCacheKey, topicRows } from '../../src/client/topic-sort.js';

type Topic = StateResp['topics'][number];

let seq = 0;
function topic(name: string, over: Partial<Topic> = {}): Topic {
  seq += 1;
  return {
    id: `t${String(seq)}`,
    name,
    paused: false,
    highPriority: false,
    guidance: '',
    createdAt: `2026-07-2${String(seq)}T00:00:00Z`,
    lastCheckedAt: null,
    coveredThroughAt: null,
    category: null,
    subcategory: null,
    categorySource: 'auto',
    autoCategory: null,
    consecutiveFailures: 0,
    retryAfter: null,
    clearedAt: null,
    ...over,
  };
}

describe('sortTopics (NEWS-63)', () => {
  it('alpha: orders by name A→Z, case-insensitively', () => {
    const t = [topic('Banana'), topic('apple'), topic('Cherry')];
    expect(sortTopics(t, 'alpha').map((x) => x.name)).toEqual(['apple', 'Banana', 'Cherry']);
  });

  it('added: newest createdAt first', () => {
    const a = topic('A', { createdAt: '2026-07-01T00:00:00Z' });
    const b = topic('B', { createdAt: '2026-07-10T00:00:00Z' });
    const c = topic('C', { createdAt: '2026-07-05T00:00:00Z' });
    expect(sortTopics([a, b, c], 'added').map((x) => x.name)).toEqual(['B', 'C', 'A']);
  });

  it('priority: high-priority first, then A→Z within each group', () => {
    const t = [
      topic('Zeta', { highPriority: true }),
      topic('Alpha', { highPriority: false }),
      topic('Beta', { highPriority: true }),
      topic('Yankee', { highPriority: false }),
    ];
    expect(sortTopics(t, 'priority').map((x) => x.name)).toEqual(['Beta', 'Zeta', 'Alpha', 'Yankee']);
  });

  it('never mutates the input array', () => {
    const t = [topic('B'), topic('A')];
    const before = t.map((x) => x.name);
    sortTopics(t, 'alpha');
    expect(t.map((x) => x.name)).toEqual(before);
  });
});

describe('sorting by section (NEWS-140)', () => {
  const t = (name: string, category: string | null): Topic => ({ ...topic(name), category, subcategory: null });

  it('orders by the taxonomy, not alphabetically by section name', () => {
    // Politics precedes Technology precedes Sports in the taxonomy, which is
    // deliberately not alphabetical — the rail should match the filter bar.
    const rows = sortTopics([t('Skiing', 'sports'), t('AI', 'technology'), t('Elections', 'politics')], 'category');
    expect(rows.map((r) => r.name)).toEqual(['Elections', 'AI', 'Skiing']);
  });

  it('sorts A→Z within a section', () => {
    const rows = sortTopics([t('Zebras', 'sports'), t('Archery', 'sports')], 'category');
    expect(rows.map((r) => r.name)).toEqual(['Archery', 'Zebras']);
  });

  it('puts unclassified topics last, not first', () => {
    const rows = sortTopics([t('Mystery', null), t('Skiing', 'sports')], 'category');
    expect(rows.map((r) => r.name)).toEqual(['Skiing', 'Mystery']);
  });

  it('treats a slug the taxonomy no longer has as unclassified', () => {
    // It renders under the Uncategorized heading, so it has to sort there too —
    // otherwise the heading and the rows beneath it disagree.
    const rows = sortTopics([t('Stale', 'not-a-section'), t('Skiing', 'sports')], 'category');
    expect(rows.map((r) => r.name)).toEqual(['Skiing', 'Stale']);
  });
});

describe('topicRows', () => {
  const t = (name: string, category: string | null): Topic => ({ ...topic(name), category, subcategory: null });

  it('adds no headings in any other sort', () => {
    for (const sort of ['alpha', 'added', 'priority'] as const) {
      const rows = topicRows([t('Skiing', 'sports'), t('AI', 'technology')], sort);
      expect(rows.some(isHeading)).toBe(false);
    }
  });

  it('passes topics through by reference, so `each()` can still memoize them', () => {
    // Wrapping each topic in a fresh object per render made every row a cache
    // miss: rows were rebuilt rather than morphed, and a focused row lost focus
    // the moment anything re-rendered — which broke keyboard access to the
    // topic menu entirely. Identity has to survive.
    const topics = [t('Skiing', 'sports'), t('AI', 'technology')];
    for (const sort of ['alpha', 'category'] as const) {
      const rows = topicRows(topics, sort);
      for (const original of topics) {
        expect(rows.some((row) => row === original)).toBe(true);
      }
    }
  });

  it('opens each section with one heading', () => {
    const rows = topicRows([t('Skiing', 'sports'), t('Archery', 'sports'), t('AI', 'technology')], 'category');
    expect(rows.map((r) => (isHeading(r) ? `# ${r.label}` : r.name))).toEqual([
      '# Technology',
      'AI',
      '# Sports',
      'Archery',
      'Skiing',
    ]);
  });

  it('names the unclassified section', () => {
    const rows = topicRows([t('Mystery', null)], 'category');
    expect(rows[0]).toMatchObject({ kind: 'heading', label: 'Uncategorized' });
  });

  it('gives headings keys that cannot collide with a topic id', () => {
    // Both share one `data-key` namespace in the rail's single keyed list.
    const rows = topicRows([t('Skiing', 'sports')], 'category');
    const keys = rows.map((r) => (isHeading(r) ? r.key : r.id));
    expect(new Set(keys).size).toBe(rows.length);
    expect(keys[0]).toContain('heading:');
  });

  it('returns nothing for nothing', () => {
    expect(topicRows([], 'category')).toEqual([]);
  });
});

describe('sortTopics: recent (NEWS-241)', () => {
  it('puts the topic with the newest story first', () => {
    const old = topic('Old', { id: 'a' });
    const fresh = topic('Fresh', { id: 'b' });
    const middling = topic('Middling', { id: 'c' });
    const newest = {
      a: '2026-07-01T10:00:00Z',
      b: '2026-07-30T10:00:00Z',
      c: '2026-07-15T10:00:00Z',
    };
    expect(sortTopics([old, fresh, middling], 'recent', newest).map((t) => t.name)).toEqual([
      'Fresh',
      'Middling',
      'Old',
    ]);
  });

  /**
   * The trap: a topic with no stories is simply absent from the map. Treating a
   * missing timestamp as an empty string would sort it **first** under a
   * descending compare — so "newest stories" would lead with the topics that
   * have none, which is the exact opposite of the promise.
   */
  it('sinks topics that have never produced a story, rather than floating them', () => {
    const never = topic('Never', { id: 'a' });
    const alsoNever = topic('Also never', { id: 'b' });
    const has = topic('Has stories', { id: 'c' });
    const order = sortTopics([never, alsoNever, has], 'recent', { c: '2026-07-01T00:00:00Z' }).map(
      (t) => t.name,
    );
    expect(order[0]).toBe('Has stories');
    // The empty ones keep a stable order among themselves — A→Z, not input order.
    expect(order.slice(1)).toEqual(['Also never', 'Never']);
  });

  it('falls back to A→Z when two topics share a timestamp', () => {
    const same = '2026-07-20T12:00:00Z';
    const zebra = topic('Zebra', { id: 'a' });
    const apple = topic('Apple', { id: 'b' });
    expect(sortTopics([zebra, apple], 'recent', { a: same, b: same }).map((t) => t.name)).toEqual([
      'Apple',
      'Zebra',
    ]);
  });

  it('never mutates the array it was given', () => {
    const a = topic('A', { id: 'a' });
    const b = topic('B', { id: 'b' });
    const input = [a, b];
    sortTopics(input, 'recent', { b: '2026-07-30T00:00:00Z' });
    expect(input).toEqual([a, b]);
  });

  it('degrades to A→Z with no timestamps at all', () => {
    // The map is optional, and an older client or a first paint has none.
    const zebra = topic('Zebra');
    const apple = topic('Apple');
    expect(sortTopics([zebra, apple], 'recent').map((t) => t.name)).toEqual(['Apple', 'Zebra']);
  });

  it('adds no headings, the way every non-category sort does not', () => {
    const rows = topicRows([topic('A'), topic('B')], 'recent', {});
    expect(rows.some((r) => isHeading(r))).toBe(false);
  });
});

describe('topicRowCacheKey (NEWS-238)', () => {
  /**
   * The bug: the key was built entirely from *state* and named no row, so two
   * topics in the same category with the same flags produced the same key — and
   * `each()`, whose memo cache is keyed by this string, served one of them the
   * other's cached HTML. kerf's own diagnostic caught it in CI and printed the
   * colliding value:
   *
   *   duplicate cacheKey values (duplicate: world|null|false|0|false|0|false|false||2)
   *
   * Every test below states a property rather than an exact string, so the key's
   * format stays free to change and its two obligations do not.
   */
  const EMPTY: RowRenderState = {
    selected: new Set(),
    solo: new Set(),
    checking: [],
    todayByTopic: {},
    newestItemAtByTopic: {},
  };
  const topic = (over: Partial<Topic> = {}): Topic => ({
    id: 'a',
    name: 'Alpha',
    paused: false,
    highPriority: false,
    guidance: '',
    category: 'world',
    subcategory: null,
    categorySource: 'auto',
    autoCategory: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    lastCheckedAt: null,
    coveredThroughAt: null,
    consecutiveFailures: 0,
    retryAfter: null,
    clearedAt: null,
    ...over,
  });

  it('is unique for two topics that differ only by identity', () => {
    // The exact collision from CI: same category, same everything, two rows.
    const a = topic({ id: 'a', name: 'World news' });
    const b = topic({ id: 'b', name: 'World affairs' });
    expect(topicRowCacheKey(a, EMPTY)).not.toBe(topicRowCacheKey(b, EMPTY));
  });

  it('is unique across a realistic sidebar', () => {
    // A stronger form of the same property: no pair anywhere in a list may
    // collide, however alike two topics are.
    const rows = topicRows(
      [
        topic({ id: '1', name: 'World news' }),
        topic({ id: '2', name: 'World affairs' }),
        topic({ id: '3', name: 'Markets', category: 'business' }),
        topic({ id: '4', name: 'Rates', category: 'business' }),
      ],
      'category',
    );
    const keys = rows.map((r) => topicRowCacheKey(r, EMPTY));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('still changes when state outside the topic object changes', () => {
    // The other half of the job, and the reason a bare `row.id` would be wrong:
    // identity must not mask a change in what the row renders.
    const t = topic();
    const base = topicRowCacheKey(t, EMPTY);
    const variants: RowRenderState[] = [
      { ...EMPTY, selected: new Set(['a']) },
      { ...EMPTY, selected: new Set(['z']) }, // selection count drives "sole selection"
      { ...EMPTY, solo: new Set(['a']) },
      { ...EMPTY, solo: new Set(['z']) }, // …and dimming depends on anything being soloed
      { ...EMPTY, checking: ['a'] },
      { ...EMPTY, todayByTopic: { a: 3 } },
      // NEWS-273: the row says "no stories" for a checked topic holding none, so
      // gaining or losing its last story has to change the key or the row keeps
      // the stale sentence.
      { ...EMPTY, newestItemAtByTopic: { a: '2026-08-03T00:00:00.000Z' } },
    ];
    for (const [i, state] of variants.entries()) {
      expect(topicRowCacheKey(t, state), `variant ${String(i)}`).not.toBe(base);
    }
  });

  it('keys on whether a topic has stories, not on when the newest arrived', () => {
    // Presence only (NEWS-273). Keying on the timestamp would invalidate the memo
    // on every new story and re-render the whole sidebar for a sentence that did
    // not change.
    const t = topic();
    const early = topicRowCacheKey(t, { ...EMPTY, newestItemAtByTopic: { a: '2026-08-01T00:00:00.000Z' } });
    const later = topicRowCacheKey(t, { ...EMPTY, newestItemAtByTopic: { a: '2026-08-03T00:00:00.000Z' } });
    expect(later).toBe(early);
    expect(topicRowCacheKey(t, EMPTY)).not.toBe(early);
  });

  it('still changes when the topic itself changes', () => {
    const base = topicRowCacheKey(topic(), EMPTY);
    expect(topicRowCacheKey(topic({ highPriority: true }), EMPTY)).not.toBe(base);
    expect(topicRowCacheKey(topic({ guidance: 'focus on policy' }), EMPTY)).not.toBe(base);
    expect(topicRowCacheKey(topic({ category: 'science' }), EMPTY)).not.toBe(base);
    expect(topicRowCacheKey(topic({ subcategory: 'space' }), EMPTY)).not.toBe(base);
  });

  it('keys a heading by its label', () => {
    // A heading renders nothing but its label, and section labels are distinct
    // within a list — so the label is both sufficient and unique.
    const rows = topicRows([topic({ id: '1' }), topic({ id: '2', category: 'science' })], 'category');
    const headings = rows.filter(isHeading);
    expect(headings.length).toBeGreaterThan(1);
    for (const h of headings) expect(topicRowCacheKey(h, EMPTY)).toBe(h.label);
  });
});
