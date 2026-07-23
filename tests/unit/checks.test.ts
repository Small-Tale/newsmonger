import { describe, expect, it } from 'vitest';

import { createMockProvider } from '../../src/ai/providers/index.js';
import type { FoundNewsItem } from '../../src/ai/types.js';
import { CheckRunner, isDue } from '../../src/checks.js';
import { Store } from '../../src/db/store.js';
import { asResolver, fakeProvider } from '../helpers/provider.js';
import { tmpDataDir } from '../helpers/tmp.js';


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
