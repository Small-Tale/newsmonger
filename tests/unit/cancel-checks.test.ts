import { describe, expect, it } from 'vitest';

import { createMockProvider } from '../../src/ai/providers/mock.js';
import type { CheckResult, NewsProvider } from '../../src/ai/types.js';
import { CheckRunner } from '../../src/checks.js';
import { Store } from '../../src/db/store.js';
import { createApp } from '../../src/server.js';
import { asResolver } from '../helpers/provider.js';
import { tmpDataDir } from '../helpers/tmp.js';

/**
 * Cancelling work that was issued under settings the user has since changed
 * (NEWS-257).
 *
 * The answer coming back would be to a question they have already changed —
 * and on a subscription it is spending quota to produce it.
 */

/** A provider whose check hangs until released, and honours its abort signal. */
function hangingProvider() {
  let started = 0;
  let release: (() => void) | null = null;
  const provider: NewsProvider = {
    ...createMockProvider(),
    checkTopic: (_name, _known, _since, _ctx, signal) =>
      new Promise<CheckResult>((resolve, reject) => {
        started += 1;
        release = () => {
          resolve({ items: [], usage: null });
        };
        signal?.addEventListener('abort', () => {
          reject(new Error('aborted by signal'));
        });
      }),
  };
  return {
    provider,
    starts: () => started,
    release: () => release?.(),
  };
}

function setup(effort = '') {
  const store = new Store(tmpDataDir());
  const hang = hangingProvider();
  // `reissueDelayMs: 0` so the coalescing window does not make these tests wait;
  // production uses 750ms.
  const runner = new CheckRunner(store, asResolver(hang.provider), undefined, null, null, { reissueDelayMs: 0 });
  const app = createApp({ store, runner });
  if (effort !== '') store.updateSettings({ effort: effort as never });
  return { store, runner, app, hang };
}

const settled = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

describe('cancelStaleChecks (NEWS-257)', () => {
  it('aborts a check issued under different settings', async () => {
    const { store, runner, hang } = setup();
    const topic = store.addTopic('Fusion');
    const inFlight = runner.checkTopic(topic.id, { manual: true });
    await settled();
    expect(runner.checking()).toEqual([topic.id]);

    store.updateSettings({ model: 'something-else' });
    runner.cancelStaleChecks();

    // Resolves as "nothing happened" rather than throwing at the caller.
    expect(await inFlight).toBeNull();
    hang.release();
  });

  it('leaves a check alone when the settings did not change', async () => {
    // Cancelling on every settings write would throw away work for an interval
    // or retention edit, which has nothing to do with what is in flight.
    const { store, runner, hang } = setup();
    const topic = store.addTopic('Fusion');
    void runner.checkTopic(topic.id, { manual: true });
    await settled();

    store.updateSettings({ checkIntervalMs: 3_600_000 });
    expect(runner.cancelStaleChecks()).toEqual([]);
    expect(runner.checking()).toEqual([topic.id]);
    hang.release();
  });

  it('records no run at all — a cancellation is not a failure', async () => {
    // `runs` feeds the failure banner and the falling-behind detector. A check
    // the user chose to stop must not raise "Last check for X failed".
    const { store, runner, hang } = setup();
    const topic = store.addTopic('Fusion');
    const inFlight = runner.checkTopic(topic.id, { manual: true });
    await settled();
    expect(store.listRuns(10)).toHaveLength(1); // the 'running' row exists

    store.updateSettings({ provider: 'openai' });
    runner.cancelStaleChecks();
    await inFlight;

    expect(store.listRuns(10)).toEqual([]);
    hang.release();
  });

  it('leaves the topic due, so a scheduled check needs no reissuing', async () => {
    // This is what makes "reissue manual checks only" correct rather than lazy:
    // `lastCheckedAt` is untouched, so the next tick picks the topic up under
    // the new settings on its own.
    const { store, runner, hang } = setup();
    const topic = store.addTopic('Fusion');
    const inFlight = runner.checkTopic(topic.id);
    await settled();

    store.updateSettings({ provider: 'openai' });
    runner.cancelStaleChecks();
    await inFlight;

    expect(store.getTopic(topic.id)?.lastCheckedAt).toBeNull();
    hang.release();
  });

  it('reissues a manual check, and not a scheduled one', async () => {
    const manual = setup();
    const t1 = manual.store.addTopic('Manual');
    void manual.runner.checkTopic(t1.id, { manual: true });
    await settled();
    manual.store.updateSettings({ provider: 'openai' });
    manual.runner.cancelStaleChecks();
    await settled();
    // Started twice: the original and the reissue.
    expect(manual.hang.starts()).toBe(2);
    manual.hang.release();

    const scheduled = setup();
    const t2 = scheduled.store.addTopic('Scheduled');
    void scheduled.runner.checkTopic(t2.id);
    await settled();
    scheduled.store.updateSettings({ provider: 'openai' });
    scheduled.runner.cancelStaleChecks();
    await settled();
    // Started once. Reissuing here would re-spend subscription quota every time
    // someone browsed the dropdowns.
    expect(scheduled.hang.starts()).toBe(1);
    scheduled.hang.release();
  });

  it('coalesces a burst of settings writes into one reissue', async () => {
    // Changing provider is never one write: the client then corrects the model
    // to something the new provider has, and the effort to something that model
    // accepts. Reissuing per write would start and kill the same check three
    // times.
    const { store, runner, hang } = setup();
    const topic = store.addTopic('Fusion');
    void runner.checkTopic(topic.id, { manual: true });
    await settled();

    store.updateSettings({ provider: 'openai' });
    runner.cancelStaleChecks();
    store.updateSettings({ model: 'gpt-5.4-mini' });
    runner.cancelStaleChecks();
    store.updateSettings({ effort: 'low' });
    runner.cancelStaleChecks();
    await settled();

    expect(hang.starts()).toBe(2); // the original, plus exactly one reissue
    hang.release();
  });
});

describe('PATCH /api/settings cancels in-flight work (NEWS-257)', () => {
  it('cancels on a provider change', async () => {
    const { store, runner, app, hang } = setup();
    const topic = store.addTopic('Fusion');
    const inFlight = runner.checkTopic(topic.id, { manual: true });
    await settled();

    const res = await app.request('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'openai' }),
    });
    expect(res.status).toBe(200);
    expect(await inFlight).toBeNull();
    hang.release();
  });

  it('does not cancel on an unrelated settings change', async () => {
    const { store, runner, app, hang } = setup();
    const topic = store.addTopic('Fusion');
    void runner.checkTopic(topic.id, { manual: true });
    await settled();

    await app.request('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemRetentionDays: 30 }),
    });
    await settled();
    expect(runner.checking()).toEqual([topic.id]);
    hang.release();
  });
});
