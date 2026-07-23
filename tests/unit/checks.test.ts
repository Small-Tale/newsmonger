import { describe, expect, it } from 'vitest';

import { createMockProvider } from '../../src/ai/providers/index.js';
import { createFakeSearchProvider } from '../../src/ai/search/index.js';
import type { SearchResult } from '../../src/ai/search/types.js';
import type { FoundNewsItem } from '../../src/ai/types.js';
import { CheckRunner, isDue } from '../../src/checks.js';
import { Store } from '../../src/db/store.js';
import { asResolver, fakeProvider } from '../helpers/provider.js';
import { tmpDataDir } from '../helpers/tmp.js';

const CANDIDATE: SearchResult = { title: 'New reactor milestone', url: 'https://a.com/reactor', snippet: 's', publishedAt: '2026-07-23' };

const HOUR = 3_600_000;

describe('isDue', () => {
  const now = new Date('2026-07-23T12:00:00Z');

  it('is due when never checked', () => {
    expect(isDue({ paused: false, lastCheckedAt: null }, HOUR, now)).toBe(true);
  });

  it('is not due while paused, even if overdue', () => {
    expect(isDue({ paused: true, lastCheckedAt: null }, HOUR, now)).toBe(false);
    expect(isDue({ paused: true, lastCheckedAt: '2026-07-23T00:00:00Z' }, HOUR, now)).toBe(false);
  });

  it('is due exactly at the interval boundary and beyond', () => {
    expect(isDue({ paused: false, lastCheckedAt: '2026-07-23T11:00:00Z' }, HOUR, now)).toBe(true);
    expect(isDue({ paused: false, lastCheckedAt: '2026-07-23T11:00:01Z' }, HOUR, now)).toBe(false);
    expect(isDue({ paused: false, lastCheckedAt: '2026-07-23T09:00:00Z' }, HOUR, now)).toBe(true);
  });
});

