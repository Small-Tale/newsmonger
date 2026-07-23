import { describe, expect, it } from 'vitest';

import { dedupeKeyFor, filterNewItems, normalizeTitle, normalizeUrl } from '../../src/ai/dedupe.js';
import type { FoundNewsItem } from '../../src/ai/types.js';

function item(title: string, urls: string[]): FoundNewsItem {
  return { title, summary: 's', sources: urls.map((url) => ({ title: 't', url })) };
}

describe('normalizeUrl', () => {
  it('lowercases host, strips www, query, hash, and trailing slash', () => {
    expect(normalizeUrl('https://WWW.Example.com/A/b/?utm=x#frag')).toBe('example.com/A/b');
    expect(normalizeUrl('http://example.com/path/')).toBe('example.com/path');
  });

  it('treats http and https as equivalent', () => {
    expect(normalizeUrl('http://example.com/a')).toBe(normalizeUrl('https://example.com/a'));
  });

  it('returns null for unparseable or non-http urls', () => {
    expect(normalizeUrl('not a url')).toBeNull();
    expect(normalizeUrl('ftp://example.com/a')).toBeNull();
    expect(normalizeUrl('javascript:alert(1)')).toBeNull();
  });
});

describe('normalizeTitle', () => {
  it('lowercases, strips punctuation, collapses whitespace', () => {
    expect(normalizeTitle('  Big News:   AI  Breakthrough!! ')).toBe('big news ai breakthrough');
  });

  it('keeps unicode letters', () => {
    expect(normalizeTitle('Énergie — nucléaire')).toBe('énergie nucléaire');
  });
});

describe('dedupeKeyFor', () => {
  it('prefers the first parseable source url', () => {
    expect(dedupeKeyFor(item('T', ['bogus', 'https://a.com/x']))).toBe('url:a.com/x');
  });

  it('falls back to the normalized title when no source parses', () => {
    expect(dedupeKeyFor(item('Some Title!', ['bogus']))).toBe('title:some title');
    expect(dedupeKeyFor(item('Some Title!', []))).toBe('title:some title');
  });
});

describe('filterNewItems', () => {
  it('drops items whose key already exists', () => {
    const existing = new Set(['url:a.com/x']);
    const result = filterNewItems([item('A', ['https://a.com/x']), item('B', ['https://b.com/y'])], existing);
    expect(result.map((r) => r.item.title)).toEqual(['B']);
    expect(result[0]?.dedupeKey).toBe('url:b.com/y');
  });

  it('dedupes within the batch itself', () => {
    const result = filterNewItems(
      [item('A', ['https://a.com/x']), item('A again', ['https://www.a.com/x/'])],
      new Set(),
    );
    expect(result).toHaveLength(1);
  });

  it('passes everything through when nothing is known', () => {
    const result = filterNewItems([item('A', ['https://a.com/1']), item('B', ['https://a.com/2'])], new Set());
    expect(result).toHaveLength(2);
  });
});
