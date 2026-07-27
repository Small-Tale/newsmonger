import { describe, expect, it } from 'vitest';

import { shareText } from '../../src/client/share.js';
import type { NewsItem } from '../../src/db/schemas.js';

function item(over: Partial<NewsItem> = {}): NewsItem {
  return {
    id: 'i1',
    topicId: 't1',
    title: 'Fusion milestone',
    summary: 'A reactor sustained net-positive output for a full minute.',
    sources: [{ title: 'Lab', url: 'https://example.com/fusion', outlet: null, publishedAt: null }],
    image: null,
    saved: false,
    offTopic: false,
    dedupeKey: 'k',
    foundAt: '2026-07-24T00:00:00.000Z',
    ...over,
  };
}

describe('shareText', () => {
  it('formats title, summary, and the first source url as a block', () => {
    expect(shareText(item())).toBe(
      'Fusion milestone\n\nA reactor sustained net-positive output for a full minute.\n\nhttps://example.com/fusion',
    );
  });

  it('uses only the first source when there are several', () => {
    const text = shareText(
      item({
        sources: [
          { title: 'A', url: 'https://a.example/1', outlet: null, publishedAt: null },
          { title: 'B', url: 'https://b.example/2', outlet: null, publishedAt: null },
        ],
      }),
    );
    expect(text).toContain('https://a.example/1');
    expect(text).not.toContain('https://b.example/2');
  });

  it('omits the link entirely when a story has no sources', () => {
    // No trailing blank line + dangling nothing — just title and summary.
    expect(shareText(item({ sources: [] }))).toBe('Fusion milestone\n\nA reactor sustained net-positive output for a full minute.');
  });
});
