import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import { dbPath, SCHEMA_VERSION } from '../../src/db/sqlite.js';
import { Store } from '../../src/db/store.js';
import type { ThreadInput } from '../../src/threads.js';
import { planThreadIds, THREAD_MAX_GAP_MS, threadIdFor, withThreadIds } from '../../src/threads.js';
import { tmpDataDir } from '../helpers/tmp.js';

// Story threads (NEWS-280). Two layers here: the pure similarity module, and the
// store's persistence + backfill on top of it.

const TOPIC = 'Formula One';
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-07-01T00:00:00.000Z');

function at(offsetMs: number): string {
  return new Date(T0 + offsetMs).toISOString();
}

let seq = 0;
function story(title: string, over: Partial<ThreadInput> = {}): ThreadInput {
  seq += 1;
  return {
    id: over.id ?? `s${String(seq)}`,
    title,
    foundAt: over.foundAt ?? at(0),
    sources: over.sources ?? [{ url: `https://news.example.com/a${String(seq)}` }],
    ...over,
  };
}

/** Does a candidate join anything in `existing`? */
function joins(candidate: ThreadInput, existing: ThreadInput[], topicName = TOPIC): boolean {
  return threadIdFor(candidate, existing, { topicName }) !== candidate.id;
}

/** `existing` with each item already a thread of one, which is how rows land. */
function threaded(items: ThreadInput[]): ThreadInput[] {
  return items.map((i) => ({ ...i, threadId: i.threadId ?? i.id }));
}

