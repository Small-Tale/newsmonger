import { describe, expect, it } from 'vitest';

import { parseNewsResult } from '../../src/ai/prompt.js';
import { outletFor, publishedLabel } from '../../src/client/attribution.js';

/** These tests are about item fields; `.items` keeps them focused on that. */
const itemsOf = (text: string) => parseNewsResult(text).items;

function fenced(items: unknown): string {
  return `\`\`\`json\n${JSON.stringify({ items })}\n\`\`\``;
}

describe('parsing outlet and publishedAt (NEWS-82)', () => {
  it('reads both when the model supplies them', () => {
    const [story] = itemsOf(
      fenced([
        {
          title: 'T',
          summary: 'S',
          sources: [{ title: 'Src', url: 'https://a.com/x', outlet: 'Reuters', publishedAt: '2026-07-20' }],
        },
      ]),
    );
    expect(story.sources[0].outlet).toBe('Reuters');
    expect(story.sources[0].publishedAt).toBe('2026-07-20');
  });

  it('defaults both to null when the model omits them', () => {
    // The overwhelmingly common case — and it must not fail the parse, or one
    // missing date would cost the whole batch of stories.
    const [story] = itemsOf(
      fenced([{ title: 'T', summary: 'S', sources: [{ title: 'Src', url: 'https://a.com/x' }] }]),
    );
    expect(story.sources[0].outlet).toBeNull();
    expect(story.sources[0].publishedAt).toBeNull();
  });

  it('degrades a malformed date to null rather than failing the batch', () => {
    // `.catch(null)`: a model that writes "last Tuesday" costs us a date, not
    // every story in the response.
    const [story] = itemsOf(
      fenced([
        {
          title: 'T',
          summary: 'S',
          sources: [{ title: 'Src', url: 'https://a.com/x', publishedAt: 'last Tuesday' }],
        },
      ]),
    );
    expect(story.sources[0].publishedAt).toBeNull();
  });

  it('rejects a date that is not YYYY-MM-DD', () => {
    const [story] = itemsOf(
      fenced([
        { title: 'T', summary: 'S', sources: [{ title: 'S', url: 'https://a.com/x', publishedAt: '20/07/2026' }] },
      ]),
    );
    expect(story.sources[0].publishedAt).toBeNull();
  });

  it('strips citation markup from the outlet like every other prose field', () => {
    // `stripMarkup` removes the tags and keeps the inner text, same as it does
    // for titles and summaries — the point is that no markup reaches the DOM.
    const [story] = itemsOf(
      fenced([
        {
          title: 'T',
          summary: 'S',
          sources: [{ title: 'Src', url: 'https://a.com/x', outlet: '<cite>Reuters</cite>' }],
        },
      ]),
    );
    expect(story.sources[0].outlet).toBe('Reuters');
  });
});

describe('outletFor (NEWS-82)', () => {
  it('prefers what the model said', () => {
    expect(outletFor({ outlet: 'Reuters', url: 'https://www.reuters.com/a' })).toBe('Reuters');
  });

  it('falls back to the registrable domain without www', () => {
    expect(outletFor({ outlet: null, url: 'https://www.bbc.co.uk/news/x' })).toBe('bbc.co.uk');
    expect(outletFor({ outlet: '', url: 'https://apnews.com/article/y' })).toBe('apnews.com');
  });

  it('returns nothing rather than throwing on an unparseable URL', () => {
    expect(outletFor({ outlet: null, url: 'not a url' })).toBe('');
  });
});

describe('publishedLabel (NEWS-82)', () => {
  it('says nothing when the article was published the day it was found', () => {
    // The normal case. The feed's own day heading already says it, so repeating
    // it on every story would be noise.
    expect(publishedLabel('2026-07-27', '2026-07-27T09:00:00Z')).toBe('');
  });

  it('speaks up when the story is older than the day it was filed under', () => {
    // Exactly when the day heading is misleading: a catch-up check after
    // downtime files week-old articles under today.
    expect(publishedLabel('2026-07-26', '2026-07-27T09:00:00Z')).toBe('published a day earlier');
    expect(publishedLabel('2026-07-24', '2026-07-27T09:00:00Z')).toBe('published 3 days earlier');
  });

  it('gives the absolute date once the gap is a week or more', () => {
    // "published 23 days earlier" is arithmetic the reader shouldn't have to do.
    expect(publishedLabel('2026-07-04', '2026-07-27T09:00:00Z')).toBe('published 2026-07-04');
  });

  it('says nothing for a date in the future of the found date', () => {
    // Nonsense input from the model shouldn't render as a negative day count.
    expect(publishedLabel('2026-08-01', '2026-07-27T09:00:00Z')).toBe('');
  });
});
