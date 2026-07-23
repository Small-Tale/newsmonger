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