describe('thread similarity (NEWS-280)', () => {
  it('joins two outlets covering the same subject', () => {
    const first = story('Riverside Dam collapse floods three towns', {
      id: 'a',
      sources: [{ url: 'https://news.example.com/riverside-dam' }],
    });
    const second = story('Rescue teams reach Riverside Dam flood zone', {
      id: 'b',
      foundAt: at(DAY),
      sources: [{ url: 'https://times.example.com/riverside-rescue' }],
    });
    // Different hosts on purpose: this is exactly the pair `dedupeKey` cannot
    // relate, since two outlets produce two different URL keys.
    expect(threadIdFor(second, threaded([first]), { topicName: TOPIC })).toBe('a');
  });

  it('leaves unrelated stories in the same topic alone', () => {
    const existing = threaded([
      story('Riverside Dam collapse floods three towns', { id: 'a' }),
      story('Central bank holds interest rates steady', { id: 'b' }),
    ]);
    expect(joins(story('Airline cancels winter routes to Oslo'), existing)).toBe(false);
  });

  it('does not thread on the topic\'s own words', () => {
    // The mock provider's two stories: they share the topic name and nothing
    // else, which is the commonest false-positive shape there is.
    const existing = threaded([story(`Major development in ${TOPIC}`, { id: 'a' })]);
    expect(joins(story(`${TOPIC}: what experts are watching next`), existing)).toBe(false);
  });

  it('does not thread on stopwords and filler alone', () => {
    const existing = threaded([story('Report says the plan will be reviewed after the year', { id: 'a' })]);
    // Every shared word is a stopword; the subjects have nothing in common.
    expect(joins(story('Report says the update will be made after the week'), existing)).toBe(false);
  });

  it('needs more than two shared words with no shared entity', () => {
    const existing = threaded([story('engine supplier deal collapses', { id: 'a' })]);
    // Two lowercase content words in common, no capitalized entity: below the bar
    // on purpose, because a false join is worse than a miss.
    expect(joins(story('engine supplier signs new agreement'), existing)).toBe(false);
    // A shared entity lowers the bar to two — and here there are three anyway.
    expect(
      joins(story('Ferrari engine supplier deal salvaged'), threaded([story('Ferrari engine supplier deal collapses', { id: 'a' })])),
    ).toBe(true);
  });

  it('refuses a join when the overlap is a small share of both titles', () => {
    const existing = threaded([
      story('Silverstone Grand Prix qualifying washed out by torrential storms overnight', { id: 'a' }),
    ]);
    // Both headlines name the same venue and are otherwise about entirely
    // different things. Three shared words clears the absolute bar; the ratio is
    // what says "mostly not the same story".
    const other = story('Silverstone Grand Prix tickets sell out within minutes as demand surges nationwide');
    expect(joins(other, existing)).toBe(false);
  });

  it('starts a new thread once the subject has gone quiet (recency window)', () => {
    const first = story('Riverside Dam collapse floods three towns', { id: 'a' });
    const inside = story('Riverside Dam flood inquiry opens', { id: 'b', foundAt: at(THREAD_MAX_GAP_MS - DAY) });
    const outside = story('Riverside Dam flood inquiry opens', { id: 'c', foundAt: at(THREAD_MAX_GAP_MS + DAY) });
    expect(threadIdFor(inside, threaded([first]), { topicName: TOPIC })).toBe('a');
    expect(threadIdFor(outside, threaded([first]), { topicName: TOPIC })).toBe('c');
  });

  it('never joins a story with an unparseable timestamp', () => {
    const existing = threaded([story('Riverside Dam collapse floods three towns', { id: 'a' })]);
    expect(joins(story('Riverside Dam flood inquiry opens', { foundAt: 'whenever' }), existing)).toBe(false);
  });

  it('keeps flagged stories out of threading entirely', () => {
    const flagged = threaded([story('Riverside Dam collapse floods three towns', { id: 'a', offTopic: true })]);
    // A flagged story is not a match target...
    expect(joins(story('Riverside Dam flood inquiry opens'), flagged)).toBe(false);
    // ...and a flagged candidate joins nothing, even against a clean thread.
    const clean = threaded([story('Riverside Dam collapse floods three towns', { id: 'a' })]);
    expect(joins(story('Riverside Dam flood inquiry opens', { offTopic: true }), clean)).toBe(false);
  });

  it('honours a thread id that is already decided', () => {
    const items: ThreadInput[] = [
      { ...story('Riverside Dam collapse floods three towns', { id: 'a' }), threadId: 'a' },
      { ...story('Riverside Dam flood inquiry opens', { id: 'b', foundAt: at(DAY) }), threadId: 'zzz' },
    ];
    // 'b' would have joined 'a', but it has an answer already and keeps it —
    // threading a new story must never reshuffle one the user has seen.
    expect(planThreadIds(items, { topicName: TOPIC })).toEqual(['a', 'zzz']);
  });

  it('is transitive by emergence: a chain lands in one thread', () => {
    const items: ThreadInput[] = [
      story('Riverside Dam collapse floods three towns', { id: 'a', foundAt: at(0) }),
      story('Riverside Dam flood relief fund opens', { id: 'b', foundAt: at(DAY) }),
      story('Riverside Dam flood relief fund doubles', { id: 'c', foundAt: at(2 * DAY) }),
    ];
    // 'c' matches 'b' most strongly and takes *'b''s thread*, which is already
    // 'a''s. Chains form through nearest matches; nothing is ever merged.
    expect(planThreadIds(items, { topicName: TOPIC })).toEqual(['a', 'a', 'a']);
  });

  it('picks one thread rather than merging two it resembles', () => {
    const items: ThreadInput[] = [
      { ...story('Monza circuit resurfacing begins', { id: 'a', foundAt: at(0) }), threadId: 'a' },
      { ...story('Imola circuit resurfacing begins', { id: 'b', foundAt: at(DAY) }), threadId: 'b' },
      { ...story('Monza circuit resurfacing finishes', { id: 'c', foundAt: at(2 * DAY) }), threadId: undefined },
    ];
    const plan = planThreadIds(items, { topicName: TOPIC });
    // 'c' resembles both, joins the better one, and — the point — leaves 'a' and
    // 'b' as two threads. A union-find clustering would have welded them.
    expect(plan).toEqual(['a', 'b', 'a']);
  });
});

