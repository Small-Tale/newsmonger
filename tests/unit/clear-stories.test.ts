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

/**
 * A provider whose check hangs until `release()` is called, so a test can hold a
 * check in flight and act while it is running. Module-scoped because both the
 * NEWS-271 cancellation tests and the NEWS-291 sequence tests need it.
 */
function heldProvider() {
  let release: (items: { items: unknown[]; usage: null }) => void = () => undefined;
  const provider = {
    ...createMockProvider(),
    checkTopic: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  };
  return {
    provider,
    release: (items: unknown[] = []): void => {
      release({ items, usage: null });
    },
  };
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
    expect(await res.json()).toEqual({ cleared: 2, cancelledChecks: 0 });
    expect(store.listItems()).toEqual([]);
  });

  /**
   * Clearing stops checks instead of refusing (NEWS-271).
   *
   * This used to answer 409 — "a check is running, wait for it to finish, then
   * clear" — on the reasoning that a check which computed its "already known"
   * list before the clear would afterwards file only the stories missing from
   * that stale list, leaving a partial set that looks like a half-failed clear.
   *
   * The reasoning was sound and the remedy was wrong: it asked the user to wait
   * out a check that can run for minutes, in order to discard the very stories it
   * was fetching. The stale-list problem is real, so it is solved by **stopping**
   * the check rather than by deferring to it.
   */
  it('stops a running check and clears, rather than refusing', async () => {
    const store = new Store(tmpDataDir());
    const { provider, release } = heldProvider();
    const runner = new CheckRunner(store, asResolver(provider as never));
    const app = createApp({ store, runner });
    const t = store.addTopic('Slow');
    const inFlight = runner.checkTopic(t.id, { manual: true });
    await new Promise((r) => setTimeout(r, 10));
    expect(runner.checking()).toHaveLength(1);

    const res = await app.request('/api/items/clear', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ cancelledChecks: 1 });

    release();
    await inFlight;
    expect(runner.checking()).toHaveLength(0);
  });

  it('throws away results that arrive after the clear', async () => {
    // The half that is invisible until it bites. Aborting the provider call is
    // not enough: between the provider returning and the write there are three
    // awaits (link verification, images, favicons), so a check already past the
    // provider would complete and **refill the feed the user just cleared**.
    const store = new Store(tmpDataDir());
    const { provider, release } = heldProvider();
    const runner = new CheckRunner(store, asResolver(provider as never));
    const app = createApp({ store, runner });
    const t = store.addTopic('Slow');
    const inFlight = runner.checkTopic(t.id, { manual: true });
    await new Promise((r) => setTimeout(r, 10));

    await app.request('/api/items/clear', { method: 'POST' });
    // Now the provider answers — with stories, which is the dangerous case.
    release([
      { title: 'Late story', summary: 'arrived after the clear', sources: [], publishedAt: null, image: null },
    ]);
    await inFlight;

    expect(store.listItems(), 'a cancelled check must not repopulate a cleared feed').toEqual([]);
  });

  it('drops a queued reissue, so nothing repopulates a moment later', async () => {
    // `cancelStaleChecks` (NEWS-257) coalesces manual reissues behind a timer. A
    // clear arriving inside that window would otherwise be undone by the reissue
    // firing straight afterwards — and spend quota doing it.
    const store = new Store(tmpDataDir());
    const { provider, release } = heldProvider();
    // Positional deps before the options bag — my first attempt passed the bag as
    // `attendance` and the reissue crashed on `attendance.record`.
    const runner = new CheckRunner(store, asResolver(provider as never), undefined, null, null, {
      reissueDelayMs: 20,
    });
    const t = store.addTopic('Slow');
    const inFlight = runner.checkTopic(t.id, { manual: true });
    await new Promise((r) => setTimeout(r, 10));

    store.updateSettings({ provider: 'openai' });
    expect(runner.cancelStaleChecks()).toEqual([t.id]); // a reissue is now queued
    runner.cancelAllChecks();

    release();
    await inFlight;
    await new Promise((r) => setTimeout(r, 60)); // past the reissue delay
    expect(runner.checking(), 'the reissue must not have fired').toHaveLength(0);
  });

  it('stops the topics still queued behind the running one', async () => {
    // The half a per-check abort cannot reach. `checkAll` runs a pool over a
    // cursor, so aborting what is in flight says nothing about what has not
    // started — without the epoch check, clearing mid-sweep stops one check and
    // lets the rest run and refill the feed.
    //
    // Written because removing that check broke no test: it was a path I had added
    // and not covered.
    const store = new Store(tmpDataDir());
    let started = 0;
    // An array, not a `let`: TypeScript narrows a `let` assigned only inside a
    // callback to its initial value, so `release?.()` typed as `never` and failed
    // to compile. Element access is not narrowed. (Same trap as NEWS-264.)
    const releases: (() => void)[] = [];
    const runner = new CheckRunner(
      store,
      asResolver({
        ...createMockProvider(),
        checkTopic: () =>
          new Promise((resolve) => {
            started += 1;
            releases.push(() => {
              resolve({ items: [], usage: null });
            });
          }),
      } as never),
    );
    // Concurrency 1, so exactly one check is in flight and the rest are queued.
    store.updateSettings({ checkConcurrency: 1 });
    for (const name of ['A', 'B', 'C', 'D']) store.addTopic(name);

    const sweep = runner.checkAll();
    await new Promise((r) => setTimeout(r, 10));
    expect(started, 'one in flight, three queued').toBe(1);

    runner.cancelAllChecks();
    releases[0]?.();
    await sweep;

    expect(started, 'the queued topics must not have been checked').toBe(1);
    expect(store.listItems()).toEqual([]);
  });

  it('counts nothing when no check is running', async () => {
    const { app } = seeded();
    const res = await app.request('/api/items/clear', { method: 'POST' });
    expect(await res.json()).toMatchObject({ cancelledChecks: 0 });
  });
});

