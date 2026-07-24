import { describe, expect, it } from 'vitest';

import type { StateResp } from '../../src/api/schemas.js';
import { filterItemsByQuery, itemMatchesQuery } from '../../src/client/search.js';

type NewsItem = StateResp['items'][number];

let seq = 0;
function item(over: Partial<NewsItem> = {}): NewsItem {
  seq += 1;
  return {
    id: `i${String(seq)}`,
    topicId: 't1',
    title: 'Fusion reactor milestone',
    summary: 'A tokamak sustained net-positive output.',
    saved: false,
    sources: [],
    image: null,
    dedupeKey: `k${String(seq)}`,
    foundAt: '2026-07-24T00:00:00Z',
    ...over,
  };
}

describe('itemMatchesQuery (NEWS-60)', () => {
  it('matches everything on an empty or whitespace query', () => {
    expect(itemMatchesQuery(item(), 'Energy', '')).toBe(true);
    expect(itemMatchesQuery(item(), 'Energy', '   ')).toBe(true);
  });

  it('matches the title, case-insensitively', () => {
    expect(itemMatchesQuery(item({ title: 'Tokamak news' }), 'Energy', 'TOKAMAK')).toBe(true);
  });

  it('matches the summary', () => {
    expect(itemMatchesQuery(item({ summary: 'net-positive output' }), 'Energy', 'net-positive')).toBe(true);
  });

  it('matches the topic name even when the story text does not', () => {
    expect(itemMatchesQuery(item({ title: 'X', summary: 'Y' }), 'Fusion Energy', 'fusion')).toBe(true);
  });

  it('does not match when the query is absent from all fields', () => {
    expect(itemMatchesQuery(item({ title: 'X', summary: 'Y' }), 'Topic', 'quantum')).toBe(false);
  });
});

describe('filterItemsByQuery (NEWS-60)', () => {
  const names = new Map([
    ['t1', 'Fusion Energy'],
    ['t2', 'Quantum Computing'],
  ]);

  it('returns the input unchanged for an empty query', () => {
    const items = [item(), item()];
    expect(filterItemsByQuery(items, names, '')).toBe(items);
  });

  it('keeps only items matching the query, resolving topic names', () => {
    const items = [
      item({ id: 'a', topicId: 't1', title: 'reactor' }),
      item({ id: 'b', topicId: 't2', title: 'qubit breakthrough' }),
      item({ id: 'c', topicId: 't2', title: 'unrelated' }), // matches via topic name "Quantum"
    ];
    expect(filterItemsByQuery(items, names, 'quantum').map((i) => i.id)).toEqual(['b', 'c']);
  });

  it('falls back gracefully when a topic name is missing', () => {
    const items = [item({ id: 'a', topicId: 'gone', title: 'orphan' })];
    expect(filterItemsByQuery(items, names, 'orphan').map((i) => i.id)).toEqual(['a']);
    expect(filterItemsByQuery(items, names, 'fusion')).toEqual([]);
  });
});
