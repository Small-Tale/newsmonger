import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockProvider } from '../../src/ai/providers/index.js';
import type { FoundNewsItem } from '../../src/ai/types.js';
import { ItemsRespSchema, ThreadRespSchema } from '../../src/api/schemas.js';
import { CheckRunner } from '../../src/checks.js';
import { loadThread } from '../../src/client/api.js';
import { dayKeyOf, dayLabel } from '../../src/client/dates.js';
import type { ThreadPane } from '../../src/client/stores.js';
import { appStore } from '../../src/client/stores.js';
import { showAllLabel, THREAD_ROW_CAP, threadFetchNeeded, threadRowDate, visibleThreadRows } from '../../src/client/thread-view.js';
import { Store } from '../../src/db/store.js';
import { createApp } from '../../src/server.js';
import { planThreadIds } from '../../src/threads.js';
import { asResolver } from '../helpers/provider.js';
import { tmpDataDir } from '../helpers/tmp.js';

// The thread timeline in the expanded story pane (NEWS-282): the store read that
// shapes it, the route that serves it, the client cache in front of that route,
// and the pure rules the pane draws by.

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-07-01T00:00:00.000Z');

function at(offsetDays: number): string {
  return new Date(T0 + offsetDays * DAY).toISOString();
}

/**
 * A store holding one four-story thread plus an unrelated standalone story, all
 * in one topic — the two cases a pane has to tell apart.
 */
function seeded() {
  const store = new Store(tmpDataDir());
  const topic = store.addTopic('Riverside');
  const add = (title: string, day: number, threadOf?: string) =>
    store.addItems([
      {
        topicId: topic.id,
        title,
        summary: `${title}.`,
        sources: [
          {
            title: 'Example News',
            url: `https://news.example.com/${String(day)}`,
            outlet: 'Example News',
            publishedAt: null,
            favicon: null,
          },
        ],
        dedupeKey: `k-${String(day)}`,
        foundAt: at(day),
        ...(threadOf === undefined ? {} : { threadId: threadOf }),
      },
    ])[0].id;
  // Thread ids are assigned by the runner, not the store, so they are set here
  // explicitly — this test is about reading a thread, not about forming one.
  const first = add('Dam collapse floods three towns', 0);
  const second = add('Rescue teams reach the flood zone', 1, first);
  const third = add('Inquiry opens into collapse warnings', 2, first);
  const fourth = add('Engineers detail the collapse sequence', 3, first);
  const lone = add('Unrelated ferry timetable changes', 4);
  return { store, topic, ids: { first, second, third, fourth, lone } };
}

function makeApp(store: Store) {
  const runner = new CheckRunner(store, asResolver(createMockProvider()));
  return createApp({ store, runner });
}

/** The story ids a ready pane holds, or none — narrowing the union in one place. */
function paneIds(pane: ThreadPane | undefined): string[] {
  return pane !== undefined && pane.status === 'ready' ? pane.items.map((item) => item.id) : [];
}