/**
 * Clearing returns a topic to its initial state (NEWS-291) — "almost like
 * removing and readding it", in the owner's words.
 *
 * The first attempt at NEWS-273 left `lastCheckedAt` in place, so the sidebar
 * still read "checked 1d ago" over an empty feed, and the owner rejected it.
 * Nulling it was rejected in turn, because a topic with no check time is **due**
 * and clearing would have started a sweep on the next minute tick — undoing
 * NEWS-271, which had just made clearing *stop* checks.
 *
 * Both constraints hold here: `lastCheckedAt` really does go to null (so every
 * display surface reads as never checked), and `clearedAt` carries the
 * scheduling baseline so due-ness is measured from the clear.
 */
const HOUR = 3_600_000;
const CLEARED_AT = new Date('2026-08-01T12:00:00.000Z');

/** A topic in the most "used" state we can put it in: checked, covered, failing, with stories. */
function usedTopic(store: Store, name = 'Fusion') {
  const t = store.addTopic(name, { guidance: 'safety only' });
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
  store.markTopicChecked(t.id, new Date('2026-07-01T00:00:00Z'));
  store.markTopicCovered(t.id, new Date('2026-07-01T00:00:00Z'));
  // Mid-backoff, with a cooldown reaching far into the future.
  store.recordCheckFailure(t.id, new Date('2099-01-01T00:00:00Z'));
  store.setTopicHighPriority(t.id, true);
  return t;
}

/**
 * The fields that make up "have we checked this topic, and how did it go".
 *
 * Takes the id and looks the topic up, rather than taking a possibly-undefined
 * topic — the lookup is the part every caller would otherwise have to assert its
 * way past, and a thrown error names the problem better than a non-null `!`.
 */
function checkState(store: Store, id: string) {
  const t = store.getTopic(id);
  if (t === undefined) throw new Error(`no such topic: ${id}`);
  return {
    lastCheckedAt: t.lastCheckedAt,
    coveredThroughAt: t.coveredThroughAt,
    consecutiveFailures: t.consecutiveFailures,
    retryAfter: t.retryAfter,
  };
}

