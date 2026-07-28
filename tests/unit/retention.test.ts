import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import { createMockProvider } from '../../src/ai/providers/index.js';
import { CheckRunner } from '../../src/checks.js';
import { DEFAULT_RETENTION_DAYS } from '../../src/db/schemas.js';
import { MAX_RUNS_KEPT, RUN_RETENTION_DAYS, Store } from '../../src/db/store.js';
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

  it('writes nothing when no story is due (NEWS-94)', () => {
    // Originally "does not rewrite the data file": under the JSON store a
    // needless prune re-serialized every topic, story and run. SQLite makes
    // that particular cost impossible, but the assertion is still worth having
    // in its new form — a DELETE that matches nothing should leave the database
    // byte-identical, and the retention sweep runs on every tick.
    const { store } = storeWith([1]);
    const db = `${store.dataDir}/news.db`;
    const size = fs.statSync(db).size;
    const wal = fs.existsSync(`${db}-wal`) ? fs.statSync(`${db}-wal`).size : 0;

    expect(store.pruneOldItems(NOW)).toBe(0);

    expect(fs.statSync(db).size).toBe(size);
    expect(fs.existsSync(`${db}-wal`) ? fs.statSync(`${db}-wal`).size : 0).toBe(wal);
    // And the store still holds what it held.
    expect(store.listItems()).toHaveLength(1);
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

  it('sweeps orphans left by a topic deleted mid-check (NEWS-105)', async () => {
    const { store } = storeWith([1]);
    const doomed = store.addTopic('Deleted Mid Check');
    const kept = store.addTopic('Survivor');
    const runner = new CheckRunner(store, asResolver(createMockProvider()));

    // Stories land for a topic that is already gone — the shape the sweep exists
    // for, produced through the store rather than by hand-writing orphan rows.
    store.deleteTopic(doomed.id);
    store.addItems([
      {
        topicId: doomed.id,
        title: 'Landed after the delete',
        summary: 's',
        sources: [],
        dedupeKey: 'orphan',
        foundAt: new Date().toISOString(),
      },
    ]);
    expect(store.listItems().map((i) => i.title)).toContain('Landed after the delete');

    // A check on *any* topic runs the sweep — it is housekeeping, not per-topic.
    await runner.checkTopic(kept.id);

    expect(store.listItems().map((i) => i.title)).not.toContain('Landed after the delete');
  });

  it('does not fail the check when the orphan sweep throws', async () => {
    const { store, topic } = storeWith([1]);
    const runner = new CheckRunner(store, asResolver(createMockProvider()));
    store.pruneOrphans = () => {
      throw new Error('disk on fire');
    };

    expect(await runner.checkTopic(topic.id)).toBe(2);
    expect(store.listRuns(1)[0].status).toBe('succeeded');
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

describe('Store.pruneOldRuns (NEWS-103)', () => {
  /** Insert `n` runs directly, dated back from `NOW`, oldest first. */
  function seedRuns(store: Store, n: number, dayStep = 0): void {
    const db = new DatabaseSync(`${store.dataDir}/news.db`);
    db.exec('BEGIN');
    const insert = db.prepare(
      `INSERT INTO runs (id, topic_id, started_at, finished_at, status, new_items, error, provider, model, usage)
       VALUES (?, 't1', ?, NULL, 'succeeded', 0, NULL, NULL, NULL, NULL)`,
    );
    for (let i = 0; i < n; i++) {
      const age = dayStep === 0 ? 0 : (n - i) * dayStep;
      insert.run(`seed-${String(i)}`, new Date(NOW.getTime() - age * 24 * 60 * 60 * 1000).toISOString());
    }
    db.exec('COMMIT');
    db.close();
  }

  it('drops runs older than the retention window and keeps the rest', () => {
    const store = new Store(tmpDataDir());
    store.close();
    // 10 runs, 100 days apart: the oldest four fall outside 400 days.
    seedRuns(store, 10, 100);

    const reopened = new Store(store.dataDir);
    expect(reopened.listRuns(50)).toHaveLength(10);
    expect(reopened.pruneOldRuns(NOW)).toBe(6);
    expect(reopened.listRuns(50)).toHaveLength(4);
    // The survivors are the newest ones, not an arbitrary four — and the
    // boundary is inclusive: a run at *exactly* the retention age is kept,
    // because the delete is `started_at < cutoff`. Worth pinning rather than
    // asserting loosely, since off-by-one at a retention edge is silent.
    const oldest = reopened.listRuns(50).at(-1);
    expect(new Date(oldest?.startedAt ?? 0).getTime()).toBe(
      NOW.getTime() - RUN_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );
  });

  it('keeps a full year of history, which the old 200-run cap did not', () => {
    // The point of the change: 365 daily runs used to be truncated to 200, so a
    // monthly spend total could silently cover part of a month.
    const store = new Store(tmpDataDir());
    store.close();
    seedRuns(store, 365, 1);

    const reopened = new Store(store.dataDir);
    expect(reopened.pruneOldRuns(NOW)).toBe(0);
    expect(reopened.listRuns(1000)).toHaveLength(365);
  });

  it('is a no-op when nothing is due', () => {
    const store = new Store(tmpDataDir());
    const topic = store.addTopic('Fresh');
    store.startRun(topic.id);
    expect(store.pruneOldRuns(NOW)).toBe(0);
    expect(store.listRuns(10)).toHaveLength(1);
  });

  it('enforces the count backstop, oldest first', () => {
    const store = new Store(tmpDataDir());
    store.close();
    // All same-day, so only the count limit can bind.
    seedRuns(store, MAX_RUNS_KEPT + 5);

    const reopened = new Store(store.dataDir);
    expect(reopened.pruneOldRuns(NOW)).toBe(5);
    const kept = reopened.listRuns(MAX_RUNS_KEPT + 10);
    expect(kept).toHaveLength(MAX_RUNS_KEPT);
    // The five dropped are the five inserted first.
    expect(kept.map((r) => r.id)).not.toContain('seed-0');
    expect(kept.map((r) => r.id)).not.toContain('seed-4');
    expect(kept.map((r) => r.id)).toContain('seed-5');
  });

  it('keeps a whole month of runs, which the old 200-run cap did not (NEWS-103)', () => {
    // The behaviour the ticket was about. It used to assert this through the
    // spend total; spend is gone (NEWS-119), so it asserts the retained runs
    // directly — which is what the cap actually governs.
    const store = new Store(tmpDataDir());
    const topic = store.addTopic('Busy');
    for (let i = 0; i < 300; i++) {
      const run = store.startRun(topic.id);
      store.finishRun(run.id, { status: 'succeeded', newItems: 0, model: 'claude-opus-4-8' });
    }
    store.pruneOldRuns(NOW);

    // All 300 survive — under the old 200 cap a third would already be gone.
    expect(store.listRuns(1000)).toHaveLength(300);
  });
});
