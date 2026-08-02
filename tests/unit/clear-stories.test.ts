import { describe, expect, it } from 'vitest';

import { createMockProvider } from '../../src/ai/providers/mock.js';
import { CheckRunner } from '../../src/checks.js';
import { Store } from '../../src/db/store.js';
import { createApp } from '../../src/server.js';
import { asResolver } from '../helpers/provider.js';
import { tmpDataDir } from '../helpers/tmp.js';

/**
 * Clearing every story, keeping everything else (NEWS-255).
 *
 * Asked for as "clear data", narrowed by the user to *stories only*: "just
 * story content not topics or keys or settings". That narrowing is the whole
 * specification, so most of these tests are about what **survives**.
 */
function seeded() {
  const store = new Store(tmpDataDir());
  const runner = new CheckRunner(store, asResolver(createMockProvider()));
  const app = createApp({ store, runner });
  const topic = (name: string) => {
    const t = store.addTopic(name);
    store.addItems([
      {
        topicId: t.id,
        title: `${name} story`,
        summary: 'S',
        sources: [],
        dedupeKey: `${name}-1`,
        foundAt: '2026-07-01T00:00:00Z',
      },
    ]);
    return t;
  };
  return { store, runner, app, topic };
}

describe('clearAllItems (NEWS-255)', () => {
  it('removes every story across every topic', () => {
    const { store, topic } = seeded();
    topic('Fusion');
    topic('Rome');
    expect(store.clearAllItems()).toBe(2);
    expect(store.listItems()).toEqual([]);
  });

  it('keeps the topics', () => {
    // The narrowing that defines this feature. "Clear data" beside a backup
    // control reads like a factory reset; it must not be one.
    const { store, topic } = seeded();
    topic('Fusion');
    topic('Rome');
    store.clearAllItems();
    expect(store.listTopics().map((t) => t.name)).toEqual(['Fusion', 'Rome']);
  });

  it('keeps the settings', () => {
    const { store, topic } = seeded();
    topic('Fusion');
    store.updateSettings({ checkIntervalMs: 3_600_000, effort: 'high', backupDir: '/somewhere' });
    store.clearAllItems();
    const after = store.getSettings();
    expect(after.checkIntervalMs).toBe(3_600_000);
    expect(after.effort).toBe('high');
    expect(after.backupDir).toBe('/somewhere');
  });

  it('keeps the run history', () => {
    // It records what the app *did*, not what a topic is about — and the
    // failure banner and falling-behind detector both read it.
    const { store, topic } = seeded();
    const t = topic('Fusion');
    const run = store.startRun(t.id);
    store.finishRun(run.id, { status: 'succeeded', newItems: 1, model: 'mock' });
    store.clearAllItems();
    expect(store.listRuns(10)).toHaveLength(1);
  });

  it('resets the covered window, so the next check is a fresh start', () => {
    // Without this the next check resumes from where the vanished stories left
    // off and reports nothing — a clear that looks like a permanent hole
    // (FR-25.6, the same reason the per-topic clear does it).
    const { store, topic } = seeded();
    const t = topic('Fusion');
    store.markTopicCovered(t.id, new Date('2026-07-01T00:00:00Z'));
    expect(store.getTopic(t.id)?.coveredThroughAt).not.toBeNull();
    store.clearAllItems();
    expect(store.getTopic(t.id)?.coveredThroughAt).toBeNull();
  });

  it('is fine with nothing to clear', () => {
    const { store } = seeded();
    expect(store.clearAllItems()).toBe(0);
  });
});

describe('POST /api/items/clear (NEWS-255)', () => {
  it('clears and reports the count', async () => {
    const { app, topic, store } = seeded();
    topic('Fusion');
    topic('Rome');
    const res = await app.request('/api/items/clear', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cleared: 2 });
    expect(store.listItems()).toEqual([]);
  });

  it('refuses while a check is running', async () => {
    // A check computed its "already known" list before the clear. Letting it
    // finish afterwards would file only the stories missing from that stale
    // list, leaving a partial set that looks like the clear half-failed.
    const store = new Store(tmpDataDir());
    let release = (): void => undefined;
    const runner = new CheckRunner(
      store,
      asResolver({
        ...createMockProvider(),
        checkTopic: () => new Promise((resolve) => (release = () => { resolve({ items: [], usage: null }); })),
      }),
    );
    const app = createApp({ store, runner });
    const t = store.addTopic('Slow');
    const inFlight = runner.checkTopic(t.id, { manual: true });
    await new Promise((r) => setTimeout(r, 10));

    const res = await app.request('/api/items/clear', { method: 'POST' });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('check is running');

    release();
    await inFlight;
  });
});