/** A topic's `clearedAt`, or a thrown error if the topic is gone. */
function clearedAt(store: Store, id: string): string | null {
  const t = store.getTopic(id);
  if (t === undefined) throw new Error(`no such topic: ${id}`);
  return t.clearedAt;
}

describe('clearing resets a topic to its initial state (NEWS-291)', () => {
  it('leaves exactly the check state a brand-new topic has', () => {
    // The field-by-field audit, as one assertion. A field added to the topic that
    // belongs to "what we have seen" will fail this the moment a clear forgets it,
    // which is the property that makes it worth writing this way rather than as
    // four separate `toBeNull()`s.
    const store = new Store(tmpDataDir());
    const used = usedTopic(store);
    store.clearAllItems(CLEARED_AT);
    const fresh = store.addTopic('Brand New');
    expect(checkState(store, used.id)).toEqual(checkState(store, fresh.id));
  });

  it('nulls lastCheckedAt — the field every "checked N ago" surface reads', () => {
    const store = new Store(tmpDataDir());
    const t = usedTopic(store);
    expect(store.getTopic(t.id)?.lastCheckedAt).not.toBeNull();
    store.clearAllItems(CLEARED_AT);
    expect(store.getTopic(t.id)?.lastCheckedAt).toBeNull();
  });

  it('drops a failure streak and its cooldown', () => {
    // A backoff is a fact about stories we no longer hold. Carrying it into a
    // reset topic would hold back a check nobody has asked for yet — and the
    // cooldown outranks the schedule, so it would have been the *real* reason the
    // topic was not due, hiding whether the baseline works at all.
    const store = new Store(tmpDataDir());
    const t = usedTopic(store);
    expect(store.getTopic(t.id)?.consecutiveFailures).toBe(1);
    store.clearAllItems(CLEARED_AT);
    expect(store.getTopic(t.id)?.consecutiveFailures).toBe(0);
    expect(store.getTopic(t.id)?.retryAfter).toBeNull();
  });

  it('records when the clear happened, as the scheduling baseline', () => {
    const store = new Store(tmpDataDir());
    const t = usedTopic(store);
    store.clearAllItems(CLEARED_AT);
    expect(store.getTopic(t.id)?.clearedAt).toBe(CLEARED_AT.toISOString());
  });

  it('really does clear the dedupe keys — they are the items table', () => {
    // Verified rather than assumed: "which stories have we already seen" has no
    // separate ledger, so there is nothing a clear could miss. If a future change
    // caches those keys anywhere else, this is what notices.
    const store = new Store(tmpDataDir());
    const t = usedTopic(store);
    expect(store.dedupeKeysForTopic(t.id).size).toBe(1);
    store.clearAllItems(CLEARED_AT);
    expect(store.dedupeKeysForTopic(t.id).size).toBe(0);
  });

  it('drops the off-topic examples the prompt was carrying', () => {
    const store = new Store(tmpDataDir());
    const t = usedTopic(store);
    const item = store.listItems()[0];
    store.setItemOffTopic(item.id, true);
    expect(store.offTopicTitlesForTopic(t.id)).toHaveLength(1);
    store.clearAllItems(CLEARED_AT);
    expect(store.offTopicTitlesForTopic(t.id)).toEqual([]);
  });

  it('keeps the preferences: name, guidance, priority, pause, category, age', () => {
    // A clear discards *findings*, not the user's settings for the topic.
    // Re-classifying would also spend a model call to relearn something already
    // known, and would discard a manual classification (FR-22.7).
    const store = new Store(tmpDataDir());
    const t = usedTopic(store);
    store.setTopicPaused(t.id, true);
    store.setTopicCategory(t.id, 'science', 'energy', 'manual');
    store.clearAllItems(CLEARED_AT);
    const after = store.getTopic(t.id);
    expect(after).toMatchObject({
      id: t.id,
      name: 'Fusion',
      guidance: 'safety only',
      highPriority: true,
      paused: true,
      category: 'science',
      subcategory: 'energy',
      categorySource: 'manual',
      createdAt: t.createdAt,
    });
  });

  it('applies the same reset to the per-topic clear', () => {
    // `clearItemsForTopic` (the rename path, NEWS-139) and `clearAllItems` are
    // separate implementations on purpose — so they are held to the same reset.
    const store = new Store(tmpDataDir());
    const t = usedTopic(store);
    store.clearItemsForTopic(t.id, CLEARED_AT);
    expect(checkState(store, t.id)).toEqual({
      lastCheckedAt: null,
      coveredThroughAt: null,
      consecutiveFailures: 0,
      retryAfter: null,
    });
    expect(clearedAt(store, t.id)).toBe(CLEARED_AT.toISOString());
  });

  it('leaves other topics alone when only one is cleared', () => {
    const store = new Store(tmpDataDir());
    const a = usedTopic(store, 'Fusion');
    const b = usedTopic(store, 'Rome');
    store.clearItemsForTopic(a.id, CLEARED_AT);
    const after = store.getTopic(b.id);
    expect(after?.lastCheckedAt).not.toBeNull();
    expect(after?.clearedAt).toBeNull();
    expect(store.dedupeKeysForTopic(b.id).size).toBe(1);
  });
});

