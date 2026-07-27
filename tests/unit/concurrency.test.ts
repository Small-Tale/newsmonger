import { describe, expect, it } from 'vitest';

import type { CheckResult } from '../../src/ai/types.js';
import { CheckRunner } from '../../src/checks.js';
import { Store } from '../../src/db/store.js';
import { asResolver, fakeProvider, noUsage } from '../helpers/provider.js';
import { tmpDataDir } from '../helpers/tmp.js';

/**
 * A provider that records concurrency and finishes after `delayMs`, so a sweep
 * can be observed rather than only its result inspected.
 */
function tracking(delayMs = 5) {
  const state = { inFlight: 0, peak: 0, started: [] as string[] };
  const provider = fakeProvider((topicName): Promise<CheckResult> => {
    state.inFlight += 1;
    state.peak = Math.max(state.peak, state.inFlight);
    state.started.push(topicName);
    return new Promise<CheckResult>((resolve) => {
      setTimeout(() => {
        state.inFlight -= 1;
        resolve(noUsage([]));
      }, delayMs);
    });
  });
  return { provider, state };
}

function storeWith(names: string[]) {
  const store = new Store(tmpDataDir());
  for (const name of names) store.addTopic(name);
  return store;
}

const NAMES = ['A', 'B', 'C', 'D', 'E', 'F'];

describe('bounded-concurrency sweeps (NEWS-81)', () => {
  it('runs several topics at once, up to the cap', async () => {
    const store = storeWith(NAMES);
    store.updateSettings({ checkConcurrency: 3 });
    const { provider, state } = tracking();

    await new CheckRunner(store, asResolver(provider)).checkDue(new Date());

    expect(state.started).toHaveLength(6);
    expect(state.peak).toBe(3);
  });

  it('never exceeds the cap, whatever the cap is', async () => {
    for (const limit of [1, 2, 6]) {
      const store = storeWith(NAMES);
      store.updateSettings({ checkConcurrency: limit });
      const { provider, state } = tracking();
      await new CheckRunner(store, asResolver(provider)).checkDue(new Date());
      expect(state.peak, `cap ${String(limit)}`).toBeLessThanOrEqual(limit);
    }
  });

  it('is strictly sequential at a cap of 1, exactly as before', async () => {
    const store = storeWith(NAMES);
    store.updateSettings({ checkConcurrency: 1 });
    const { provider, state } = tracking();
    await new CheckRunner(store, asResolver(provider)).checkDue(new Date());
    expect(state.peak).toBe(1);
  });

  it('does not spin up more workers than there are topics', async () => {
    const store = storeWith(['Only one']);
    store.updateSettings({ checkConcurrency: 8 });
    const { provider, state } = tracking();
    await new CheckRunner(store, asResolver(provider)).checkDue(new Date());
    expect(state.peak).toBe(1);
  });

  it('starts topics in priority order even though they finish in any order', async () => {
    // byCheckOrder still decides who *begins* first (NEWS-58); completion order
    // is irrelevant, and nothing downstream depends on it.
    const store = storeWith(['Normal', 'Urgent']);
    store.updateSettings({ checkConcurrency: 1 });
    const urgent = store.listTopics().find((t) => t.name === 'Urgent');
    store.setTopicHighPriority(urgent?.id ?? '', true);
    const { provider, state } = tracking();

    await new CheckRunner(store, asResolver(provider)).checkDue(new Date());
    expect(state.started[0]).toBe('Urgent');
  });

  it('returns the number checked, so the scheduler can drain an overrun cycle', async () => {
    // NEWS-57 depends on this count; parallelising must not break it.
    const store = storeWith(NAMES);
    store.updateSettings({ checkConcurrency: 3 });
    const { provider } = tracking();
    expect(await new CheckRunner(store, asResolver(provider)).checkDue(new Date())).toBe(6);
  });

  it('keeps every topic’s stories when several finish at once', async () => {
    // The single-file store is safe because every mutation is synchronous —
    // `addItems` runs to completion, save included, before the event loop can
    // hand control to another check. This pins that: six concurrent
    // completions, no lost writes.
    const store = storeWith(NAMES);
    store.updateSettings({ checkConcurrency: 6 });
    const provider = fakeProvider((topicName) =>
      Promise.resolve(
        noUsage([{ title: `${topicName} story`, summary: 's', sources: [{ title: 's', url: `https://x.test/${topicName}` }] }]),
      ),
    );

    await new CheckRunner(store, asResolver(provider)).checkAll();

    expect(store.listItems()).toHaveLength(6);
    expect(store.listItems().map((i) => i.title).sort()).toEqual(NAMES.map((n) => `${n} story`).sort());
  });

  it('reports every in-flight topic, not just one', async () => {
    // `/api/state.checking` drives the sidebar spinners; with a parallel sweep
    // it has to show all of them or the UI lies about what's happening.
    const store = storeWith(NAMES);
    store.updateSettings({ checkConcurrency: 3 });
    const { provider } = tracking(30);
    const runner = new CheckRunner(store, asResolver(provider));

    const sweep = runner.checkDue(new Date());
    await new Promise((r) => setTimeout(r, 10));
    expect(runner.checking()).toHaveLength(3);
    await sweep;
    expect(runner.checking()).toHaveLength(0);
  });

  it('still records a run per topic, and one failure doesn’t take the sweep down', async () => {
    const store = storeWith(['A', 'fail me', 'C']);
    store.updateSettings({ checkConcurrency: 3 });
    const provider = fakeProvider((topicName) =>
      topicName.includes('fail')
        ? Promise.reject(new Error('boom'))
        : Promise.resolve(noUsage([])),
    );

    expect(await new CheckRunner(store, asResolver(provider)).checkDue(new Date())).toBe(3);
    const runs = store.listRuns(10);
    expect(runs).toHaveLength(3);
    expect(runs.filter((r) => r.status === 'failed')).toHaveLength(1);
    expect(runs.filter((r) => r.status === 'succeeded')).toHaveLength(2);
  });

  it('clamps a stored value outside the allowed range rather than refusing to load', () => {
    const store = new Store(tmpDataDir());
    store.updateSettings({ checkConcurrency: 3 });
    expect(store.getSettings().checkConcurrency).toBe(3);
    // Default for a file that predates the setting.
    expect(new Store(tmpDataDir()).getSettings().checkConcurrency).toBe(3);
  });
});
