import { describe, expect, it } from 'vitest';

import { createMockProvider } from '../../src/ai/providers/index.js';
import { CheckRunner } from '../../src/checks.js';
import type { NewsItem, Topic } from '../../src/db/schemas.js';
import { Store } from '../../src/db/store.js';
import type { ExportInput } from '../../src/export.js';
import { escapeXml, toAtom, toJson, toMarkdown } from '../../src/export.js';
import { createApp } from '../../src/server.js';
import { asResolver } from '../helpers/provider.js';
import { tmpDataDir } from '../helpers/tmp.js';

const NOW = new Date('2026-07-27T12:00:00.000Z');

function topic(over: Partial<Topic> = {}): Topic {
  return {
    id: 't1',
    name: 'Fusion Energy',
    paused: false,
    highPriority: false,
    guidance: '',
    createdAt: '2026-07-01T00:00:00Z',
    lastCheckedAt: null,
    coveredThroughAt: null,
    category: null,
    subcategory: null,
    categorySource: 'auto',
    ...over,
  };
}

function item(over: Partial<NewsItem> = {}): NewsItem {
  return {
    id: 'i1',
    topicId: 't1',
    title: 'Reactor hits milestone',
    summary: 'A tokamak sustained plasma for a record duration.',
    saved: false,
    offTopic: false,
    sources: [{ title: 'Example News', url: 'https://news.example.com/a?x=1&y=2', outlet: null, publishedAt: null }],
    image: null,
    dedupeKey: 'k1',
    foundAt: '2026-07-26T09:00:00.000Z',
    ...over,
  };
}

function input(over: Partial<ExportInput> = {}): ExportInput {
  return {
    items: [item()],
    topics: [topic()],
    title: 'All stories',
    baseUrl: 'http://127.0.0.1:4187',
    now: NOW,
    ...over,
  };
}

describe('toMarkdown (NEWS-85)', () => {
  it('groups by topic and links every source', () => {
    const md = toMarkdown(input());
    expect(md).toContain('# All stories');
    expect(md).toContain('## Fusion Energy');
    expect(md).toContain('### Reactor hits milestone');
    expect(md).toContain('[Example News](https://news.example.com/a?x=1&y=2)');
  });

  it('names a deleted topic rather than emitting a bare id heading', () => {
    expect(toMarkdown(input({ topics: [] }))).toContain('## Deleted topic');
  });

  it('says so when there is nothing to export', () => {
    expect(toMarkdown(input({ items: [] }))).toContain('_No stories._');
  });
});

describe('toJson (NEWS-85)', () => {
  it('is parseable and carries the topic name rather than its id', () => {
    const parsed = JSON.parse(toJson(input())) as {
      stories: { topic: string; sources: { url: string }[] }[];
    };
    expect(parsed.stories[0].topic).toBe('Fusion Energy');
    expect(parsed.stories[0].sources[0].url).toBe('https://news.example.com/a?x=1&y=2');
  });
});

