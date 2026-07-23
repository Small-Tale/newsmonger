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
      provider: 'auto',
      model: '',
      endpoint: '',
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
        sources: [{ title: 'src', url: 'https://ex.com/a' }],
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
    expect(store.getSettings()).toEqual({ checkIntervalMs: 3_600_000, provider: 'auto', model: '', endpoint: '' });
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
