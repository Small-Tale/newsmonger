import { describe, expect, it } from 'vitest';

import { createMockProvider } from '../../src/ai/providers/index.js';
import { CheckRunner } from '../../src/checks.js';
import type { NewsItem, Topic } from '../../src/db/schemas.js';
import { Store } from '../../src/db/store.js';
import type { ExportInput } from '../../src/export.js';
import { escapeXml, toAtom, toJson, toMarkdown, topicsToJson } from '../../src/export.js';
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
    consecutiveFailures: 0,
    retryAfter: null,
    clearedAt: null,
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
    sources: [{ title: 'Example News', url: 'https://news.example.com/a?x=1&y=2', outlet: null, publishedAt: null, favicon: null }],
    image: null,
    dedupeKey: 'k1',
    threadId: 'i1',
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

describe('topicsToJson — the shareable topic list (FR-30.2, NEWS-317)', () => {
  const shared = [
    topic({
      id: 't1',
      name: 'Fusion Energy',
      guidance: 'Regulatory and safety news only, not stock moves.',
      category: 'science',
      subcategory: 'energy',
      // Everything below describes *this install*, and none of it may travel.
      paused: true,
      highPriority: true,
      categorySource: 'manual',
      createdAt: '2026-07-01T00:00:00Z',
      lastCheckedAt: '2026-07-26T09:00:00Z',
      coveredThroughAt: '2026-07-26T09:00:00Z',
      consecutiveFailures: 3,
      retryAfter: '2026-07-27T09:00:00Z',
      clearedAt: '2026-07-20T00:00:00Z',
    }),
    topic({ id: 't2', name: 'Antarctic ice', guidance: '', category: null, subcategory: null }),
  ];

  it('carries what a topic is', () => {
    const parsed = JSON.parse(topicsToJson(shared, NOW)) as {
      exportedAt: string;
      topics: { name: string; guidance: string; category: string | null; subcategory: string | null }[];
    };
    expect(parsed.exportedAt).toBe(NOW.toISOString());
    expect(parsed.topics).toEqual([
      {
        name: 'Fusion Energy',
        guidance: 'Regulatory and safety news only, not stock moves.',
        category: 'science',
        subcategory: 'energy',
      },
      { name: 'Antarctic ice', guidance: '', category: null, subcategory: null },
    ]);
  });

  it('carries nothing about how this install runs it', () => {
    // **The exclusions are the requirement** (FR-30.1/30.3/30.4), so they are
    // asserted directly rather than inferred from the happy path above. A
    // `toEqual` alone would catch a *changed* field; this catches a field that
    // starts riding along, which is how a "list to share" quietly becomes a
    // snapshot of one machine — and how `paused: true` above would arrive at
    // someone else's install looking like a broken import.
    //
    // Asserted on the serialized text, not the parsed object: a key nested
    // somewhere unexpected would still be a leak.
    const json = topicsToJson(shared, NOW);
    for (const forbidden of [
      'id',
      'paused',
      'highPriority',
      'categorySource',
      'createdAt',
      'lastCheckedAt',
      'coveredThroughAt',
      'consecutiveFailures',
      'retryAfter',
      'clearedAt',
    ]) {
      expect(json, `"${forbidden}" must not travel in a shared topic list`).not.toContain(`"${forbidden}"`);
    }
    // And no story or credential ever reaches this file.
    expect(json).not.toContain('sk-');
    expect(json).not.toContain('stories');
  });

  /** A store with one real topic in it, and the app in front of it. */
  function served() {
    const store = new Store(tmpDataDir());
    const app = createApp({ store, runner: new CheckRunner(store, asResolver(createMockProvider())) });
    return { app, store };
  }

  it('is served as a download, from the topics the store actually holds', async () => {
    const { app, store } = served();
    store.addTopic('Semiconductor supply chain', { guidance: 'Packaging and export controls.' });

    const res = await app.request('/api/export-topics.json');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    // A file, not a page of JSON — the point of the control is to hand you
    // something you can send to someone.
    expect(res.headers.get('content-disposition')).toContain('attachment');
    expect(res.headers.get('content-disposition')).toContain('newsmonger-topics.json');

    const parsed = JSON.parse(await res.text()) as { topics: { name: string; guidance: string }[] };
    expect(parsed.topics.map((t) => t.name)).toContain('Semiconductor supply chain');
    expect(parsed.topics.find((t) => t.name === 'Semiconductor supply chain')?.guidance).toBe(
      'Packaging and export controls.',
    );
  });

  it('answers an install with no topics with an empty list, not an error', async () => {
    // The state a first-run user is in, and the one a "share your topics"
    // control is most likely to be poked at from.
    const { app } = served();
    const parsed = JSON.parse(await (await app.request('/api/export-topics.json')).text()) as { topics: unknown[] };
    expect(parsed.topics).toEqual([]);
  });
});

