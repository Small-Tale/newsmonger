import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { DEFAULT_CHECK_INTERVAL_MS } from '../../src/db/schemas.js';
import { Store } from '../../src/db/store.js';
import { tmpDataDir } from '../helpers/tmp.js';

describe('Store', () => {
  it('starts empty with default settings', () => {
    const store = new Store(tmpDataDir());
    expect(store.listTopics()).toEqual([]);
    expect(store.listItems()).toEqual([]);
    expect(store.getSettings()).toEqual({
      checkIntervalMs: DEFAULT_CHECK_INTERVAL_MS,
      highPriorityIntervalMs: DEFAULT_CHECK_INTERVAL_MS,
      provider: 'auto',
      model: '',
      endpoint: '',
      effort: '',
      backupDir: '',
      notifyOnNewItems: false,
      itemRetentionDays: 365,
      scheduleMode: 'interval',
      dailyTimes: ['08:00'],
      checkConcurrency: 3,
    });
  });

  it('adds, pauses, and deletes topics', () => {
    const store = new Store(tmpDataDir());
    const topic = store.addTopic('  Fusion Energy  ');
    expect(topic.name).toBe('Fusion Energy');
    expect(topic.paused).toBe(false);
    expect(topic.lastCheckedAt).toBeNull();

    store.setTopicPaused(topic.id, true);
    expect(store.getTopic(topic.id)?.paused).toBe(true);

    store.deleteTopic(topic.id);
    expect(store.listTopics()).toEqual([]);
  });

  it('marks a topic high-priority and back (NEWS-56)', () => {
    const store = new Store(tmpDataDir());
    const topic = store.addTopic('Fusion');
    expect(topic.highPriority).toBe(false);

    expect(store.setTopicHighPriority(topic.id, true).highPriority).toBe(true);
    expect(new Store(store.dataDir).getTopic(topic.id)?.highPriority).toBe(true); // persisted

    expect(store.setTopicHighPriority(topic.id, false).highPriority).toBe(false);
    expect(() => store.setTopicHighPriority('nope', true)).toThrow(/no such topic/);
  });

  describe('high-priority interval clamping (NEWS-56)', () => {
    it('keeps high-priority <= default when the default is shortened', () => {
      const store = new Store(tmpDataDir());
      // default 1 day, high-priority 1 hour — valid.
      store.updateSettings({ highPriorityIntervalMs: 3_600_000 });
      expect(store.getSettings().highPriorityIntervalMs).toBe(3_600_000);

      // Shorten the default below the high-priority value → high-priority follows down.
      const s = store.updateSettings({ checkIntervalMs: 30 * 60_000 }); // 30 min
      expect(s.checkIntervalMs).toBe(30 * 60_000);
      expect(s.highPriorityIntervalMs).toBe(30 * 60_000);
    });

    it('raises the default when high-priority is set longer than it', () => {
      const store = new Store(tmpDataDir());
      store.updateSettings({ checkIntervalMs: 3_600_000 }); // default 1h, HP clamps to 1h
      expect(store.getSettings().highPriorityIntervalMs).toBe(3_600_000);

      // Explicitly lengthen high-priority past the default → default follows up.
      const s = store.updateSettings({ highPriorityIntervalMs: 6 * 3_600_000 }); // 6h
      expect(s.highPriorityIntervalMs).toBe(6 * 3_600_000);
      expect(s.checkIntervalMs).toBe(6 * 3_600_000);
    });

    it('treats the default as the ceiling when both are set in one patch', () => {
      const store = new Store(tmpDataDir());
      const s = store.updateSettings({ checkIntervalMs: 3_600_000, highPriorityIntervalMs: 24 * 3_600_000 });
      expect(s.checkIntervalMs).toBe(3_600_000);
      expect(s.highPriorityIntervalMs).toBe(3_600_000); // clamped down to the default
    });

    it('leaves the pair alone when a non-interval setting changes', () => {
      const store = new Store(tmpDataDir());
      store.updateSettings({ checkIntervalMs: 3_600_000 });
      const s = store.updateSettings({ notifyOnNewItems: true });
      expect(s.checkIntervalMs).toBe(3_600_000);
      expect(s.highPriorityIntervalMs).toBe(3_600_000);
    });
  });

  it('flags a story off-topic and lists flagged titles for the prompt (NEWS-61)', () => {
    const store = new Store(tmpDataDir());
    const topic = store.addTopic('Apple');
    const [a, b] = store.addItems([
      { topicId: topic.id, title: 'Apple pie recipe', summary: 's', sources: [], dedupeKey: 'k1', foundAt: '2026-07-24T01:00:00Z' },
      { topicId: topic.id, title: 'Apple orchard tour', summary: 's', sources: [], dedupeKey: 'k2', foundAt: '2026-07-24T02:00:00Z' },
    ]);
    expect(a.offTopic).toBe(false);

    expect(store.setItemOffTopic(a.id, true)?.offTopic).toBe(true);
    expect(store.setItemOffTopic(b.id, true)?.offTopic).toBe(true);
    // Most-recent first.
    expect(store.offTopicTitlesForTopic(topic.id)).toEqual(['Apple orchard tour', 'Apple pie recipe']);

    // Survives a reload and is scoped to the topic.
    expect(new Store(store.dataDir).offTopicTitlesForTopic(topic.id)).toHaveLength(2);
    expect(store.setItemOffTopic('nope', true)).toBeNull();

    // Unflagging drops it from the list.
    store.setItemOffTopic(a.id, false);
    expect(store.offTopicTitlesForTopic(topic.id)).toEqual(['Apple orchard tour']);
  });

  it('caps the off-topic titles list (NEWS-61)', () => {
    const store = new Store(tmpDataDir());
    const topic = store.addTopic('Apple');
    for (let i = 0; i < 15; i++) {
      const [item] = store.addItems([
        { topicId: topic.id, title: `fruit ${String(i)}`, summary: 's', sources: [], dedupeKey: `k${String(i)}`, foundAt: `2026-07-24T00:${String(i).padStart(2, '0')}:00Z` },
      ]);
      store.setItemOffTopic(item.id, true);
    }
    expect(store.offTopicTitlesForTopic(topic.id)).toHaveLength(10);
    expect(store.offTopicTitlesForTopic(topic.id, 3)).toHaveLength(3);
  });

  it('rejects empty and duplicate topic names (case-insensitive)', () => {
    const store = new Store(tmpDataDir());
    expect(() => store.addTopic('   ')).toThrow(/empty/);
    store.addTopic('AI Safety');
    expect(() => store.addTopic('ai safety')).toThrow(/already exists/);
  });

  it('persists across reloads', () => {
    const dir = tmpDataDir();
    const store = new Store(dir);
    const topic = store.addTopic('Space');
    store.addItems([
      {
        topicId: topic.id,
        title: 'Launch',
        summary: 'A rocket launched.',
        sources: [{ title: 'src', url: 'https://ex.com/a', outlet: null, publishedAt: null, favicon: null }],
        dedupeKey: 'url:ex.com/a',
        foundAt: new Date().toISOString(),
      },
    ]);
    store.updateSettings({ checkIntervalMs: 3_600_000 });

    const reloaded = new Store(dir);
    expect(reloaded.listTopics()).toHaveLength(1);
    expect(reloaded.listItems()).toHaveLength(1);
    expect(reloaded.getSettings().checkIntervalMs).toBe(3_600_000);
  });

  it('deleting a topic removes its items and runs', () => {
    const store = new Store(tmpDataDir());
    const a = store.addTopic('A');
    const b = store.addTopic('B');
    store.addItems([
      { topicId: a.id, title: 'x', summary: 's', sources: [], dedupeKey: 'title:x', foundAt: new Date().toISOString() },
      { topicId: b.id, title: 'y', summary: 's', sources: [], dedupeKey: 'title:y', foundAt: new Date().toISOString() },
    ]);
    store.startRun(a.id);
    store.deleteTopic(a.id);
    expect(store.listItems().map((i) => i.title)).toEqual(['y']);
    expect(store.listRuns().every((r) => r.topicId === b.id)).toBe(true);
  });

  it('tracks dedupe keys per topic', () => {
    const store = new Store(tmpDataDir());
    const a = store.addTopic('A');
    const b = store.addTopic('B');
    store.addItems([
      { topicId: a.id, title: 'x', summary: 's', sources: [], dedupeKey: 'k1', foundAt: new Date().toISOString() },
      { topicId: b.id, title: 'y', summary: 's', sources: [], dedupeKey: 'k2', foundAt: new Date().toISOString() },
    ]);
    expect(store.dedupeKeysForTopic(a.id)).toEqual(new Set(['k1']));
  });

  it('records and finishes check runs, newest first', () => {
    const store = new Store(tmpDataDir());
    const topic = store.addTopic('A');
    const r1 = store.startRun(topic.id);
    store.finishRun(r1.id, { status: 'succeeded', newItems: 2 });
    const r2 = store.startRun(topic.id);
    store.finishRun(r2.id, { status: 'failed', newItems: 0, error: 'boom' });

    const runs = store.listRuns();
    expect(runs[0]?.id).toBe(r2.id);
    expect(runs[0]?.status).toBe('failed');
    expect(runs[0]?.error).toBe('boom');
    expect(runs[1]?.status).toBe('succeeded');
    expect(runs[1]?.newItems).toBe(2);
  });

  it('recovers from a corrupt data file by backing it up', () => {
    const dir = tmpDataDir();
    fs.writeFileSync(path.join(dir, 'data.json'), '{not json');
    const store = new Store(dir);
    expect(store.listTopics()).toEqual([]);
    const backups = fs.readdirSync(dir).filter((f) => f.includes('corrupt'));
    expect(backups).toHaveLength(1);
  });

  it('persists provider settings and records the provider on a run', () => {
    const dir = tmpDataDir();
    const store = new Store(dir);
    store.updateSettings({ provider: 'openai', model: 'gpt-x', endpoint: 'https://gw/v1' });
    const run = store.startRun('t1');
    store.finishRun(run.id, { status: 'succeeded', newItems: 1, provider: 'openai' });

    const reloaded = new Store(dir);
    expect(reloaded.getSettings().provider).toBe('openai');
    expect(reloaded.getSettings().model).toBe('gpt-x');
    expect(reloaded.listRuns()[0]?.provider).toBe('openai');
  });

  it('migrates a legacy data file lacking provider settings', () => {
    const dir = tmpDataDir();
    fs.writeFileSync(
      path.join(dir, 'data.json'),
      JSON.stringify({ topics: [], items: [], settings: { checkIntervalMs: 3_600_000 }, runs: [] }),
    );
    const store = new Store(dir);
    expect(store.getSettings()).toEqual({
      checkIntervalMs: 3_600_000,
      // Clamped down to the (shorter) default interval on load, not the 1-day
      // field default — a high-priority topic is never checked less often.
      highPriorityIntervalMs: 3_600_000,
      provider: 'auto',
      model: '',
      endpoint: '',
      effort: '',
      backupDir: '',
      notifyOnNewItems: false,
      itemRetentionDays: 365,
      scheduleMode: 'interval',
      dailyTimes: ['08:00'],
      checkConcurrency: 3,
    });
  });

  it('migrates a legacy file whose provider/keys were removed, without wiping data', () => {
    const dir = tmpDataDir();
    fs.writeFileSync(
      path.join(dir, 'data.json'),
      JSON.stringify({
        topics: [{ id: 't1', name: 'Kept', paused: false, createdAt: '2026-07-01T00:00:00Z', lastCheckedAt: null }],
        items: [],
        // `ollama` + `searchProvider`/`grounded` no longer exist in the schema.
        settings: { checkIntervalMs: 3_600_000, provider: 'ollama', model: 'llama3.2', endpoint: '', searchProvider: 'tavily' },
        runs: [{ id: 'r1', topicId: 't1', startedAt: '2026-07-01T00:00:00Z', finishedAt: null, status: 'succeeded', newItems: 1, error: null, provider: 'ollama', grounded: true }],
      }),
    );
    const store = new Store(dir);
    // Data survives (no corrupt-file reset) and the dead provider degrades to auto.
    expect(store.listTopics().map((t) => t.name)).toEqual(['Kept']);
    expect(store.getSettings().provider).toBe('auto');
    expect(store.getSettings().checkIntervalMs).toBe(3_600_000);
    expect(fs.readdirSync(dir).filter((f) => f.includes('corrupt'))).toHaveLength(0);
  });

  it('markTopicChecked tolerates deleted topics', () => {
    const store = new Store(tmpDataDir());
    const topic = store.addTopic('A');
    store.deleteTopic(topic.id);
    expect(() => {
      store.markTopicChecked(topic.id, new Date());
    }).not.toThrow();
  });
});