describe('Store.threadSummaries (NEWS-282)', () => {
  it('gives position, size and first-seen for a story in a multi-story thread', () => {
    const { store, ids } = seeded();
    const page = store.queryItems({ mode: 'normal', limit: 100 });
    const summaries = store.threadSummaries(page.items);
    expect(summaries[ids.first]).toEqual({ position: 1, size: 4, startedAt: at(0) });
    expect(summaries[ids.fourth]).toEqual({ position: 4, size: 4, startedAt: at(0) });
  });

  it('says nothing at all about a thread of one', () => {
    // The ordinary case (FR-29.6), and the reason the map does not grow the feed
    // payload: no entry, so no badge and nothing to fetch.
    const { store, ids } = seeded();
    const page = store.queryItems({ mode: 'normal', limit: 100 });
    expect(store.threadSummaries(page.items)[ids.lone]).toBeUndefined();
  });

  it('leaves a flagged story out of the count, so a badge cannot disagree with the timeline', () => {
    const { store, topic, ids } = seeded();
    store.setItemOffTopic(ids.second, true);
    const page = store.queryItems({ mode: 'normal', limit: 100 });
    const summaries = store.threadSummaries(page.items);
    // Three left, and the positions close up rather than leaving a hole at 2.
    expect(summaries[ids.first]).toEqual({ position: 1, size: 3, startedAt: at(0) });
    expect(summaries[ids.third].position).toBe(2);
    expect(summaries[ids.fourth].position).toBe(3);
    // The flagged story itself gets no entry — review-mode cards do not expand,
    // so a badge there would point at a pane that never opens.
    const review = store.queryItems({ mode: 'review', topicIds: [topic.id], limit: 100 });
    expect(store.threadSummaries(review.items)[ids.second]).toBeUndefined();
  });

  it('drops to a thread of one when everything else in the thread is flagged', () => {
    const { store, ids } = seeded();
    for (const id of [ids.second, ids.third, ids.fourth]) store.setItemOffTopic(id, true);
    const page = store.queryItems({ mode: 'normal', limit: 100 });
    expect(store.threadSummaries(page.items)[ids.first]).toBeUndefined();
  });

  it('is empty for an empty page, without asking the database anything', () => {
    const { store } = seeded();
    expect(store.threadSummaries([])).toEqual({});
  });

  it('handles a page spanning two topics without mixing their threads', () => {
    const { store, ids } = seeded();
    const other = store.addTopic('Ferries');
    const extra = store.addItems([
      {
        topicId: other.id,
        title: 'Dam collapse floods three towns',
        summary: 'Same headline, different topic.',
        sources: [
          {
            title: 'Example News',
            url: 'https://news.example.com/other',
            outlet: 'Example News',
            publishedAt: null,
            favicon: null,
          },
        ],
        dedupeKey: 'k-other',
        foundAt: at(5),
      },
    ])[0];
    const page = store.queryItems({ mode: 'normal', limit: 100 });
    const summaries = store.threadSummaries(page.items);
    expect(summaries[extra.id]).toBeUndefined();
    expect(summaries[ids.first].size).toBe(4);
  });
});

describe('GET /api/items/:id/thread (NEWS-282)', () => {
  it('returns the whole thread oldest first', async () => {
    const { store, ids } = seeded();
    const app = makeApp(store);
    const res = await app.request(`/api/items/${ids.third}/thread`);
    expect(res.status).toBe(200);
    const body = ThreadRespSchema.parse(await res.json());
    expect(body.items.map((i) => i.id)).toEqual([ids.first, ids.second, ids.third, ids.fourth]);
    // Whole stories, because the row needs a title, a date and an outlet link.
    expect(body.items[0].sources[0].url).toBe('https://news.example.com/0');
  });

  it('answers a thread of one with just that story', async () => {
    const { store, ids } = seeded();
    const app = makeApp(store);
    const body = ThreadRespSchema.parse(await (await app.request(`/api/items/${ids.lone}/thread`)).json());
    expect(body.items.map((i) => i.id)).toEqual([ids.lone]);
  });

  it('excludes a flagged story from the timeline, but still answers about one', async () => {
    const { store, ids } = seeded();
    const app = makeApp(store);
    store.setItemOffTopic(ids.second, true);
    const thread = ThreadRespSchema.parse(await (await app.request(`/api/items/${ids.first}/thread`)).json());
    expect(thread.items.map((i) => i.id)).toEqual([ids.first, ids.third, ids.fourth]);
    // Asking about the flagged story itself still answers with it — replying
    // "nothing" about a story someone is looking at would be the worse lie.
    const flagged = ThreadRespSchema.parse(await (await app.request(`/api/items/${ids.second}/thread`)).json());
    expect(flagged.items.map((i) => i.id)).toContain(ids.second);
  });

  it('404s on an unknown story id rather than inventing an empty thread', async () => {
    const { store } = seeded();
    const app = makeApp(store);
    const res = await app.request('/api/items/nope/thread');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'unknown story' });
  });

  it('carries thread summaries on the feed page, and only for real threads', async () => {
    const { store, ids } = seeded();
    const app = makeApp(store);
    const page = ItemsRespSchema.parse(await (await app.request('/api/items?limit=100')).json());
    expect(page.threads[ids.fourth]).toEqual({ position: 4, size: 4, startedAt: at(0) });
    expect(page.threads[ids.lone]).toBeUndefined();
    // The badge's data is on the page the card came from — no request per card.
    expect(Object.keys(page.threads)).toHaveLength(4);
  });

  it('sends an empty summary map when nothing is threaded', async () => {
    const store = new Store(tmpDataDir());
    const topic = store.addTopic('Ferries');
    store.addItems([
      {
        topicId: topic.id,
        title: 'A lone story',
        summary: 'On its own.',
        sources: [],
        dedupeKey: 'k1',
        foundAt: at(0),
      },
    ]);
    const app = makeApp(store);
    const page = ItemsRespSchema.parse(await (await app.request('/api/items?limit=100')).json());
    expect(page.threads).toEqual({});
  });
});