describe('escapeXml', () => {
  it('escapes all five metacharacters', () => {
    expect(escapeXml(`<a href="x">&'`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&apos;');
  });
});

describe('toAtom (NEWS-85)', () => {
  it('produces a well-formed feed with one entry per story', () => {
    const xml = toAtom(input());
    expect(xml.startsWith('<?xml version="1.0" encoding="utf-8"?>')).toBe(true);
    expect(xml).toContain('<feed xmlns="http://www.w3.org/2005/Atom">');
    expect(xml).toContain('</feed>');
    expect(xml.match(/<entry>/g)).toHaveLength(1);
  });

  it('escapes the ampersand in a source URL rather than emitting raw XML', () => {
    // An unescaped `&` in an href is the classic way to produce a feed that no
    // reader will parse.
    const xml = toAtom(input());
    expect(xml).toContain('href="https://news.example.com/a?x=1&amp;y=2"');
    expect(xml).not.toContain('x=1&y=2');
  });

  it('escapes markup in a title, so a hostile headline cannot break the feed', () => {
    const xml = toAtom(input({ items: [item({ title: '<script>alert(1)</script>' })] }));
    expect(xml).toContain('&lt;script&gt;');
    expect(xml).not.toContain('<script>');
  });

  it('keys entries on the item id, not the article URL', () => {
    // Two stories citing the same source must stay two entries; a reader keyed
    // on a duplicate id drops one.
    const xml = toAtom(
      input({
        items: [item({ id: 'a' }), item({ id: 'b', dedupeKey: 'k2' })],
      }),
    );
    expect(xml).toContain('urn:news:item:a');
    expect(xml).toContain('urn:news:item:b');
    expect(xml.match(/<entry>/g)).toHaveLength(2);
  });

  it('omits the alternate link when a story cites no source', () => {
    const xml = toAtom(input({ items: [item({ sources: [] })] }));
    expect(xml).not.toContain('rel="alternate" href=""');
    expect(xml).toContain('<entry>');
  });

  it('falls back to now for <updated> when the feed is empty', () => {
    expect(toAtom(input({ items: [] }))).toContain(NOW.toISOString());
  });
});

describe('the export routes (NEWS-85)', () => {
  async function seeded() {
    const store = new Store(tmpDataDir());
    const runner = new CheckRunner(store, asResolver(createMockProvider()));
    const t = store.addTopic('Fusion');
    await runner.checkTopic(t.id);
    const [first] = store.listItems();
    store.setItemSaved(first.id, true);
    return { app: createApp({ store, runner }), store, topicId: t.id };
  }

  it('serves markdown as a download', async () => {
    const { app } = await seeded();
    const res = await app.request('/api/export.md?scope=all');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/markdown');
    expect(res.headers.get('content-disposition')).toContain('attachment');
    expect(await res.text()).toContain('# All stories');
  });

  it('serves JSON as a download', async () => {
    const { app } = await seeded();
    const res = await app.request('/api/export.json?scope=all');
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(JSON.parse(await res.text())).toHaveProperty('stories');
  });

  it('serves the feed as Atom, inline rather than as an attachment', async () => {
    const { app } = await seeded();
    const res = await app.request('/feed.xml');
    expect(res.headers.get('content-type')).toContain('application/atom+xml');
    expect(res.headers.get('content-disposition')).toBeNull();
    expect(await res.text()).toContain('<feed');
  });

  it('narrows to bookmarks with scope=saved', async () => {
    const { app } = await seeded();
    const all = await (await app.request('/api/export.json?scope=all')).text();
    const saved = await (await app.request('/api/export.json?scope=saved')).text();
    const count = (json: string) => (JSON.parse(json) as { stories: unknown[] }).stories.length;
    expect(count(all)).toBe(2);
    expect(count(saved)).toBe(1);
  });

  it('narrows to one topic with scope=topic', async () => {
    const { app, store, topicId } = await seeded();
    const other = store.addTopic('Baking');
    store.addItems([
      { topicId: other.id, title: 'Sourdough', summary: 's', sources: [], dedupeKey: 'z', foundAt: '2026-07-01T00:00:00Z' },
    ]);
    const text = await (await app.request(`/api/export.md?scope=topic&topic=${topicId}`)).text();
    expect(text).toContain('Fusion');
    expect(text).not.toContain('Sourdough');
  });

  it('excludes stories the user flagged off-topic', async () => {
    // They are hidden from the feed, so exporting them would be a surprise.
    const { app, store } = await seeded();
    const [first] = store.listItems();
    store.setItemOffTopic(first.id, true);
    const parsed = JSON.parse(await (await app.request('/api/export.json?scope=all')).text()) as {
      stories: unknown[];
    };
    expect(parsed.stories).toHaveLength(1);
  });

  it('refuses a cross-origin request, like every other route', async () => {
    // A page on another origin must not be able to read the whole archive —
    // the feed's "absent Origin is fine" allowance is for RSS readers, which
    // are not browser pages (FR-4.5a).
    const { app } = await seeded();
    const res = await app.request('http://127.0.0.1:4187/feed.xml', {
      headers: { origin: 'https://evil.com' },
    });
    expect(res.status).toBe(403);
  });
});