describe('importing a topic list (FR-30.5–30.9, NEWS-318)', () => {
  function served() {
    const store = new Store(tmpDataDir());
    const app = createApp({ store, runner: new CheckRunner(store, asResolver(createMockProvider())) });
    return { app, store };
  }

  const post = (app: ReturnType<typeof served>['app'], body: unknown) =>
    app.request('/api/import-topics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  const LIST = {
    topics: [
      { name: 'Fusion energy', guidance: 'Safety and regulation only.', category: 'science', subcategory: 'energy' },
      { name: 'Antarctic ice' },
    ],
  };

  it('adds the list, carrying guidance and classification', async () => {
    const { app, store } = served();
    const resp = (await (await post(app, LIST)).json()) as { added: string[]; skipped: string[] };
    expect(resp).toEqual({ added: ['Fusion energy', 'Antarctic ice'], skipped: [] });

    const fusion = store.listTopics().find((t) => t.name === 'Fusion energy');
    expect(fusion?.guidance).toBe('Safety and regulation only.');
    expect(fusion?.category).toBe('science');
    expect(fusion?.subcategory).toBe('energy');
  });

  it('is idempotent — the second import changes nothing', async () => {
    // FR-30.5, and the requirement most easily broken by a later change: a
    // "merge the guidance" or "update the category" refinement would pass every
    // other test here and fail this one.
    const { app, store } = served();
    await post(app, LIST);
    const before = store.listTopics().map((t) => ({ name: t.name, guidance: t.guidance, id: t.id }));

    const second = (await (await post(app, LIST)).json()) as { added: string[]; skipped: string[] };
    expect(second.added).toEqual([]);
    expect(second.skipped).toEqual(['Fusion energy', 'Antarctic ice']);
    // Same topics, same ids — not deleted and recreated, and not rewritten.
    expect(store.listTopics().map((t) => ({ name: t.name, guidance: t.guidance, id: t.id }))).toEqual(before);
  });

  it('skips a duplicate by the *same* rule the add-topic form uses', async () => {
    // Asserted through **both doors** rather than by restating the query
    // (FR-30.6). If the two ever disagreed, an import would create a second
    // "Fusion Energy" beside the "fusion energy" you already follow — a bug
    // nobody would think to look for in a SQL string.
    const { app, store } = served();
    store.addTopic('  fusion ENERGY  ');

    // The form's own verdict on this name.
    expect(() => store.addTopic('Fusion energy')).toThrow(/already exists/);

    // …and the import's, which must match it.
    const resp = (await (await post(app, { topics: [{ name: 'Fusion energy' }] })).json()) as {
      added: string[];
      skipped: string[];
    };
    expect(resp.skipped).toEqual(['Fusion energy']);
    expect(store.listTopics()).toHaveLength(1);
  });

  it('never merges into a topic you already have', async () => {
    // The one alternative the design refuses outright: adopting an incoming
    // `guidance` would overwrite something the user wrote, in bulk, with no diff
    // and no undo.
    const { app, store } = served();
    store.addTopic('Fusion energy', { guidance: 'My own words, which I spent time on.' });
    await post(app, LIST);
    expect(store.listTopics().find((t) => t.name === 'Fusion energy')?.guidance).toBe(
      'My own words, which I spent time on.',
    );
  });

  it('collapses duplicates inside one file', async () => {
    // A hand-editable file is a file someone will paste into twice.
    const { app, store } = served();
    const resp = (await (
      await post(app, { topics: [{ name: 'Fusion energy' }, { name: 'FUSION ENERGY' }] })
    ).json()) as { added: string[]; skipped: string[] };
    expect(resp.added).toEqual(['Fusion energy']);
    expect(resp.skipped).toEqual(['FUSION ENERGY']);
    expect(store.listTopics()).toHaveLength(1);
  });

  it('imports topics due, without checking them', async () => {
    // FR-30.8. Adding one topic by hand fires a check (FR-1.12); doing that for
    // twenty at once spends an hour of provider quota in a burst nobody asked
    // for. `lastCheckedAt: null` is what makes a topic due, so the scheduler
    // picks these up on its own cadence.
    const { app, store } = served();
    await post(app, LIST);
    for (const topic of store.listTopics()) {
      expect(topic.lastCheckedAt, `${topic.name} must not have been checked on import`).toBeNull();
    }
    // And no stories arrived, which is the observable form of the same claim.
    expect(store.listItems()).toHaveLength(0);
  });

  it('refuses an unreadable file whole, changing nothing', async () => {
    // FR-30.9, asserted **against the store afterwards** rather than against the
    // error message: what matters is that a rejected file leaves no trace, not
    // how the rejection was worded.
    const { app, store } = served();
    store.addTopic('Existing topic');

    for (const bad of ['not json at all', JSON.stringify({ nope: [] }), JSON.stringify({ topics: [{ name: 7 }] })]) {
      const res = await post(app, bad);
      expect(res.status, `"${bad.slice(0, 24)}" should be refused`).toBe(400);
      expect(store.listTopics().map((t) => t.name)).toEqual(['Existing topic']);
    }
  });

  it('says where an unreadable file went wrong', async () => {
    // This is a file the user chose, quite possibly hand-edited — so unlike
    // every other bad body in the API, it is an ordinary thing a person does and
    // the message has to be usable.
    const res = await post(served().app, { topics: [{ name: 7 }] });
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('topics.0.name');
  });

  it('reads its own export, round trip', async () => {
    // The two halves are one format or they are nothing (FR-30.10's argument,
    // applied here): this asserts the file NEWS-317 writes is the file NEWS-318
    // accepts, rather than two schemas that happen to look alike.
    const source = served();
    source.store.addTopic('Fusion energy', { guidance: 'Safety only.', category: 'science' });
    source.store.addTopic('Antarctic ice');
    const file = await (await source.app.request('/api/export-topics.json')).text();

    const target = served();
    const resp = (await (await post(target.app, file)).json()) as { added: string[] };
    expect(resp.added).toEqual(['Fusion energy', 'Antarctic ice']);
    expect(target.store.listTopics().find((t) => t.name === 'Fusion energy')?.guidance).toBe('Safety only.');
  });

  it('accepts the smallest file a person could type', async () => {
    // Being hand-editable is the point of the format, so the minimum has to work.
    const { app, store } = served();
    const res = await post(app, '{"topics":[{"name":"Fusion energy"}]}');
    expect(res.status).toBe(200);
    expect(store.listTopics()).toHaveLength(1);
  });

  it('ignores fields it does not know rather than refusing the file', async () => {
    // Lenient about what it ignores, strict about what it accepts: a future
    // field, or the `exportedAt` it does not need, must not make a usable list
    // unreadable.
    const { app, store } = served();
    const res = await post(app, {
      exportedAt: '2026-07-27T12:00:00.000Z',
      somethingFromNextYear: true,
      topics: [{ name: 'Fusion energy', unknownField: 'ignored' }],
    });
    expect(res.status).toBe(200);
    expect(store.listTopics().map((t) => t.name)).toEqual(['Fusion energy']);
  });
});