describe('thread planning across a topic\'s history (NEWS-280)', () => {
  it('threads a batch against itself as well as against history', () => {
    const landed = withThreadIds(
      [
        story('Riverside Dam collapse floods three towns', { id: 'a' }),
        story('Rescue teams reach Riverside Dam flood zone', { id: 'b' }),
        story('Central bank holds interest rates steady', { id: 'c' }),
      ],
      [],
      { topicName: TOPIC },
    );
    expect(landed.map((i) => i.threadId)).toEqual(['a', 'a', 'c']);
  });

  it('is a thread of one when nothing matches', () => {
    expect(withThreadIds([story('Nothing like it', { id: 'solo' })], [], { topicName: TOPIC })[0]?.threadId).toBe('solo');
  });

  // --- Transition matrix -----------------------------------------------------
  //
  // States a topic's thread history can be in: empty · one thread of one · a
  // live thread (recently updated) · a stale thread (past the window) · a
  // cleared topic. The transitions between them are where the bugs are, so each
  // of these walks a sequence rather than testing one call from a clean start.

  it('empty → thread of one → thread of two → a second thread', () => {
    const pool: ThreadInput[] = [];
    const add = (title: string, id: string, offsetMs: number): string => {
      const item = story(title, { id, foundAt: at(offsetMs) });
      const threadId = threadIdFor(item, pool, { topicName: TOPIC });
      pool.push({ ...item, threadId });
      return threadId;
    };
    expect(add('Riverside Dam collapse floods three towns', 'a', 0)).toBe('a');
    expect(add('Rescue teams reach Riverside Dam flood zone', 'b', DAY)).toBe('a');
    expect(add('Central bank holds interest rates steady', 'c', 2 * DAY)).toBe('c');
    expect(add('Central bank rates decision draws criticism', 'd', 3 * DAY)).toBe('c');
  });

  it('a live thread keeps extending past the window from its oldest member', () => {
    // Each step is inside the window relative to the previous one, and the last
    // is well past it relative to the first. A thread nobody stops updating must
    // not fall apart at the 30-day mark.
    const pool: ThreadInput[] = [];
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const item = story(`Riverside Dam flood inquiry stage ${String(i)}`, { id: `s${String(i)}`, foundAt: at(i * 20 * DAY) });
      const threadId = threadIdFor(item, pool, { topicName: TOPIC });
      pool.push({ ...item, threadId });
      ids.push(threadId);
    }
    expect(ids).toEqual(['s0', 's0', 's0', 's0']);
    expect(Date.parse(pool[3]?.foundAt ?? '') - Date.parse(pool[0]?.foundAt ?? '')).toBeGreaterThan(THREAD_MAX_GAP_MS);
  });

  it('a thread that goes quiet and revives starts again, then extends the new thread', () => {
    const first = story('Riverside Dam collapse floods three towns', { id: 'a' });
    const revival = story('Riverside Dam collapse report published', { id: 'b', foundAt: at(THREAD_MAX_GAP_MS + DAY) });
    const followUp = story('Riverside Dam collapse report criticised', { id: 'c', foundAt: at(THREAD_MAX_GAP_MS + 2 * DAY) });
    const plan = planThreadIds(
      [{ ...first, threadId: 'a' }, { ...revival, threadId: undefined }, { ...followUp, threadId: undefined }],
      { topicName: TOPIC },
    );
    // The revival is its own thread; what follows it joins *that*, not the stale one.
    expect(plan).toEqual(['a', 'b', 'b']);
  });

  it('handles stories arriving out of chronological order', () => {
    // The newest lands first (a catch-up check reporting oldest-to-newest is the
    // usual way round; this is the other one). The gap is absolute, so the older
    // story still joins rather than being judged as "before the thread existed".
    const newer = story('Rescue teams reach Riverside Dam flood zone', { id: 'newer', foundAt: at(2 * DAY) });
    const older = story('Riverside Dam collapse floods three towns', { id: 'older', foundAt: at(0) });
    expect(planThreadIds([{ ...newer, threadId: 'newer' }, { ...older, threadId: undefined }], { topicName: TOPIC })).toEqual([
      'newer',
      'newer',
    ]);
  });

  it('is order-independent about *membership*, if not about the id', () => {
    const a = story('Riverside Dam collapse floods three towns', { id: 'a', foundAt: at(0) });
    const b = story('Rescue teams reach Riverside Dam flood zone', { id: 'b', foundAt: at(DAY) });
    const forward = planThreadIds([{ ...a, threadId: undefined }, { ...b, threadId: undefined }], { topicName: TOPIC });
    const backward = planThreadIds([{ ...b, threadId: undefined }, { ...a, threadId: undefined }], { topicName: TOPIC });
    // Either order groups them together; which story names the thread depends on
    // which was seen first, which is why the backfill replays chronologically.
    expect(new Set(forward).size).toBe(1);
    expect(new Set(backward).size).toBe(1);
  });

  it('the same subject twice in one batch groups without touching history', () => {
    const history = threaded([story('Central bank holds interest rates steady', { id: 'old' })]);
    const landed = withThreadIds(
      [
        story('Riverside Dam collapse floods three towns', { id: 'x' }),
        story('Rescue teams reach Riverside Dam flood zone', { id: 'y' }),
      ],
      history,
      { topicName: TOPIC },
    );
    expect(landed.map((i) => i.threadId)).toEqual(['x', 'x']);
    // And the pre-existing story is untouched by the planning pass.
    expect(planThreadIds(history, { topicName: TOPIC })).toEqual(['old']);
  });

  it('re-planning the same list is stable (no drift on repeat)', () => {
    const items: ThreadInput[] = [
      story('Riverside Dam collapse floods three towns', { id: 'a', foundAt: at(0) }),
      story('Rescue teams reach Riverside Dam flood zone', { id: 'b', foundAt: at(DAY) }),
      story('Central bank holds interest rates steady', { id: 'c', foundAt: at(2 * DAY) }),
    ];
    const once = planThreadIds(items, { topicName: TOPIC });
    // Feed the answers back in as decided ids, the way the store does.
    const twice = planThreadIds(
      items.map((item, i) => ({ ...item, threadId: once.at(i) })),
      { topicName: TOPIC },
    );
    expect(twice).toEqual(once);
    // And recomputing from scratch is identical too, which is what makes the
    // backfill idempotent rather than merely repeatable.
    expect(planThreadIds(items, { topicName: TOPIC })).toEqual(once);
  });

  it('an empty list plans to nothing', () => {
    expect(planThreadIds([])).toEqual([]);
  });

  it('shows what subtracting the topic name buys', () => {
    // Two stories that share nothing but the topic's name. With the name, they
    // are correctly unrelated; without it, they false-join on it — which is the
    // whole reason every real caller passes the topic name.
    const dam = 'Riverside Dam';
    const existing = threaded([story(`${dam} visitor centre reopens`, { id: 'a' })]);
    const candidate = story(`${dam} wins an architecture award`, { id: 'b', foundAt: at(DAY) });
    expect(threadIdFor(candidate, existing, { topicName: dam })).toBe('b');
    expect(threadIdFor(candidate, existing)).toBe('a');
  });
});