/**
 * The regression the whole design turns on: a clear must not start a sweep.
 *
 * `checkDue` returns how many topics it checked, so 0 here is the assertion —
 * and it fails loudly if `lastCheckedAt` is ever nulled without a baseline to
 * replace it.
 */
describe('the scheduler after a clear (NEWS-291)', () => {
  function runnerSetup() {
    const store = new Store(tmpDataDir());
    const provider = createMockProvider();
    const runner = new CheckRunner(store, asResolver(provider));
    const app = createApp({ store, runner });
    store.updateSettings({ checkIntervalMs: HOUR, highPriorityIntervalMs: HOUR });
    return { store, provider, runner, app };
  }

  it('checks nothing on the tick after a clear', async () => {
    const { store, provider, runner, app } = runnerSetup();
    const t = usedTopic(store);
    await app.request('/api/items/clear', { method: 'POST' });
    provider.calls.length = 0;

    const checked = await runner.checkDue(new Date(Date.now() + 60_000));

    expect(checked, 'a clear must not start a sweep a minute later').toBe(0);
    expect(provider.calls, 'and no provider call must have been made').toHaveLength(0);
    expect(store.listItems(), 'so the feed the user cleared stays clear').toEqual([]);
    expect(store.getTopic(t.id)?.lastCheckedAt, 'while still reading as never checked').toBeNull();
  });

  it('does check once a full interval has passed since the clear', async () => {
    // The other half. Without this, "not due" could be permanent and the topic
    // would silently never be checked again.
    const { store, runner, app } = runnerSetup();
    usedTopic(store);
    await app.request('/api/items/clear', { method: 'POST' });

    const checked = await runner.checkDue(new Date(Date.now() + HOUR + 1000));

    expect(checked).toBe(1);
    expect(store.listItems().length).toBeGreaterThan(0);
  });

  it('re-reports the stories the clear discarded, because the dedupe keys went too', async () => {
    // The user's question in NEWS-291, answered end to end: after a clear the
    // topic must be able to find the same news again. The mock returns the same
    // two deterministic stories every call, so a surviving dedupe ledger would
    // show up here as an empty feed.
    const { store, runner, app } = runnerSetup();
    const t = store.addTopic('Fusion');
    await runner.checkTopic(t.id, { manual: true });
    const before = store.listItems().length;
    expect(before).toBeGreaterThan(0);

    await app.request('/api/items/clear', { method: 'POST' });
    await runner.checkDue(new Date(Date.now() + HOUR + 1000));

    expect(store.listItems()).toHaveLength(before);
  });
});

/**
 * Transition-matrix and adversarial sequences (CLAUDE.md requires these for a
 * stateful change). Each one is a *sequence* — the single-operation tests above
 * all pass with a bug that only appears on the second step.
 */