describe('CheckRunner', () => {
  it('adds found items and records a succeeded run', async () => {
    const store = new Store(tmpDataDir());
    const runner = new CheckRunner(store, asResolver(createMockProvider()));
    const topic = store.addTopic('Fusion');

    const added = await runner.checkTopic(topic.id);
    expect(added).toBe(2);
    expect(store.listItems(topic.id)).toHaveLength(2);
    expect(store.getTopic(topic.id)?.lastCheckedAt).not.toBeNull();
    const run = store.listRuns().at(0);
    expect(run?.status).toBe('succeeded');
    expect(run?.newItems).toBe(2);
  });

  it('deduplicates on a second check (same stories found again)', async () => {
    const store = new Store(tmpDataDir());
    const runner = new CheckRunner(store, asResolver(createMockProvider()));
    const topic = store.addTopic('Fusion');

    await runner.checkTopic(topic.id);
    const secondAdded = await runner.checkTopic(topic.id);
    expect(secondAdded).toBe(0);
    expect(store.listItems(topic.id)).toHaveLength(2);
  });

  it('passes known items and last-checked to the service', async () => {
    const store = new Store(tmpDataDir());
    const service = createMockProvider();
    const runner = new CheckRunner(store, asResolver(service));
    const topic = store.addTopic('Fusion');

    await runner.checkTopic(topic.id);
    expect(service.calls[0]?.known).toEqual([]);
    expect(service.calls[0]?.sinceIso).toBeNull();

    await runner.checkTopic(topic.id);
    expect(service.calls[1]?.known.map((k) => k.title)).toHaveLength(2);
    expect(service.calls[1]?.sinceIso).not.toBeNull();
  });

  it('records a failed run with the error, and still advances lastCheckedAt', async () => {
    const store = new Store(tmpDataDir());
    const runner = new CheckRunner(store, asResolver(createMockProvider()));
    const topic = store.addTopic('this will fail');

    const added = await runner.checkTopic(topic.id);
    expect(added).toBe(0);
    const run = store.listRuns().at(0);
    expect(run?.status).toBe('failed');
    expect(run?.error).toMatch(/mock news service failure/);
    expect(store.getTopic(topic.id)?.lastCheckedAt).not.toBeNull();
  });

  it('returns null for unknown topics', async () => {
    const store = new Store(tmpDataDir());
    const runner = new CheckRunner(store, asResolver(createMockProvider()));
    expect(await runner.checkTopic('nope')).toBeNull();
  });

  it('ignores a second concurrent check for the same topic', async () => {
    const store = new Store(tmpDataDir());
    let release: (items: FoundNewsItem[]) => void = () => undefined;
    let callCount = 0;
    const blocking = fakeProvider(() => {
      callCount += 1;
      return new Promise<FoundNewsItem[]>((resolve) => {
        release = resolve;
      });
    });
    const runner = new CheckRunner(store, asResolver(blocking));
    const topic = store.addTopic('Slow');

    const first = runner.checkTopic(topic.id);
    expect(runner.checking()).toEqual([topic.id]);
    const second = await runner.checkTopic(topic.id);
    expect(second).toBeNull();
    expect(callCount).toBe(1);

    release([]);
    expect(await first).toBe(0);
    expect(runner.checking()).toEqual([]);
  });

  it('drops results when the topic was deleted mid-check', async () => {
    const store = new Store(tmpDataDir());
    let release: (items: FoundNewsItem[]) => void = () => undefined;
    const blocking = fakeProvider(
      () =>
        new Promise<FoundNewsItem[]>((resolve) => {
          release = resolve;
        }),
    );
    const runner = new CheckRunner(store, asResolver(blocking));
    const topic = store.addTopic('Doomed');

    const pending = runner.checkTopic(topic.id);
    // Let the check progress past `await resolveProvider()` into checkTopic
    // (where `release` gets assigned) before we delete + release.
    await new Promise((r) => setTimeout(r, 0));
    store.deleteTopic(topic.id);
    release([{ title: 'late', summary: 's', sources: [] }]);
    await pending;
    expect(store.listItems()).toEqual([]);
  });

  it('checkDue only checks due, unpaused topics', async () => {
    const store = new Store(tmpDataDir());
    const service = createMockProvider();
    const runner = new CheckRunner(store, asResolver(service));
    store.updateSettings({ checkIntervalMs: HOUR });

    const fresh = store.addTopic('Fresh');
    store.markTopicChecked(fresh.id, new Date());
    const paused = store.addTopic('Paused');
    store.setTopicPaused(paused.id, true);
    store.addTopic('Due');

    await runner.checkDue(new Date());
    expect(service.calls.map((c) => c.topicName)).toEqual(['Due']);
  });

  it('checkAll checks every unpaused topic regardless of due time', async () => {
    const store = new Store(tmpDataDir());
    const service = createMockProvider();
    const runner = new CheckRunner(store, asResolver(service));

    const a = store.addTopic('A');
    store.markTopicChecked(a.id, new Date());
    const paused = store.addTopic('Paused one');
    store.setTopicPaused(paused.id, true);
    store.addTopic('B');

    await runner.checkAll();
    expect(service.calls.map((c) => c.topicName).sort()).toEqual(['A', 'B']);
  });

  it('grounds a non-searching provider on search results and marks the run grounded', async () => {
    const store = new Store(tmpDataDir());
    const provider = createMockProvider(); // searchesWeb false, has summarize()
    const search = createFakeSearchProvider([CANDIDATE]);
    const runner = new CheckRunner(store, asResolver(provider, search));
    const topic = store.addTopic('Fusion');

    const added = await runner.checkTopic(topic.id);
    expect(added).toBe(1); // one candidate → one item
    // Grounded path used summarize(), not the offline checkTopic().
    expect(provider.summarizeCalls).toHaveLength(1);
    expect(provider.calls).toHaveLength(0);
    expect(search.calls[0]).toEqual({ topic: 'Fusion', sinceIso: null, maxResults: 8 });
    const run = store.listRuns().at(0);
    expect(run?.grounded).toBe(true);
    expect(store.listItems(topic.id)[0]?.sources[0]?.url).toBe('https://a.com/reactor');
  });

  it('a web-searching provider ignores the search backend (native path, not grounded)', async () => {
    const store = new Store(tmpDataDir());
    const provider = fakeProvider(() => Promise.resolve([{ title: 'T', summary: 'S', sources: [] }]), {
      name: 'anthropic',
      searchesWeb: true,
    });
    const search = createFakeSearchProvider([CANDIDATE]);
    const runner = new CheckRunner(store, asResolver(provider, search));
    const topic = store.addTopic('AI');

    await runner.checkTopic(topic.id);
    expect(search.calls).toHaveLength(0); // native path — search backend untouched
    expect(store.listRuns().at(0)?.grounded).toBe(false);
  });

  it('falls back to the offline path when no search backend is configured', async () => {
    const store = new Store(tmpDataDir());
    const provider = createMockProvider();
    const runner = new CheckRunner(store, asResolver(provider, null));
    const topic = store.addTopic('Fusion');

    await runner.checkTopic(topic.id);
    expect(provider.calls).toHaveLength(1); // offline checkTopic()
    expect(provider.summarizeCalls).toHaveLength(0);
    expect(store.listRuns().at(0)?.grounded).toBe(false);
  });

  it('a grounded run dedups against items from a prior offline run', async () => {
    const store = new Store(tmpDataDir());
    const provider = createMockProvider();
    const topic = store.addTopic('Fusion');

    // Offline run first — two mock stories.
    const offline = new CheckRunner(store, asResolver(provider, null));
    await offline.checkTopic(topic.id);
    expect(store.listItems(topic.id)).toHaveLength(2);

    // Grounded run whose candidate URL matches one existing dedupe key → deduped.
    const existingUrl = store.listItems(topic.id)[0]?.sources[0]?.url ?? '';
    const search = createFakeSearchProvider([
      { title: 'dup', url: existingUrl, snippet: 's', publishedAt: null },
      CANDIDATE,
    ]);
    const grounded = new CheckRunner(store, asResolver(provider, search));
    const added = await grounded.checkTopic(topic.id);
    expect(added).toBe(1); // only the genuinely-new candidate survives dedup
  });

  it('records a failed run when the search backend errors', async () => {
    const store = new Store(tmpDataDir());
    const provider = createMockProvider();
    const search = createFakeSearchProvider();
    search.search = () => Promise.reject(new Error('Tavily returned 401'));
    const runner = new CheckRunner(store, asResolver(provider, search));
    const topic = store.addTopic('Fusion');

    const added = await runner.checkTopic(topic.id);
    expect(added).toBe(0);
    const run = store.listRuns().at(0);
    expect(run?.status).toBe('failed');
    expect(run?.error).toMatch(/Tavily returned 401/);
    expect(run?.grounded).toBe(true); // it took the grounded branch before failing
  });

  it('pause -> unpause sequence: checks resume after unpausing', async () => {
    const store = new Store(tmpDataDir());
    const service = createMockProvider();
    const runner = new CheckRunner(store, asResolver(service));
    store.updateSettings({ checkIntervalMs: HOUR });
    const topic = store.addTopic('Wave');

    await runner.checkDue(new Date());
    expect(service.calls).toHaveLength(1);

    store.setTopicPaused(topic.id, true);
    await runner.checkDue(new Date(Date.now() + 2 * HOUR));
    expect(service.calls).toHaveLength(1);

    store.setTopicPaused(topic.id, false);
    await runner.checkDue(new Date(Date.now() + 2 * HOUR));
    expect(service.calls).toHaveLength(2);
  });
});
