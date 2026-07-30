import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_RETENTION_DAYS } from '../../src/db/schemas.js';
import { dbPath, SCHEMA_VERSION } from '../../src/db/sqlite.js';
import { Store } from '../../src/db/store.js';
import { tmpDataDir } from '../helpers/tmp.js';

// Behaviour the SQLite engine introduces (NEWS-94). The rest of the store's
// contract is covered by the 500+ tests that were already driving it through
// this same interface — they are the regression net for the swap, and they went
// unchanged. What's here is what *only* exists now: the legacy JSON import, a
// corrupt database, and the guarantees the storage engine itself is supposed to
// provide.

/** A legacy `data.json`, as the pre-NEWS-94 store would have written one. */
function legacyFile(dir: string, overrides: Record<string, unknown> = {}): void {
  fs.writeFileSync(
    path.join(dir, 'data.json'),
    JSON.stringify({
      topics: [
        {
          id: 't1',
          name: 'Tennis',
          paused: true,
          highPriority: true,
          guidance: 'majors only',
          createdAt: '2026-07-01T00:00:00.000Z',
          lastCheckedAt: '2026-07-02T00:00:00.000Z',
          coveredThroughAt: '2026-07-02T00:00:00.000Z',
        },
      ],
      items: [
        {
          id: 'i1',
          topicId: 't1',
          title: 'Final set',
          summary: 'It went long.',
          saved: true,
          offTopic: false,
          sources: [{ title: 'Wire', url: 'https://example.test/a' }],
          image: { hash: 'abc', sourceUrl: 'https://example.test/img.jpg' },
          dedupeKey: 'k1',
          foundAt: '2026-07-02T00:00:00.000Z',
        },
      ],
      settings: { checkIntervalMs: 3_600_000, notifyOnNewItems: true },
      runs: [
        {
          id: 'r1',
          topicId: 't1',
          startedAt: '2026-07-02T00:00:00.000Z',
          finishedAt: '2026-07-02T00:01:00.000Z',
          status: 'succeeded',
          newItems: 1,
          error: null,
        },
      ],
      ...overrides,
    }),
  );
}

describe('legacy data.json import (NEWS-94)', () => {
  it('imports topics, items, runs and settings on first open', () => {
    const dir = tmpDataDir();
    legacyFile(dir);
    const store = new Store(dir);

    const topic = store.listTopics()[0];
    expect(topic.name).toBe('Tennis');
    // Every field, not just the name: booleans cross a type boundary (SQLite
    // has no boolean) and nullable timestamps cross another.
    expect(topic.paused).toBe(true);
    expect(topic.highPriority).toBe(true);
    expect(topic.guidance).toBe('majors only');
    expect(topic.lastCheckedAt).toBe('2026-07-02T00:00:00.000Z');
    expect(topic.coveredThroughAt).toBe('2026-07-02T00:00:00.000Z');

    const item = store.listItems()[0];
    expect(item.title).toBe('Final set');
    expect(item.saved).toBe(true);
    expect(item.offTopic).toBe(false);
    expect(item.sources[0]?.url).toBe('https://example.test/a');
    expect(item.image).toEqual({ hash: 'abc', sourceUrl: 'https://example.test/img.jpg' });

    expect(store.listRuns()[0]?.newItems).toBe(1);
    expect(store.getSettings().checkIntervalMs).toBe(3_600_000);
    expect(store.getSettings().notifyOnNewItems).toBe(true);
    // Absent fields still get their schema defaults through the import.
    expect(store.getSettings().itemRetentionDays).toBe(DEFAULT_RETENTION_DAYS);
  });

  it('renames the file so a second open cannot import it again', () => {
    const dir = tmpDataDir();
    legacyFile(dir);
    new Store(dir);

    expect(fs.existsSync(path.join(dir, 'data.json'))).toBe(false);
    expect(fs.readdirSync(dir).filter((f) => f.startsWith('data.json.imported-'))).toHaveLength(1);

    const reopened = new Store(dir);
    expect(reopened.listTopics()).toHaveLength(1);
    expect(reopened.listItems()).toHaveLength(1);
  });

  it('does not import over a populated database', () => {
    // The dangerous ordering: a database that already has data, and a stray
    // `data.json` beside it. Importing would duplicate or clobber.
    const dir = tmpDataDir();
    const store = new Store(dir);
    store.addTopic('Existing');
    legacyFile(dir);

    const reopened = new Store(dir);
    expect(reopened.listTopics().map((t) => t.name)).toEqual(['Existing']);
    // ...and the file is left alone, not renamed, so nothing is quietly lost.
    expect(fs.existsSync(path.join(dir, 'data.json'))).toBe(true);
  });

  it('does not import over a database whose only content is settings', () => {
    // A store that was opened and configured but never given a topic still has
    // deliberate state. "No topics" is not the same as "empty".
    const dir = tmpDataDir();
    const store = new Store(dir);
    store.updateSettings({ notifyOnNewItems: true });
    legacyFile(dir);

    const reopened = new Store(dir);
    expect(reopened.getSettings().notifyOnNewItems).toBe(true);
    expect(reopened.listTopics()).toEqual([]);
  });

  it('backs up an unparseable data.json and starts fresh', () => {
    const dir = tmpDataDir();
    fs.writeFileSync(path.join(dir, 'data.json'), '{not json');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const store = new Store(dir);
    expect(store.listTopics()).toEqual([]);
    expect(fs.readdirSync(dir).filter((f) => f.includes('data.json.corrupt-'))).toHaveLength(1);
    // Removed under its original name, so the next start doesn't retry it.
    expect(fs.existsSync(path.join(dir, 'data.json'))).toBe(false);
  });

  it('carries a run whose topic is already gone', () => {
    // The JSON file had no referential integrity, so this shape is possible in
    // a real file. It's also why the tables have no foreign keys: a check can
    // outlive its topic, and the import must not be the thing that discovers it.
    const dir = tmpDataDir();
    legacyFile(dir, {
      runs: [
        {
          id: 'orphan',
          topicId: 'deleted-topic',
          startedAt: '2026-07-02T00:00:00.000Z',
          finishedAt: null,
          status: 'failed',
          newItems: 0,
          error: 'topic went away',
        },
      ],
    });

    const store = new Store(dir);
    expect(store.listRuns().map((r) => r.id)).toEqual(['orphan']);
  });
});

