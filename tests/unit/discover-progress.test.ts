import { beforeEach, describe, expect, it } from 'vitest';

import {
  animationDurationMs,
  DEFAULT_TARGET_MS,
  estimateTargetMs,
  readDurations,
  recordDuration,
} from '../../src/client/discover-progress.js';

/** The estimate behind the discovery progress bar (NEWS-137). */

/** Minimal localStorage stand-in — these run in Node, not a browser. */
function installStorage(initial: Record<string, string> = {}): Map<string, string> {
  const store = new Map(Object.entries(initial));
  globalThis.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => {
      store.clear();
    },
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  };
  return store;
}

beforeEach(() => {
  installStorage();
});

describe('estimateTargetMs', () => {
  it('falls back to a stated default with no history', () => {
    expect(estimateTargetMs([])).toBe(DEFAULT_TARGET_MS);
  });

  it('uses the median, not the mean, so one slow call does not poison the rest', () => {
    // A call that hit a rate limit and took a minute shouldn't drag every later
    // estimate up with it — with a sample this small the mean would move a long way.
    const recent = [5000, 5000, 5000, 60_000];
    expect(estimateTargetMs(recent)).toBe(5000);
    const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
    expect(estimateTargetMs(recent)).toBeLessThan(mean);
  });

  it('averages the middle pair for an even sample', () => {
    expect(estimateTargetMs([4000, 6000])).toBe(5000);
  });

  it('clamps absurd values at both ends', () => {
    // A cached-fast or pathologically slow call must not produce a bar that is
    // over before it renders, or one that never visibly moves.
    expect(estimateTargetMs([1])).toBeGreaterThanOrEqual(2000);
    expect(estimateTargetMs([600_000])).toBeLessThanOrEqual(90_000);
  });

  it('ignores junk rather than propagating it', () => {
    expect(estimateTargetMs([Number.NaN, 0, -5])).toBe(DEFAULT_TARGET_MS);
  });
});

describe('the stored history', () => {
  it('round-trips and keeps only the most recent ten', () => {
    let history: number[] = [];
    for (let i = 1; i <= 14; i++) history = recordDuration(i * 1000, history);
    expect(history).toHaveLength(10);
    expect(history[0]).toBe(5000);
    expect(history.at(-1)).toBe(14_000);
    expect(readDurations()).toEqual(history);
  });

  it('reads back nothing from junk rather than throwing', () => {
    installStorage({ 'news:discover-durations': 'not json' });
    expect(readDurations()).toEqual([]);
    installStorage({ 'news:discover-durations': '{"not":"an array"}' });
    expect(readDurations()).toEqual([]);
  });

  it('drops non-numeric entries a hand-edited value might contain', () => {
    installStorage({ 'news:discover-durations': '[1000,"x",null,2000]' });
    expect(readDurations()).toEqual([1000, 2000]);
  });

  it('refuses to record a nonsense duration', () => {
    expect(recordDuration(0, [1000])).toEqual([1000]);
    expect(recordDuration(Number.NaN, [1000])).toEqual([1000]);
  });

  it('survives storage being unavailable', () => {
    // Private browsing throws on setItem. Losing the history costs the default
    // estimate; it must not cost the search.
    globalThis.localStorage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    } as unknown as Storage;
    expect(readDurations()).toEqual([]);
    expect(() => recordDuration(1000, [])).not.toThrow();
  });
});

describe('animationDurationMs', () => {
  it('runs well past the estimate so the bar never sits at the end', () => {
    // The keyframes put ~85% at a third of the animation, so the estimate lands
    // where it looks nearly done — and overrunning creeps rather than stalling.
    expect(animationDurationMs(30_000)).toBeGreaterThan(30_000);
    expect(animationDurationMs(30_000)).toBe(90_000);
  });
});