describe('clear sequences (NEWS-291)', () => {
  it('clear → tick → clear again: still nothing checked, baseline moves forward', async () => {
    const store = new Store(tmpDataDir());
    const provider = createMockProvider();
    const runner = new CheckRunner(store, asResolver(provider));
    const app = createApp({ store, runner });
    store.updateSettings({ checkIntervalMs: HOUR, highPriorityIntervalMs: HOUR });
    const t = usedTopic(store);

    await app.request('/api/items/clear', { method: 'POST' });
    const first = clearedAt(store, t.id);
    expect(first).not.toBeNull();
    expect(await runner.checkDue(new Date(Date.now() + 60_000))).toBe(0);

    // Clearing an already-clear app is a no-op the user can perform, and the
    // second clear must not resurrect a check time or leave the baseline behind.
    await new Promise((r) => setTimeout(r, 5));
    await app.request('/api/items/clear', { method: 'POST' });
    const second = clearedAt(store, t.id);
    expect(second).not.toBeNull();
    expect(Date.parse(second ?? '')).toBeGreaterThanOrEqual(Date.parse(first ?? ''));
    expect(store.getTopic(t.id)?.lastCheckedAt).toBeNull();
    expect(await runner.checkDue(new Date(Date.now() + 60_000))).toBe(0);
  });

  it('clear → check → clear: the second clear resets the check the first made possible', async () => {
    const store = new Store(tmpDataDir());
    const runner = new CheckRunner(store, asResolver(createMockProvider()));
    const app = createApp({ store, runner });
    store.updateSettings({ checkIntervalMs: HOUR, highPriorityIntervalMs: HOUR });
    const t = usedTopic(store);

    await app.request('/api/items/clear', { method: 'POST' });
    await runner.checkTopic(t.id, { manual: true });
    // A real check has happened since the clear, so it owns the baseline again.
    expect(store.getTopic(t.id)?.lastCheckedAt).not.toBeNull();

    await app.request('/api/items/clear', { method: 'POST' });
    expect(store.getTopic(t.id)?.lastCheckedAt).toBeNull();
    expect(await runner.checkDue(new Date(Date.now() + 60_000))).toBe(0);
  });

  it('clear → add a topic: the new topic is still due immediately', async () => {
    // A clear must not make the *app* quiet, only the topics it reset. Adding a
    // topic is the one flow that expects an immediate check (FR-1.12).
    const store = new Store(tmpDataDir());
    const runner = new CheckRunner(store, asResolver(createMockProvider()));
    const app = createApp({ store, runner });
    store.updateSettings({ checkIntervalMs: HOUR, highPriorityIntervalMs: HOUR });
    usedTopic(store);
    await app.request('/api/items/clear', { method: 'POST' });

    const fresh = store.addTopic('Brand New');
    const checked = await runner.checkDue(new Date(Date.now() + 60_000));

    expect(checked, 'only the new topic').toBe(1);
    expect(store.listItems().every((i) => i.topicId === fresh.id)).toBe(true);
  });

  it('clear one topic → clear a different one: each keeps its own baseline', () => {
    const store = new Store(tmpDataDir());
    const a = usedTopic(store, 'Fusion');
    const b = usedTopic(store, 'Rome');
    const first = new Date('2026-08-01T00:00:00.000Z');
    const second = new Date('2026-08-02T00:00:00.000Z');

    store.clearItemsForTopic(a.id, first);
    store.clearItemsForTopic(b.id, second);

    expect(store.getTopic(a.id)?.clearedAt).toBe(first.toISOString());
    expect(store.getTopic(b.id)?.clearedAt).toBe(second.toISOString());
  });

  it('clear while a check is in flight leaves no phantom failure behind', async () => {
    // The NEWS-271 path, followed through to where it lands. A cancelled check
    // used to run the failure bookkeeping on its way out, so stopping a check
    // gave the topic a streak of 1 and a two-minute cooldown — arriving a
    // microtask *after* the reset, and so quietly undoing it.
    const store = new Store(tmpDataDir());
    const { provider, release } = heldProvider();
    const runner = new CheckRunner(store, asResolver(provider as never));
    const app = createApp({ store, runner });
    const t = usedTopic(store);
    const inFlight = runner.checkTopic(t.id, { manual: true });
    await new Promise((r) => setTimeout(r, 10));

    await app.request('/api/items/clear', { method: 'POST' });
    release();
    await inFlight;

    expect(checkState(store, t.id), 'the reset must survive the cancelled check landing').toEqual({
      lastCheckedAt: null,
      coveredThroughAt: null,
      consecutiveFailures: 0,
      retryAfter: null,
    });
    expect(store.listRuns(10), 'and a cancellation is not a run').toEqual([]);
  });

  it('a cancelled check records no failure at all (NEWS-257 path)', async () => {
    // The same fix seen from the settings-change side, where the comment already
    // claimed the topic was "left untouched so it stays due" — the cooldown meant
    // it was not.
    const store = new Store(tmpDataDir());
    const { provider, release } = heldProvider();
    const runner = new CheckRunner(store, asResolver(provider as never), undefined, null, null, {
      reissueDelayMs: 10_000,
    });
    const t = store.addTopic('Slow');
    const inFlight = runner.checkTopic(t.id, { manual: true });
    await new Promise((r) => setTimeout(r, 10));

    store.updateSettings({ provider: 'openai' });
    runner.cancelStaleChecks();
    release();
    await inFlight;

    const after = store.getTopic(t.id);
    expect(after?.consecutiveFailures, 'a cancellation is not a failure').toBe(0);
    expect(after?.retryAfter, 'so nothing holds the topic back').toBeNull();
    expect(after?.lastCheckedAt, 'and it is still due, as the comment promises').toBeNull();
  });
});