describe('corrupt database recovery (NEWS-94)', () => {
  it('backs up an unreadable database and starts fresh', () => {
    const dir = tmpDataDir();
    const store = new Store(dir);
    store.addTopic('Doomed');
    store.close();

    // Not an empty file — a file with the right size and the wrong content, so
    // SQLite has to reject it rather than treat it as a new database.
    const file = dbPath(dir);
    const size = fs.statSync(file).size;
    fs.writeFileSync(file, Buffer.alloc(size, 0x41));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const recovered = new Store(dir);
    expect(recovered.listTopics()).toEqual([]);
    expect(fs.readdirSync(dir).filter((f) => f.includes('.corrupt-'))).toHaveLength(1);
    // And the recovered store is usable, not just constructible.
    expect(recovered.addTopic('Fresh').name).toBe('Fresh');
    expect(recovered.listTopics()).toHaveLength(1);
  });

  it('leaves no stale -wal beside the replacement database', () => {
    // A leftover write-ahead log from the corrupt database would be replayed
    // into its replacement, which is how a recovery corrupts the thing it made.
    const dir = tmpDataDir();
    const store = new Store(dir);
    store.addTopic('Doomed');
    store.close();

    const file = dbPath(dir);
    fs.writeFileSync(`${file}-wal`, Buffer.alloc(4096, 0x42));
    fs.writeFileSync(file, Buffer.alloc(fs.statSync(file).size, 0x41));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const recovered = new Store(dir);
    expect(recovered.listTopics()).toEqual([]);
    expect(recovered.addTopic('Fresh').id).toBeTruthy();
  });

  it('falls back to default settings without losing topics when settings are unreadable', () => {
    // The blast radius this change was for: under one JSON file, a settings
    // problem took the topics with it. Here it must not.
    const dir = tmpDataDir();
    const store = new Store(dir);
    store.addTopic('Kept');
    store.close();

    const db = new DatabaseSync(dbPath(dir));
    db.prepare(`UPDATE meta SET value = 'not json' WHERE key = 'settings'`).run();
    db.close();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const reopened = new Store(dir);
    expect(reopened.listTopics().map((t) => t.name)).toEqual(['Kept']);
    expect(reopened.getSettings().itemRetentionDays).toBe(DEFAULT_RETENTION_DAYS);
  });
});

