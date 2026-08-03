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
