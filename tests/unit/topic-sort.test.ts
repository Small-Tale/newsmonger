import { describe, expect, it } from 'vitest';

import type { StateResp } from '../../src/api/schemas.js';
import { isHeading, sortTopics, topicRows } from '../../src/client/topic-sort.js';

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
    consecutiveFailures: 0,
    retryAfter: null,
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