describe('the pane\'s reading rules (NEWS-282)', () => {
  it('caps the visible rows and reports how many are held back', () => {
    const rows = [1, 2, 3, 4, 5, 6, 7];
    const capped = visibleThreadRows(rows, false);
    expect(capped.rows).toHaveLength(THREAD_ROW_CAP);
    expect(capped.hidden).toBe(rows.length - THREAD_ROW_CAP);
    // The **most recent** rows survive: the pane is read beside the story you
    // clicked, so its neighbours are what explain it.
    expect(capped.rows).toEqual([4, 5, 6, 7]);
  });

  it('shows everything once the cap is lifted, and never caps a short thread', () => {
    const rows = [1, 2, 3, 4, 5, 6, 7];
    expect(visibleThreadRows(rows, true)).toEqual({ rows, hidden: 0 });
    expect(visibleThreadRows([1, 2], false)).toEqual({ rows: [1, 2], hidden: 0 });
    expect(visibleThreadRows([1, 2, 3, 4], false).hidden).toBe(0);
  });

  it('counts the whole thread in the show-all label, not the hidden part', () => {
    // "Show all 7 stories" answers "how much history is there", which is the
    // question a capped list raises. "Show 3 more" would answer a different one.
    expect(showAllLabel(7)).toBe('Show all 7 stories');
  });

  it('dates a row exactly as the feed heads that day', () => {
    // One absolute date format in the app, which is why `dayLabel` moved out of
    // `app.tsx` rather than being reimplemented here.
    const now = new Date();
    expect(threadRowDate(now.toISOString())).toBe('Today');
    expect(threadRowDate(new Date(now.getTime() - DAY).toISOString())).toBe('Yesterday');
    const old = new Date(T0);
    expect(threadRowDate(old.toISOString())).toBe(dayLabel(dayKeyOf(old)));
    expect(threadRowDate('not a date')).toBe('');
  });

  it('only fetches when the feed says there is a thread', () => {
    expect(threadFetchNeeded(undefined)).toBe(false);
    expect(threadFetchNeeded({ position: 1, size: 1, startedAt: at(0) })).toBe(false);
    expect(threadFetchNeeded({ position: 2, size: 2, startedAt: at(0) })).toBe(true);
  });
});

describe('the mock provider can build a thread past the row cap (NEWS-282)', () => {
  it('extends one thread by two stories per check', async () => {
    // The E2E's precondition, asserted here because it is a property of the mock
    // rather than of the app: without it, no browser flow could reach "show all".
    const provider = createMockProvider();
    // The topic's own words are stopwords inside it (FR-29.10), so a topic named
    // "Riverside…" would subtract the very word the series threads on. Worth
    // stating: it is the trap a future test — or a future E2E topic name — walks
    // into, and it looks like the mock being broken rather than like the feature
    // working exactly as documented.
    const topicName = 'Flood Thread Probe';
    const stored: { id: string; title: string; foundAt: string; sources: { url: string }[] }[] = [];
    const seenUrls = new Set<string>();
    const url = (item: FoundNewsItem): string => item.sources[0].url;
    for (let round = 0; round < 3; round++) {
      const result = await provider.checkTopic(
        topicName,
        stored.map((s) => ({ title: s.title, foundAt: s.foundAt })),
        null,
        {},
      );
      for (const item of result.items) {
        if (seenUrls.has(url(item))) continue; // dedup, as the runner would
        seenUrls.add(url(item));
        stored.push({
          id: `s${String(stored.length + 1)}`,
          title: item.title,
          foundAt: at(stored.length),
          sources: item.sources,
        });
      }
      expect(stored).toHaveLength(Math.min(6, (round + 1) * 2));
    }
    // Six stories, one thread — and more rows than the cap, which is the point.
    expect(new Set(planThreadIds(stored, { topicName })).size).toBe(1);
    expect(stored.length).toBeGreaterThan(THREAD_ROW_CAP);
  });
});

