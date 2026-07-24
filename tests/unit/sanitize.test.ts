import { describe, expect, it } from 'vitest';

import { parseNewsResult } from '../../src/ai/prompt.js';
import { stripMarkup } from '../../src/ai/sanitize.js';
import { NewsItemSchema } from '../../src/db/schemas.js';
import { Store } from '../../src/db/store.js';
import { tmpDataDir } from '../helpers/tmp.js';

describe('stripMarkup', () => {
  it('removes citation tags but keeps the sentence inside them', () => {
    // Verbatim from the reported bug (NEWS-25): Claude's web_search tool wraps
    // cited sentences in <cite index="…">, and the text inside is the actual
    // summary — dropping it along with the tag would lose the content.
    const raw =
      'The US Open released its official entry list on July 22, with Alex Eala included as a direct entry. ' +
      '<cite index="11-2,11-3">The US Open announced the official ATP and WTA lists, which had Eala at No. 29.</cite> ' +
      '<cite index="11-4">If Eala stays in the top 32 she will secure a seed.</cite> ' +
      'The tournament runs August 30 to September 13.';

    const clean = stripMarkup(raw);

    expect(clean).not.toContain('<cite');
    expect(clean).not.toContain('</cite>');
    expect(clean).not.toContain('index=');
    expect(clean).toContain('The US Open announced the official ATP and WTA lists');
    expect(clean).toContain('If Eala stays in the top 32');
    expect(clean).toContain('The tournament runs August 30');
  });

  it('handles the tags a model might otherwise reach for', () => {
    expect(stripMarkup('a <b>bold</b> claim')).toBe('a bold claim');
    expect(stripMarkup('<p>para</p>')).toBe('para');
    expect(stripMarkup('line<br/>break')).toBe('linebreak');
    expect(stripMarkup('<a href="https://x.test">link</a>')).toBe('link');
  });

  it('decodes the entities that show up in prose', () => {
    expect(stripMarkup('AT&amp;T earnings')).toBe('AT&T earnings');
    expect(stripMarkup('&quot;quoted&quot;')).toBe('"quoted"');
    expect(stripMarkup('it&#39;s here')).toBe("it's here");
    expect(stripMarkup('a&nbsp;b')).toBe('a b');
  });

  it('leaves ordinary prose alone', () => {
    // The pattern requires a letter straight after `<`, so comparisons and
    // maths in a summary aren't mistaken for markup.
    expect(stripMarkup('profits fell < 5% this quarter')).toBe('profits fell < 5% this quarter');
    expect(stripMarkup('a < b and c > d')).toBe('a < b and c > d');
    expect(stripMarkup('the 5 > 3 rule')).toBe('the 5 > 3 rule');
    expect(stripMarkup('plain text')).toBe('plain text');
  });

  it('tidies the whitespace a removed tag leaves behind', () => {
    expect(stripMarkup('one <cite>two</cite> three')).toBe('one two three');
    expect(stripMarkup('ends with a tag <cite>here</cite>.')).toBe('ends with a tag here.');
    expect(stripMarkup('  padded  ')).toBe('padded');
  });

  it('is idempotent, so applying it on read and write is safe', () => {
    const once = stripMarkup('<cite index="1">text</cite> more');
    expect(stripMarkup(once)).toBe(once);
  });

  it('survives a string that is nothing but markup', () => {
    expect(stripMarkup('<cite index="1"></cite>')).toBe('');
  });
});

describe('parseNewsResult sanitizes model output', () => {
  it('strips citation markup from titles, summaries and source titles', () => {
    const text = `\`\`\`json
{"items":[{
  "title":"<cite index=\\"1\\">Eala confirmed</cite> in main draw",
  "summary":"Entry list published. <cite index=\\"11-2\\">She is seeded No. 29.</cite>",
  "sources":[{"title":"<b>The Manila Times</b>","url":"https://example.test/a"}]
}]}
\`\`\``;

    const items = parseNewsResult(text);

    expect(items).toHaveLength(1);
    expect(items[0]?.title).toBe('Eala confirmed in main draw');
    expect(items[0]?.summary).toBe('Entry list published. She is seeded No. 29.');
    expect(items[0]?.sources[0]?.title).toBe('The Manila Times');
  });

  it('leaves the source url untouched', () => {
    // Only prose is sanitized — a URL is data, and mangling it would break the
    // link rather than tidy it.
    const text = '{"items":[{"title":"t","summary":"s","sources":[{"title":"x","url":"https://a.test/p?q=1&b=2"}]}]}';
    expect(parseNewsResult(text)[0]?.sources[0]?.url).toBe('https://a.test/p?q=1&b=2');
  });
});

describe('stored items are cleaned on read', () => {
  it('sanitizes items written before the parse-time strip existed', () => {
    // Data already on disk carries the markup, so the read boundary cleans it
    // too rather than requiring a migration.
    const stored = {
      id: 'i1',
      topicId: 't1',
      title: '<cite index="2">Old headline</cite>',
      summary: 'Body. <cite index="3">Cited sentence.</cite>',
      sources: [{ title: '<i>Source</i>', url: 'https://example.test/x' }],
      dedupeKey: 'k',
      foundAt: '2026-07-24T00:00:00.000Z',
    };

    const parsed = NewsItemSchema.parse(stored);

    expect(parsed.title).toBe('Old headline');
    expect(parsed.summary).toBe('Body. Cited sentence.');
    expect(parsed.sources[0]?.title).toBe('Source');
    expect(parsed.sources[0]?.url).toBe('https://example.test/x');
  });
});

describe('an existing data file is cleaned when the store loads it', () => {
  it('serves sanitized items and persists the clean text on next write', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const dir = tmpDataDir();

    // A file written before the fix, with citation markup in a stored item.
    fs.writeFileSync(
      path.join(dir, 'data.json'),
      JSON.stringify({
        topics: [
          {
            id: 't1',
            name: 'tennis',
            paused: false,
            createdAt: '2026-07-24T00:00:00.000Z',
            lastCheckedAt: null,
            coveredThroughAt: null,
          },
        ],
        items: [
          {
            id: 'i1',
            topicId: 't1',
            title: 'Eala confirmed',
            summary: 'Entry list out. <cite index="11-2">She is No. 29.</cite>',
            sources: [{ title: 'Manila Times', url: 'https://example.test/a' }],
            dedupeKey: 'k',
            foundAt: '2026-07-24T00:00:00.000Z',
          },
        ],
        settings: { checkIntervalMs: 86_400_000, provider: 'auto', model: '', endpoint: '' },
        runs: [],
      }),
    );

    const store = new Store(dir);
    expect(store.listItems()[0]?.summary).toBe('Entry list out. She is No. 29.');

    // Any subsequent write flushes the cleaned text back to disk, so the markup
    // doesn't linger in the file either.
    store.addTopic('another');
    const onDisk: unknown = JSON.parse(fs.readFileSync(path.join(dir, 'data.json'), 'utf-8'));
    expect(JSON.stringify(onDisk)).not.toContain('<cite');
  });
});