describe('storage engine guarantees (NEWS-94)', () => {
  it('writes one row, not the whole store', () => {
    // The reason for the change, asserted rather than assumed: toggling one
    // bookmark used to re-serialize every topic, story and run. Measured as
    // bytes written, which is the thing that actually grew with the data.
    const dir = tmpDataDir();
    const store = new Store(dir);
    const topic = store.addTopic('Bulk');
    store.addItems(
      Array.from({ length: 400 }, (_, i) => ({
        topicId: topic.id,
        title: `Story ${String(i)}`,
        summary: 'x'.repeat(500),
        sources: [{ title: 'S', url: `https://example.test/${String(i)}`, outlet: null, publishedAt: null, favicon: null }],
        dedupeKey: `k${String(i)}`,
        foundAt: `2026-07-${String((i % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
      })),
    );

    const file = dbPath(dir);
    const wal = `${file}-wal`;
    const bytes = (): number =>
      fs.statSync(file).size + (fs.existsSync(wal) ? fs.statSync(wal).size : 0);

    const before = bytes();
    const target = store.listItems()[0];
    store.setItemSaved(target.id, true);
    const written = bytes() - before;

    // The store holds ~200 KB of stories; one bookmark must not cost anything
    // like that. Generous bound — the point is the order of magnitude, since a
    // whole-store rewrite could not come in under it.
    expect(written).toBeLessThan(64 * 1024);
    expect(store.listItems().find((i) => i.id === target.id)?.saved).toBe(true);
  });

  it('deletes a topic and everything filed under it, in one transaction', () => {
    const dir = tmpDataDir();
    const store = new Store(dir);
    const doomed = store.addTopic('Doomed');
    const kept = store.addTopic('Kept');
    for (const t of [doomed, kept]) {
      store.addItems([
        {
          topicId: t.id,
          title: `${t.name} story`,
          summary: 's',
          sources: [],
          dedupeKey: `k-${t.id}`,
          foundAt: '2026-07-02T00:00:00.000Z',
        },
      ]);
      store.startRun(t.id);
    }

    store.deleteTopic(doomed.id);

    expect(store.listTopics().map((t) => t.name)).toEqual(['Kept']);
    expect(store.listItems().map((i) => i.topicId)).toEqual([kept.id]);
    expect(store.listRuns().map((r) => r.topicId)).toEqual([kept.id]);
  });

  it('rejects a duplicate topic name at the database level too', () => {
    // The code check produces the message the API surfaces; the unique index is
    // the backstop for any future writer that forgets to make it.
    const dir = tmpDataDir();
    const store = new Store(dir);
    store.addTopic('Tennis');
    expect(() => store.addTopic('TENNIS')).toThrow(/already exists/);
    store.close();

    const db = new DatabaseSync(dbPath(dir));
    expect(() =>
      db
        .prepare('INSERT INTO topics (id, name, created_at) VALUES (?, ?, ?)')
        .run('x', 'tennis', '2026-07-01T00:00:00.000Z'),
    ).toThrow();
    db.close();
  });

  it('escapes LIKE wildcards in a search term', () => {
    // `%` and `_` are wildcards in SQL and ordinary characters to someone
    // typing in a search box. Under the old in-memory `includes` they had no
    // special meaning at all, and that is the behaviour being preserved.
    const dir = tmpDataDir();
    const store = new Store(dir);
    const topic = store.addTopic('Markets');
    store.addItems([
      {
        topicId: topic.id,
        title: 'Up 100% on the year',
        summary: 's',
        sources: [],
        dedupeKey: 'a',
        foundAt: '2026-07-02T00:00:00.000Z',
      },
      {
        topicId: topic.id,
        title: 'Flat and unremarkable',
        summary: 's',
        sources: [],
        dedupeKey: 'b',
        foundAt: '2026-07-01T00:00:00.000Z',
      },
    ]);

    expect(store.queryItems({ mode: 'normal', q: '100%', limit: 10 }).items).toHaveLength(1);
    // A bare `%` finds the story with a literal percent sign — one of the two.
    // Unescaped it would be a wildcard and match both, which is the bug.
    expect(store.queryItems({ mode: 'normal', q: '%', limit: 10 }).items.map((i) => i.title)).toEqual([
      'Up 100% on the year',
    ]);
    // `_` matches any single character as a wildcard; as a literal, nothing here.
    expect(store.queryItems({ mode: 'normal', q: '_', limit: 10 }).items).toHaveLength(0);
  });

  it('still matches mid-word, as substring search always did', () => {
    // Pinning the decision not to use FTS5: it matches tokens and prefixes, so
    // this search would return nothing. A filter that narrows as you type is
    // exactly where someone types the middle of a word.
    const dir = tmpDataDir();
    const store = new Store(dir);
    const topic = store.addTopic('Federal Reserve');
    store.addItems([
      {
        topicId: topic.id,
        title: 'Rates unchanged',
        summary: 'The committee held.',
        sources: [],
        dedupeKey: 'a',
        foundAt: '2026-07-02T00:00:00.000Z',
      },
    ]);

    expect(store.queryItems({ mode: 'normal', q: 'eserv', limit: 10 }).items).toHaveLength(1);
    expect(store.queryItems({ mode: 'normal', q: 'ommittee', limit: 10 }).items).toHaveLength(1);
    expect(store.queryItems({ mode: 'normal', q: 'nchanged', limit: 10 }).items).toHaveLength(1);
  });

  it('sweeps up stories and runs left by a topic deleted mid-check (NEWS-105)', () => {
    // The full sequence, not a synthetic orphan row: create, start a check,
    // delete the topic while it is "in flight", then let the check land its
    // writes. That ordering is the only way an orphan can exist, so it is the
    // one worth testing.
    const dir = tmpDataDir();
    const store = new Store(dir);
    const doomed = store.addTopic('Fleeting');
    const kept = store.addTopic('Kept');
    const inFlight = store.startRun(doomed.id);

    store.deleteTopic(doomed.id);

    // A run that had already *started* is not an orphan — `deleteTopic` removed
    // it, and `finishRun` on a row that is gone is a no-op. Worth pinning: it is
    // the boundary between what deletion handles and what this sweep is for.
    expect(store.listRuns().map((r) => r.id)).not.toContain(inFlight.id);
    store.finishRun(inFlight.id, { status: 'succeeded', newItems: 1 });
    expect(store.listRuns().map((r) => r.id)).not.toContain(inFlight.id);

    // These are the two writes that genuinely orphan: a story landing from the
    // in-flight check, and a queued check *starting* after the delete (the
    // sweep captured the topic list before it).
    store.addItems([
      {
        topicId: doomed.id,
        title: 'Arrived late',
        summary: 's',
        sources: [],
        dedupeKey: 'late',
        foundAt: '2026-07-02T00:00:00.000Z',
      },
    ]);
    store.startRun(doomed.id);

    store.addItems([
      {
        topicId: kept.id,
        title: 'Still wanted',
        summary: 's',
        sources: [],
        dedupeKey: 'kept',
        foundAt: '2026-07-02T00:00:00.000Z',
      },
    ]);
    store.startRun(kept.id);

    // Before the sweep the orphans are really there — otherwise this test would
    // pass against a store that never had the problem.
    expect(store.listItems()).toHaveLength(2);

    expect(store.pruneOrphans()).toEqual({ items: 1, runs: 1 });

    expect(store.listItems().map((i) => i.title)).toEqual(['Still wanted']);
    expect(store.listRuns().map((r) => r.topicId)).toEqual([kept.id]);
  });

  it('sweeps nothing when every topic is present', () => {
    const dir = tmpDataDir();
    const store = new Store(dir);
    const topic = store.addTopic('Intact');
    store.addItems([
      {
        topicId: topic.id,
        title: 'Fine',
        summary: 's',
        sources: [],
        dedupeKey: 'a',
        foundAt: '2026-07-02T00:00:00.000Z',
      },
    ]);
    store.startRun(topic.id);

    expect(store.pruneOrphans()).toEqual({ items: 0, runs: 0 });
    expect(store.listItems()).toHaveLength(1);
    expect(store.listRuns()).toHaveLength(1);
  });

  it('sweeps orphans regardless of saved or flagged status', () => {
    // `pruneOldItems` exempts bookmarked and flagged stories, and those
    // exemptions must NOT carry over here: they mean "the user wants this kept",
    // but there is no topic left to keep it under, and a flagged orphan would go
    // on feeding a prompt for a topic that no longer exists.
    const dir = tmpDataDir();
    const store = new Store(dir);
    const doomed = store.addTopic('Fleeting');
    const [saved, flagged] = store.addItems([
      {
        topicId: doomed.id,
        title: 'Bookmarked',
        summary: 's',
        sources: [],
        dedupeKey: 'a',
        foundAt: '2026-07-02T00:00:00.000Z',
      },
      {
        topicId: doomed.id,
        title: 'Flagged',
        summary: 's',
        sources: [],
        dedupeKey: 'b',
        foundAt: '2026-07-02T00:00:00.000Z',
      },
    ]);
    store.setItemSaved(saved.id, true);
    store.setItemOffTopic(flagged.id, true);
    // Delete via SQL, so the items survive `deleteTopic`'s own cascade and are
    // orphans by the time the sweep runs.
    store.close();
    const db = new DatabaseSync(dbPath(dir));
    db.prepare('DELETE FROM topics WHERE id = ?').run(doomed.id);
    db.close();

    const reopened = new Store(dir);
    expect(reopened.pruneOrphans()).toEqual({ items: 2, runs: 0 });
    expect(reopened.listItems()).toEqual([]);
  });

  it('is idempotent — a second sweep finds nothing', () => {
    const dir = tmpDataDir();
    const store = new Store(dir);
    const doomed = store.addTopic('Fleeting');
    store.deleteTopic(doomed.id);
    store.addItems([
      {
        topicId: doomed.id,
        title: 'Late',
        summary: 's',
        sources: [],
        dedupeKey: 'a',
        foundAt: '2026-07-02T00:00:00.000Z',
      },
    ]);

    expect(store.pruneOrphans()).toEqual({ items: 1, runs: 0 });
    expect(store.pruneOrphans()).toEqual({ items: 0, runs: 0 });
  });

  it('keeps a story whose topic was deleted mid-check visible in the feed until the sweep', () => {
    // No foreign keys, deliberately: a check can outlive its topic. The story
    // should still be readable rather than vanish or fail to insert.
    const dir = tmpDataDir();
    const store = new Store(dir);
    const topic = store.addTopic('Fleeting');
    store.deleteTopic(topic.id);

    expect(() =>
      store.addItems([
        {
          topicId: topic.id,
          title: 'Arrived late',
          summary: 's',
          sources: [],
          dedupeKey: 'a',
          foundAt: '2026-07-02T00:00:00.000Z',
        },
      ]),
    ).not.toThrow();
    expect(() => store.startRun(topic.id)).not.toThrow();
    expect(store.queryItems({ mode: 'normal', limit: 10 }).items.map((i) => i.title)).toEqual(['Arrived late']);
  });
});

describe('topic categories in the store (NEWS-97)', () => {
  it('defaults a new topic to uncategorized', () => {
    const store = new Store(tmpDataDir());
    const topic = store.addTopic('Skiing');
    expect(topic.category).toBeNull();
    expect(topic.subcategory).toBeNull();
    // 'auto' rather than null: nobody has chosen, so automatic classification
    // is free to write. Only an explicit human choice sets 'manual'.
    expect(topic.categorySource).toBe('auto');
  });

  it('round-trips a category through storage', () => {
    const dir = tmpDataDir();
    const store = new Store(dir);
    const topic = store.addTopic('Premier League');
    store.setTopicCategory(topic.id, 'sports', 'soccer', 'manual');
    store.close();

    const reopened = new Store(dir);
    const reloaded = reopened.getTopic(topic.id);
    expect(reloaded?.category).toBe('sports');
    expect(reloaded?.subcategory).toBe('soccer');
    expect(reloaded?.categorySource).toBe('manual');
  });

  it('stores a category with no subcategory', () => {
    // The `sports`/null shape that renders as "Other" — it has to survive a
    // round-trip as null rather than as an empty string.
    const dir = tmpDataDir();
    const store = new Store(dir);
    const topic = store.addTopic('Skiing');
    store.setTopicCategory(topic.id, 'sports', null, 'auto');
    store.close();

    expect(new Store(dir).getTopic(topic.id)?.subcategory).toBeNull();
  });

  it('accepts a slug the taxonomy does not have', () => {
    // Deliberate: the taxonomy is code-side and editable, so a slug that
    // resolves today may not tomorrow. The store must not be the one place that
    // can't survive an ordinary edit — unresolvable slugs render as
    // Uncategorized rather than failing a load.
    const store = new Store(tmpDataDir());
    const topic = store.addTopic('Weather');
    expect(() => store.setTopicCategory(topic.id, 'weather', 'forecasts', 'auto')).not.toThrow();
    expect(store.getTopic(topic.id)?.category).toBe('weather');
  });

  it('clears a category back to null', () => {
    const store = new Store(tmpDataDir());
    const topic = store.addTopic('Ambiguous');
    store.setTopicCategory(topic.id, 'sports', 'soccer', 'manual');
    store.setTopicCategory(topic.id, null, null, 'auto');
    expect(store.getTopic(topic.id)?.category).toBeNull();
    expect(store.getTopic(topic.id)?.categorySource).toBe('auto');
  });

  it('throws for a topic that is gone', () => {
    const store = new Store(tmpDataDir());
    expect(() => store.setTopicCategory('nope', 'sports', null, 'auto')).toThrow(/no such topic/);
  });
});

describe('schema migration v1 → v2 (NEWS-97)', () => {
  /** Build a database in the pre-category v1 shape, as an older build wrote it. */
  function v1Database(dir: string): void {
    const db = new DatabaseSync(dbPath(dir));
    db.exec(`
      CREATE TABLE topics (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, paused INTEGER NOT NULL DEFAULT 0,
        high_priority INTEGER NOT NULL DEFAULT 0, guidance TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL, last_checked_at TEXT, covered_through_at TEXT
      );
      CREATE TABLE items (
        id TEXT PRIMARY KEY, topic_id TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL,
        sources TEXT NOT NULL, image TEXT, dedupe_key TEXT NOT NULL, found_at TEXT NOT NULL,
        saved INTEGER NOT NULL DEFAULT 0, off_topic INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE runs (
        id TEXT PRIMARY KEY, topic_id TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
        status TEXT NOT NULL, new_items INTEGER NOT NULL DEFAULT 0, error TEXT,
        provider TEXT, model TEXT, usage TEXT
      );
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      PRAGMA user_version = 1;
    `);
    db.prepare(
      `INSERT INTO topics (id, name, paused, high_priority, guidance, created_at, last_checked_at, covered_through_at)
       VALUES ('t1', 'Tennis', 1, 1, 'majors only', '2026-07-01T00:00:00.000Z', '2026-07-02T00:00:00.000Z', NULL)`,
    ).run();
    db.prepare(
      `INSERT INTO items (id, topic_id, title, summary, sources, dedupe_key, found_at)
       VALUES ('i1', 't1', 'Final set', 'It went long.', '[]', 'k1', '2026-07-02T00:00:00.000Z')`,
    ).run();
    db.close();
  }

  it('adds the category columns without touching existing data', () => {
    const dir = tmpDataDir();
    v1Database(dir);

    const store = new Store(dir);
    const topic = store.getTopic('t1');
    // Everything the v1 row held is intact...
    expect(topic?.name).toBe('Tennis');
    expect(topic?.paused).toBe(true);
    expect(topic?.highPriority).toBe(true);
    expect(topic?.guidance).toBe('majors only');
    expect(topic?.lastCheckedAt).toBe('2026-07-02T00:00:00.000Z');
    expect(store.listItems()).toHaveLength(1);
    // ...and the new columns arrive as "not yet classified", which is true.
    expect(topic?.category).toBeNull();
    expect(topic?.subcategory).toBeNull();
    expect(topic?.categorySource).toBe('auto');
  });

  it('leaves a migrated database writable and at the new version', () => {
    const dir = tmpDataDir();
    v1Database(dir);
    const store = new Store(dir);

    store.setTopicCategory('t1', 'sports', 'tennis', 'manual');
    expect(store.getTopic('t1')?.subcategory).toBe('tennis');
    store.close();

    const db = new DatabaseSync(dbPath(dir));
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
    db.close();
  });

  it('does not re-run the migration on a second open', () => {
    // `ALTER TABLE ADD COLUMN` throws on a duplicate, so a version that failed
    // to advance would make the app unopenable on the next start.
    const dir = tmpDataDir();
    v1Database(dir);
    new Store(dir).close();
    expect(() => new Store(dir)).not.toThrow();
    expect(new Store(dir).getTopic('t1')?.name).toBe('Tennis');
  });

  it('creates a fresh database at the current version with no migration', () => {
    const dir = tmpDataDir();
    const store = new Store(dir);
    store.addTopic('Fresh');
    store.close();

    const db = new DatabaseSync(dbPath(dir));
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
    // The columns come from SCHEMA, not from a migration that a new file skips.
    const cols = (db.prepare('PRAGMA table_info(topics)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain('category');
    expect(cols).toContain('category_source');
    db.close();
  });
});

describe('schema migration v2 → v3 (NEWS-110)', () => {
  /** A v2 database: has the category columns, not the failure-cooldown ones. */
  function v2Database(dir: string): void {
    const db = new DatabaseSync(dbPath(dir));
    db.exec(`
      CREATE TABLE topics (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, paused INTEGER NOT NULL DEFAULT 0,
        high_priority INTEGER NOT NULL DEFAULT 0, guidance TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL, last_checked_at TEXT, covered_through_at TEXT,
        category TEXT, subcategory TEXT, category_source TEXT NOT NULL DEFAULT 'auto'
      );
      CREATE TABLE items (
        id TEXT PRIMARY KEY, topic_id TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL,
        sources TEXT NOT NULL, image TEXT, dedupe_key TEXT NOT NULL, found_at TEXT NOT NULL,
        saved INTEGER NOT NULL DEFAULT 0, off_topic INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE runs (
        id TEXT PRIMARY KEY, topic_id TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
        status TEXT NOT NULL, new_items INTEGER NOT NULL DEFAULT 0, error TEXT,
        provider TEXT, model TEXT, usage TEXT
      );
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      PRAGMA user_version = 2;
    `);
    db.prepare(
      `INSERT INTO topics (id, name, created_at, category, subcategory, category_source)
       VALUES ('t1', 'Tennis', '2026-07-01T00:00:00.000Z', 'sports', 'tennis', 'manual')`,
    ).run();
    db.close();
  }

  it('adds the cooldown columns and starts the topic with a clean slate', () => {
    const dir = tmpDataDir();
    v2Database(dir);

    const store = new Store(dir);
    const topic = store.getTopic('t1');
    // The v2 data survives...
    expect(topic?.name).toBe('Tennis');
    expect(topic?.category).toBe('sports');
    expect(topic?.categorySource).toBe('manual');
    // ...and the new columns arrive as "no failures", which is what it has.
    expect(topic?.consecutiveFailures).toBe(0);
    expect(topic?.retryAfter).toBeNull();
  });

  it('runs both migrations in order for a v1 database', () => {
    // The case a single-step migration would miss: a database that has been
    // sitting since before either change needs v1→v2 *and* v2→v3.
    const dir = tmpDataDir();
    const db = new DatabaseSync(dbPath(dir));
    db.exec(`
      CREATE TABLE topics (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, paused INTEGER NOT NULL DEFAULT 0,
        high_priority INTEGER NOT NULL DEFAULT 0, guidance TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL, last_checked_at TEXT, covered_through_at TEXT
      );
      CREATE TABLE items (
        id TEXT PRIMARY KEY, topic_id TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL,
        sources TEXT NOT NULL, image TEXT, dedupe_key TEXT NOT NULL, found_at TEXT NOT NULL,
        saved INTEGER NOT NULL DEFAULT 0, off_topic INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE runs (
        id TEXT PRIMARY KEY, topic_id TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
        status TEXT NOT NULL, new_items INTEGER NOT NULL DEFAULT 0, error TEXT,
        provider TEXT, model TEXT, usage TEXT
      );
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      PRAGMA user_version = 1;
    `);
    db.prepare(`INSERT INTO topics (id, name, created_at) VALUES ('t1', 'Ancient', '2026-01-01T00:00:00.000Z')`).run();
    db.close();

    const store = new Store(dir);
    const topic = store.getTopic('t1');
    expect(topic?.name).toBe('Ancient');
    // From v1→v2...
    expect(topic?.category).toBeNull();
    expect(topic?.categorySource).toBe('auto');
    // ...and from v2→v3.
    expect(topic?.consecutiveFailures).toBe(0);
    store.close();

    const check = new DatabaseSync(dbPath(dir));
    expect((check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
    check.close();
  });
});