describe('deleting every topic (FR-31.1, NEWS-328)', () => {
  it('takes the topics, their stories and their runs', async () => {
    const store = new Store(tmpDataDir());
    const runner = new CheckRunner(store, asResolver(createMockProvider()));
    const a = store.addTopic('Alpha');
    store.addTopic('Beta');
    await runner.checkTopic(a.id);
    expect(store.listItems().length).toBeGreaterThan(0);
    expect(store.listRuns(10).length).toBeGreaterThan(0);

    expect(store.deleteAllTopics()).toBe(2);
    expect(store.listTopics()).toEqual([]);
    // A topic owns its stories and its run history, so leaving either behind
    // would be rows nothing can reach — `pruneOrphans` would delete the stories
    // on the next start anyway, which is a slower way to the same place.
    expect(store.listItems()).toEqual([]);
    expect(store.listRuns(10)).toEqual([]);
  });

  it('leaves settings alone', () => {
    // "Delete all topics" is exactly the phrase that raises the fear it means
    // the whole app. It does not: the provider you configured and the schedule
    // you chose are still yours.
    const store = new Store(tmpDataDir());
    store.addTopic('Alpha');
    store.updateSettings({ provider: 'openai', checkConcurrency: 4 });

    store.deleteAllTopics();
    const after = store.getSettings();
    expect(after.provider).toBe('openai');
    expect(after.checkConcurrency).toBe(4);
  });

  it('answers zero on an install with no topics rather than failing', () => {
    expect(new Store(tmpDataDir()).deleteAllTopics()).toBe(0);
  });

  it('is reported through the route, with the checks it stopped', async () => {
    const store = new Store(tmpDataDir());
    const runner = new CheckRunner(store, asResolver(createMockProvider()));
    const app = createApp({ store, runner });
    store.addTopic('Alpha');
    store.addTopic('Beta');

    const res = await app.request('/api/topics/clear', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deleted: number; cancelledChecks: number };
    expect(body.deleted).toBe(2);
    expect(body.cancelledChecks).toBe(0);
    expect(store.listTopics()).toEqual([]);
  });
});
