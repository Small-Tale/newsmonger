import fs from 'node:fs';

import { describe, expect, it } from 'vitest';

import { createMockProvider } from '../../src/ai/providers/index.js';
import { CheckRunner } from '../../src/checks.js';
import { DEFAULT_RETENTION_DAYS } from '../../src/db/schemas.js';
import { Store } from '../../src/db/store.js';
import { asResolver } from '../helpers/provider.js';
import { tmpDataDir } from '../helpers/tmp.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-07-27T12:00:00.000Z');

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * DAY).toISOString();
}

/** A store with one topic and stories at the given ages, in days. */
function storeWith(ages: number[], flags: { saved?: boolean; offTopic?: boolean }[] = []) {
  const store = new Store(tmpDataDir());
  const topic = store.addTopic('Fusion');
  const items = store.addItems(
    ages.map((age, i) => ({
      topicId: topic.id,
      title: `Story ${String(i)}`,
      summary: 's',
      sources: [],
      dedupeKey: `k${String(i)}`,
      foundAt: daysAgo(age),
    })),
  );
  items.forEach((item, i) => {
    if (flags[i]?.saved === true) store.setItemSaved(item.id, true);
    if (flags[i]?.offTopic === true) store.setItemOffTopic(item.id, true);
  });
  return { store, topic };
}

describe('Store.pruneOldItems (NEWS-87)', () => {
  it('drops stories past the window and keeps the rest', () => {
    const { store } = storeWith([400, 200, 1]);
    expect(store.pruneOldItems(NOW)).toBe(1);
    expect(store.listItems().map((i) => i.title)).toEqual(['Story 1', 'Story 2']);
  });

  it('never drops a bookmarked story, however old', () => {
    // The user marked it as worth keeping; retention is about the pile that
    // accumulates on its own, not about the things they chose.
    const { store } = storeWith([5000], [{ saved: true }]);
    expect(store.pruneOldItems(NOW)).toBe(0);
    expect(store.listItems()).toHaveLength(1);
  });

  it('never drops a flagged story — its title still teaches the topic', () => {
    // Off-topic titles feed the prompt's negative-example list (NEWS-61).
    // Pruning them would quietly un-teach what the user meant by the topic.
    const { store } = storeWith([5000], [{ offTopic: true }]);
    expect(store.pruneOldItems(NOW)).toBe(0);
    expect(store.offTopicTitlesForTopic(store.listTopics()[0].id)).toHaveLength(1);
  });

  it('keeps everything when the window is 0 (forever)', () => {
    const { store } = storeWith([5000, 4000]);
    store.updateSettings({ itemRetentionDays: 0 });
    expect(store.pruneOldItems(NOW)).toBe(0);
    expect(store.listItems()).toHaveLength(2);
  });

  it('honours a shortened window immediately', () => {
    const { store } = storeWith([100, 10]);
    expect(store.pruneOldItems(NOW)).toBe(0);
    store.updateSettings({ itemRetentionDays: 30 });
    expect(store.pruneOldItems(NOW)).toBe(1);
    expect(store.listItems().map((i) => i.title)).toEqual(['Story 1']);
  });

  it('keeps a story exactly at the boundary', () => {
    // `>=` on the cutoff: an item found precisely `days` ago is inside the
    // window, not outside it. Off-by-one here silently loses a day of news.
    const { store } = storeWith([DEFAULT_RETENTION_DAYS]);
    expect(store.pruneOldItems(NOW)).toBe(0);
  });

  it('persists the prune — it is not just an in-memory filter', () => {
    const { store } = storeWith([400, 1]);
    store.pruneOldItems(NOW);
    expect(new Store(store.dataDir).listItems()).toHaveLength(1);
  });

  it('does not rewrite the data file when nothing is due', () => {
    const { store } = storeWith([1]);
    const before = fs.statSync(`${store.dataDir}/data.json`).mtimeMs;
    expect(store.pruneOldItems(NOW)).toBe(0);
    expect(fs.statSync(`${store.dataDir}/data.json`).mtimeMs).toBe(before);
  });

  it('loads a pre-NEWS-87 data file and applies the default window', () => {
    const store = new Store(tmpDataDir());
    expect(store.getSettings().itemRetentionDays).toBe(DEFAULT_RETENTION_DAYS);
  });
});

describe('pruning runs as part of a check (NEWS-87)', () => {
  it('reclaims old stories on a successful check', async () => {
    const { store, topic } = storeWith([400]);
    const runner = new CheckRunner(store, asResolver(createMockProvider()));
    expect(store.listItems()).toHaveLength(1);

    await runner.checkTopic(topic.id);

    // The 400-day-old story is gone; the two the mock just found remain.
    expect(store.listItems().map((i) => i.title)).not.toContain('Story 0');
    expect(store.listItems()).toHaveLength(2);
  });

  it('does not fail the check when pruning throws', async () => {
    const { store, topic } = storeWith([400]);
    const runner = new CheckRunner(store, asResolver(createMockProvider()));
    store.pruneOldItems = () => {
      throw new Error('disk on fire');
    };

    // Housekeeping must never turn a successful check into a failed one.
    expect(await runner.checkTopic(topic.id)).toBe(2);
    expect(store.listRuns(1)[0].status).toBe('succeeded');
  });
});