describe('the client fetches a thread on expand and caches it (NEWS-282)', () => {
  const summary = { position: 2, size: 2, startedAt: at(0) };

  function threadBody(ids: string[]): unknown {
    return {
      items: ids.map((id) => ({
        id,
        topicId: 't1',
        title: `Story ${id}`,
        summary: 's',
        saved: false,
        offTopic: false,
        sources: [],
        image: null,
        dedupeKey: `k-${id}`,
        threadId: 'a',
        foundAt: at(0),
      })),
    };
  }

  function stubFetch(respond: (url: string) => { ok: boolean; body: unknown }) {
    const calls: string[] = [];
    const impl = ((input: string): Promise<Response> => {
      calls.push(input);
      const { ok, body } = respond(input);
      return Promise.resolve({
        ok,
        status: ok ? 200 : 500,
        json: () => Promise.resolve(body),
      } as unknown as Response);
    }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', impl);
    return calls;
  }

  beforeEach(() => {
    appStore.actions.update({ threads: { a: summary }, threadPanes: {}, threadShowAll: false, expandedItemId: null });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not ask at all for a thread of one', async () => {
    const calls = stubFetch(() => ({ ok: true, body: threadBody(['a']) }));
    await loadThread('lonely'); // no summary on the page → a thread of one
    expect(calls).toEqual([]);
    expect(appStore.state.value.threadPanes['lonely']).toBeUndefined();
  });

  it('fetches once and reuses the answer across collapse and re-expand', async () => {
    const calls = stubFetch(() => ({ ok: true, body: threadBody(['a', 'b']) }));
    await loadThread('a');
    const pane = appStore.state.value.threadPanes['a'];
    // `size` is the count it was cached at, which is what the growth check below
    // compares the fresh badge against.
    expect(pane).toMatchObject({ status: 'ready', size: 2 });
    expect(paneIds(pane)).toEqual(['a', 'b']);
    await loadThread('a');
    await loadThread('a');
    expect(calls).toHaveLength(1);
  });

  it('refetches when the thread has grown since it was cached', async () => {
    // The badge comes from the 4-second poll, so a thread that gained a story
    // announces itself — a cache keyed on the id alone would serve the old one
    // forever.
    const calls = stubFetch(() => ({ ok: true, body: threadBody(['a', 'b']) }));
    await loadThread('a');
    appStore.actions.update({ threads: { a: { ...summary, size: 3 } } });
    await loadThread('a');
    expect(calls).toHaveLength(2);
  });

  it('puts a failure in the pane, keeps it out of the page banner, and retries', async () => {
    let fail = true;
    const calls = stubFetch(() =>
      fail ? { ok: false, body: { error: 'database is locked' } } : { ok: true, body: threadBody(['a', 'b']) },
    );
    appStore.actions.setError(null);
    await loadThread('a');
    expect(appStore.state.value.threadPanes['a']).toEqual({ status: 'error', message: 'database is locked' });
    expect(appStore.state.value.error).toBeNull();

    // An error is never cached: asking again — the retry button, or re-opening
    // the card — actually asks again.
    fail = false;
    await loadThread('a');
    expect(calls).toHaveLength(2);
    expect(appStore.state.value.threadPanes['a']).toMatchObject({ status: 'ready' });
  });

  it('does not issue a second request while the first is in flight', async () => {
    const calls = stubFetch(() => ({ ok: true, body: threadBody(['a', 'b']) }));
    const first = loadThread('a');
    const second = loadThread('a'); // a double-click arrives as two clicks
    await Promise.all([first, second]);
    expect(calls).toHaveLength(1);
  });

  it('survives an interleaved sequence of expands across two stories', async () => {
    // The transition that a per-operation test cannot see: two cards' panes
    // living in the same map, opened out of order, one of them growing.
    const calls = stubFetch((url) => ({ ok: true, body: threadBody(url.includes('/a/') ? ['a', 'b'] : ['c', 'd']) }));
    appStore.actions.update({ threads: { a: summary, c: { position: 1, size: 2, startedAt: at(1) } } });
    await loadThread('a');
    await loadThread('c');
    await loadThread('a'); // cached
    expect(calls).toHaveLength(2);
    expect(appStore.state.value.threadPanes['a']).toMatchObject({ status: 'ready' });
    expect(appStore.state.value.threadPanes['c']).toMatchObject({ status: 'ready' });

    // Lifting the cap belongs to whichever pane is open, so opening another card
    // puts it back — asserted here because the flag and the cache are the two
    // pieces of pane state and only one of them is per story.
    appStore.actions.showAllThread();
    expect(appStore.state.value.threadShowAll).toBe(true);
    appStore.actions.toggleItemExpanded('c');
    expect(appStore.state.value.threadShowAll).toBe(false);
  });
});