describe('threads in the store (NEWS-280)', () => {
  function seed(store: Store, topicId: string, titles: string[], startMs = 0): void {
    titles.forEach((title, i) => {
      store.addItems([
        {
          topicId,
          title,
          summary: 's',
          sources: [{ title: 'Example', url: `https://news.example.com/${String(i)}`, outlet: null, publishedAt: null, favicon: null }],
          dedupeKey: `k${String(startMs)}-${String(i)}`,
          foundAt: at(startMs + i * DAY),
        },
      ]);
    });
  }

  it('round-trips a thread id, defaulting to the story\'s own id', () => {
    const store = new Store(tmpDataDir());
    const topic = store.addTopic(TOPIC);
    const [item] = store.addItems([
      { topicId: topic.id, title: 'Lone story', summary: 's', sources: [], dedupeKey: 'k1', foundAt: at(0) },
    ]);
    expect(item.threadId).toBe(item.id);
    expect(store.listItems(topic.id).at(0)?.threadId).toBe(item.id);

    // An explicit id survives the round trip too, with a caller-minted item id.
    const [joined] = store.addItems([
      { id: 'mine', threadId: item.id, topicId: topic.id, title: 'Second', summary: 's', sources: [], dedupeKey: 'k2', foundAt: at(DAY) },
    ]);
    expect(joined.id).toBe('mine');
    expect(store.listItems(topic.id).find((i) => i.id === 'mine')?.threadId).toBe(item.id);
    store.close();
  });

  it('reads a thread back in chronological order, and a lone story as itself', () => {
    const store = new Store(tmpDataDir());
    const topic = store.addTopic(TOPIC);
    seed(store, topic.id, [
      'Riverside Dam collapse floods three towns',
      'Rescue teams reach Riverside Dam flood zone',
      'Central bank holds interest rates steady',
    ]);
    store.backfillThreads();

    const items = store.listItems(topic.id);
    const head = items.find((i) => i.title.startsWith('Riverside'));
    const thread = store.threadForItem(head?.id ?? '');
    expect(thread.map((i) => i.title)).toEqual([
      'Riverside Dam collapse floods three towns',
      'Rescue teams reach Riverside Dam flood zone',
    ]);
    // Asking about the *later* member answers with the same thread.
    expect(store.threadForItem(thread[1]?.id ?? '').map((i) => i.id)).toEqual(thread.map((i) => i.id));

    const lone = items.find((i) => i.title.startsWith('Central'));
    expect(store.threadForItem(lone?.id ?? '').map((i) => i.id)).toEqual([lone?.id]);
    expect(store.threadForItem('no-such-item')).toEqual([]);
    store.close();
  });

  it('leaves flagged stories out of a thread, except when asked about one', () => {
    const store = new Store(tmpDataDir());
    const topic = store.addTopic(TOPIC);
    seed(store, topic.id, ['Riverside Dam collapse floods three towns', 'Rescue teams reach Riverside Dam flood zone']);
    store.backfillThreads();
    const items = store.listItems(topic.id);
    const second = items.find((i) => i.title.startsWith('Rescue'));
    store.setItemOffTopic(second?.id ?? '', true);

    const head = items.find((i) => i.title.startsWith('Riverside'));
    // Flagging after the fact does not un-thread the row — but the thread read
    // stops showing it, exactly as the feed does.
    expect(store.listItems(topic.id).find((i) => i.id === second?.id)?.threadId).toBe(head?.id);
    expect(store.threadForItem(head?.id ?? '').map((i) => i.id)).toEqual([head?.id]);
    // Asking about the flagged story itself still answers with its thread, with
    // it in place — an empty answer would be a worse lie than showing it.
    expect(store.threadForItem(second?.id ?? '').map((i) => i.id)).toEqual([head?.id, second?.id]);
    store.close();
  });

  it('backfills existing rows, and is idempotent when run again', () => {
    const store = new Store(tmpDataDir());
    const topic = store.addTopic(TOPIC);
    seed(store, topic.id, [
      'Riverside Dam collapse floods three towns',
      'Rescue teams reach Riverside Dam flood zone',
      'Central bank holds interest rates steady',
    ]);
    // Everything lands as a thread of one, because `addItems` alone does not
    // thread — assignment is the caller's (`CheckRunner`'s) job.
    expect(store.listItems(topic.id).every((i) => i.threadId === i.id)).toBe(true);

    expect(store.backfillThreads()).toBe(1);
    const first = new Map(store.listItems(topic.id).map((i) => [i.id, i.threadId]));
    expect(new Set(first.values()).size).toBe(2);

    // Run it twice: nothing left to do, and the mapping is identical.
    expect(store.backfillThreads()).toBe(0);
    expect(new Map(store.listItems(topic.id).map((i) => [i.id, i.threadId]))).toEqual(first);
    store.close();
  });

  it('survives a close and reopen with the same threads', () => {
    const dir = tmpDataDir();
    const store = new Store(dir);
    const topic = store.addTopic(TOPIC);
    seed(store, topic.id, ['Riverside Dam collapse floods three towns', 'Rescue teams reach Riverside Dam flood zone']);
    store.backfillThreads();
    const before = new Map(store.listItems(topic.id).map((i) => [i.id, i.threadId]));
    store.close();

    const reopened = new Store(dir);
    expect(new Map(reopened.listItems(topic.id).map((i) => [i.id, i.threadId]))).toEqual(before);
    expect(reopened.backfillThreads()).toBe(0);
    reopened.close();
  });

  it('threads each topic separately', () => {
    const store = new Store(tmpDataDir());
    const one = store.addTopic('Flooding');
    const two = store.addTopic('Infrastructure');
    seed(store, one.id, ['Riverside Dam collapse floods three towns']);
    seed(store, two.id, ['Rescue teams reach Riverside Dam flood zone'], 10);
    store.backfillThreads();
    const [a] = store.listItems(one.id);
    const [b] = store.listItems(two.id);
    // Same subject, different topics: threads never span topics, because dedup
    // and threading are both per-topic (FR-2.9).
    expect(a.threadId).toBe(a.id);
    expect(b.threadId).toBe(b.id);
    store.close();
  });

  // --- Adversarial ----------------------------------------------------------

  it('a topic emptied and refilled threads the new stories, not the ghosts of the old', () => {
    const store = new Store(tmpDataDir());
    const topic = store.addTopic(TOPIC);
    seed(store, topic.id, ['Riverside Dam collapse floods three towns', 'Rescue teams reach Riverside Dam flood zone']);
    store.backfillThreads();
    const cleared = store.clearItemsForTopic(topic.id);
    expect(store.listItems(topic.id)).toHaveLength(0);
    // A backfill over an empty topic must do nothing rather than throw.
    expect(store.backfillThreads()).toBe(0);

    seed(store, topic.id, ['Riverside Dam collapse inquiry opens', 'Riverside Dam collapse inquiry hears evidence'], 5);
    expect(store.backfillThreads()).toBe(1);
    const after = store.listItems(topic.id);
    expect(new Set(after.map((i) => i.threadId)).size).toBe(1);
    // None of the new stories inherited an id from the cleared ones.
    const goneIds = new Set(cleared.items.map((i) => i.id));
    expect(after.some((i) => goneIds.has(i.threadId))).toBe(false);
    store.close();
  });

  it('an undo restores the thread ids it took, not fresh ones', () => {
    const store = new Store(tmpDataDir());
    const topic = store.addTopic(TOPIC);
    seed(store, topic.id, ['Riverside Dam collapse floods three towns', 'Rescue teams reach Riverside Dam flood zone']);
    store.backfillThreads();
    const before = new Map(store.listItems(topic.id).map((i) => [i.id, i.threadId]));
    const cleared = store.clearItemsForTopic(topic.id);
    store.restoreClearedItems(topic.id, cleared);
    expect(new Map(store.listItems(topic.id).map((i) => [i.id, i.threadId]))).toEqual(before);
    expect(store.backfillThreads()).toBe(0);
    store.close();
  });

  it('a mid-history story arriving late is threaded by the next backfill', () => {
    const store = new Store(tmpDataDir());
    const topic = store.addTopic(TOPIC);
    seed(store, topic.id, ['Riverside Dam collapse floods three towns']);
    store.backfillThreads();
    const head = store.listItems(topic.id).at(0);
    // Lands *before* the existing story in time, and unthreaded, which is what a
    // row inserted by an older build looks like.
    store.addItems([
      {
        topicId: topic.id,
        title: 'Riverside Dam flood warning issued',
        summary: 's',
        sources: [],
        dedupeKey: 'late',
        foundAt: at(-DAY),
      },
    ]);
    expect(store.backfillThreads()).toBe(1);
    const items = store.listItems(topic.id);
    // The earliest story names the thread after the replay, so the later one moved.
    expect(new Set(items.map((i) => i.threadId)).size).toBe(1);
    expect(items.find((i) => i.id === head?.id)?.threadId).not.toBe(head?.id);
    // ...and it has settled: a third run changes nothing.
    expect(store.backfillThreads()).toBe(0);
    store.close();
  });

  it('migrates a pre-thread database without losing anything', () => {
    // The regression this pins is data loss, not a missing column: an index on
    // `thread_id` created *before* the migration that adds it makes `openDb`
    // throw `no such column`, which `Store` reads as corruption and answers by
    // backing the file up and starting fresh — silently emptying the app.
    const dir = tmpDataDir();
    const db = new DatabaseSync(dbPath(dir));
    db.exec(`
      CREATE TABLE topics (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, paused INTEGER NOT NULL DEFAULT 0,
        high_priority INTEGER NOT NULL DEFAULT 0, guidance TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL, last_checked_at TEXT, covered_through_at TEXT,
        category TEXT, subcategory TEXT, category_source TEXT NOT NULL DEFAULT 'auto',
        consecutive_failures INTEGER NOT NULL DEFAULT 0, retry_after TEXT
      );
      CREATE TABLE items (
        id TEXT PRIMARY KEY, topic_id TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL,
        sources TEXT NOT NULL, image TEXT, dedupe_key TEXT NOT NULL, found_at TEXT NOT NULL,
        saved INTEGER NOT NULL DEFAULT 0, off_topic INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE runs (
        id TEXT PRIMARY KEY, topic_id TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
        status TEXT NOT NULL, new_items INTEGER NOT NULL DEFAULT 0, error TEXT,
        provider TEXT, model TEXT, usage TEXT, effort TEXT
      );
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO topics (id, name, created_at) VALUES ('t1', 'Flooding', '2026-07-01T00:00:00.000Z');
      INSERT INTO items (id, topic_id, title, summary, sources, dedupe_key, found_at)
        VALUES ('i1', 't1', 'Riverside Dam collapse floods three towns', 's', '[]', 'k1', '2026-07-01T00:00:00.000Z');
      INSERT INTO items (id, topic_id, title, summary, sources, dedupe_key, found_at)
        VALUES ('i2', 't1', 'Rescue teams reach Riverside Dam flood zone', 's', '[]', 'k2', '2026-07-02T00:00:00.000Z');
      PRAGMA user_version = 4;
    `);
    db.close();

    const store = new Store(dir);
    // The stories are still there, each a thread of one to begin with...
    expect(store.listItems('t1').map((i) => i.threadId)).toEqual(['i1', 'i2']);
    // ...and the backfill groups them, as startup would.
    expect(store.backfillThreads()).toBe(1);
    expect(store.threadForItem('i1').map((i) => i.id)).toEqual(['i1', 'i2']);
    // The chain does not stop at this ticket's own migration (NEWS-291). A v4
    // database has to cross **both** v5 (threads) and v6 (the clear baseline) in
    // one open, and the second is exactly the migration that would have been
    // skipped had it also claimed version 5: whichever of the two `MIGRATIONS[4]`
    // held would run, the other would never be reached, and the missing column
    // reads as corruption — the data loss this test already exists to prevent.
    expect(store.getTopic('t1')?.clearedAt, 'never cleared, so null').toBeNull();
    expect(store.getTopic('t1')?.name, 'and the v4 row is intact').toBe('Flooding');
    store.close();

    const reopened = new DatabaseSync(dbPath(dir));
    expect((reopened.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(
      SCHEMA_VERSION,
    );
    // Both columns present, from two different migrations in one open.
    const cols = (reopened.prepare('PRAGMA table_info(items)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain('thread_id');
    const topicCols = (reopened.prepare('PRAGMA table_info(topics)').all() as { name: string }[]).map((c) => c.name);
    expect(topicCols).toContain('cleared_at');
    reopened.close();
  });

  it('migrates a v5 (threads, pre-clear-baseline) database to v6 without losing anything', () => {
    // The other end of the same hazard. A database created by a build that had
    // NEWS-280 but not NEWS-291 sits at v5 with `thread_id` already present, so
    // only `MIGRATIONS[5]` should run — and it must not retry the thread column,
    // because `ALTER TABLE ADD COLUMN` throws on a duplicate and that throw is
    // read as corruption.
    const dir = tmpDataDir();
    const db = new DatabaseSync(dbPath(dir));
    db.exec(`
      CREATE TABLE topics (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, paused INTEGER NOT NULL DEFAULT 0,
        high_priority INTEGER NOT NULL DEFAULT 0, guidance TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL, last_checked_at TEXT, covered_through_at TEXT,
        category TEXT, subcategory TEXT, category_source TEXT NOT NULL DEFAULT 'auto',
        consecutive_failures INTEGER NOT NULL DEFAULT 0, retry_after TEXT
      );
      CREATE TABLE items (
        id TEXT PRIMARY KEY, topic_id TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL,
        sources TEXT NOT NULL, image TEXT, dedupe_key TEXT NOT NULL,
        thread_id TEXT NOT NULL DEFAULT '', found_at TEXT NOT NULL,
        saved INTEGER NOT NULL DEFAULT 0, off_topic INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE runs (
        id TEXT PRIMARY KEY, topic_id TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
        status TEXT NOT NULL, new_items INTEGER NOT NULL DEFAULT 0, error TEXT,
        provider TEXT, model TEXT, usage TEXT, effort TEXT
      );
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO topics (id, name, created_at, last_checked_at)
        VALUES ('t1', 'Flooding', '2026-07-01T00:00:00.000Z', '2026-07-02T00:00:00.000Z');
      INSERT INTO items (id, topic_id, title, summary, sources, dedupe_key, thread_id, found_at)
        VALUES ('i1', 't1', 'Riverside Dam collapse floods three towns', 's', '[]', 'k1', 'i1', '2026-07-01T00:00:00.000Z');
      PRAGMA user_version = 5;
    `);
    db.close();

    const store = new Store(dir);
    const topic = store.getTopic('t1');
    expect(topic?.name).toBe('Flooding');
    expect(topic?.lastCheckedAt, 'its real check time survives').toBe('2026-07-02T00:00:00.000Z');
    expect(topic?.clearedAt, 'and it arrives never-cleared').toBeNull();
    expect(store.listItems('t1').map((i) => i.threadId), 'the v5 thread id is untouched').toEqual(['i1']);
    store.close();

    const reopened = new DatabaseSync(dbPath(dir));
    expect((reopened.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(
      SCHEMA_VERSION,
    );
    reopened.close();

    // And opening again must not re-run it — the duplicate-column throw.
    expect(() => {
      new Store(dir).close();
    }).not.toThrow();
  });

  it('backfills stories whose topic was deleted without throwing', () => {
    const store = new Store(tmpDataDir());
    const topic = store.addTopic(TOPIC);
    seed(store, topic.id, ['Riverside Dam collapse floods three towns', 'Rescue teams reach Riverside Dam flood zone']);
    store.deleteTopic(topic.id);
    // Nothing left to thread, but the pass must survive an orphan too: re-add
    // rows under a topic id no `topics` row has.
    store.addItems([
      { topicId: 'ghost', title: 'Riverside Dam collapse floods three towns', summary: 's', sources: [], dedupeKey: 'g1', foundAt: at(0) },
      { topicId: 'ghost', title: 'Rescue teams reach Riverside Dam flood zone', summary: 's', sources: [], dedupeKey: 'g2', foundAt: at(DAY) },
    ]);
    expect(store.backfillThreads()).toBe(1);
    expect(new Set(store.listItems('ghost').map((i) => i.threadId)).size).toBe(1);
    store.close();
  });
});
