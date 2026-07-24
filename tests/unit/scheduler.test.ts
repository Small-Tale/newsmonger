import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CheckRunner } from '../../src/checks.js';
import { startScheduler } from '../../src/scheduler.js';

function fakeRunner(): { runner: CheckRunner; calls: () => number; resolveAll: () => void } {
  let calls = 0;
  let pending: (() => void)[] = [];
  const runner = {
    checkDue: () => {
      calls += 1;
      return new Promise<void>((resolve) => {
        pending.push(resolve);
      });
    },
  } as unknown as CheckRunner;
  return {
    runner,
    calls: () => calls,
    resolveAll: () => {
      const toResolve = pending;
      pending = [];
      for (const resolve of toResolve) resolve();
    },
  };
}

/** A runner whose checkDue resolves immediately with a queued count each call. */
function countingRunner(counts: number[]): { runner: CheckRunner; calls: () => number } {
  let i = 0;
  let calls = 0;
  const runner = {
    checkDue: () => {
      calls += 1;
      const v = counts[i] ?? 0;
      i += 1;
      return Promise.resolve(v);
    },
  } as unknown as CheckRunner;
  return { runner, calls: () => calls };
}

describe('startScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs a startup sweep and then one sweep per tick', async () => {
    const { runner, calls, resolveAll } = fakeRunner();
    const stop = startScheduler(runner, 60_000);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(calls()).toBe(1);
    resolveAll();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls()).toBe(2);
    resolveAll();
    stop();
  });

  it('skips ticks while a sweep is still running', async () => {
    const { runner, calls, resolveAll } = fakeRunner();
    const stop = startScheduler(runner, 60_000);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(calls()).toBe(1);
    // Sweep never resolves; two more ticks pass.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls()).toBe(1);

    resolveAll();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls()).toBe(2);
    resolveAll();
    stop();
  });

  it('drains: an overrun sweep restarts immediately while work remains (NEWS-57)', async () => {
    // One tick, but checkDue keeps finding work: it should be called back-to-back
    // until a pass returns 0 — no waiting for the next 60s tick between cycles.
    const { runner, calls } = countingRunner([3, 2, 1, 0]);
    const stop = startScheduler(runner, 60_000);

    await vi.advanceTimersByTimeAsync(3_000); // the single startup tick
    expect(calls()).toBe(4); // 3 productive passes + the empty one that stops the drain
    stop();
  });

  it('does not busy-loop when nothing is due (NEWS-57)', async () => {
    const { runner, calls } = countingRunner([0, 0, 0]);
    const stop = startScheduler(runner, 60_000);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(calls()).toBe(1); // one pass returns 0 → idle, not a spin

    // The next tick makes exactly one more pass.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls()).toBe(2);
    stop();
  });

  it('stops ticking after stop() is called', async () => {
    const { runner, calls, resolveAll } = fakeRunner();
    const stop = startScheduler(runner, 60_000);
    await vi.advanceTimersByTimeAsync(3_000);
    resolveAll();
    stop();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(calls()).toBe(1);
  });
});
