import { describe, expect, it } from 'vitest';

import {
  backoffDelayMs,
  classifyFailure,
  DEFAULT_BACKOFF,
  FAILURE_COOLDOWN,
  retryAfterMs,
} from '../../src/ai/retry.js';
import { CheckRunner } from '../../src/checks.js';
import { Store } from '../../src/db/store.js';
import { asResolver, fakeProvider, fastRetry, instantRetry, noUsage } from '../helpers/provider.js';
import { tmpDataDir } from '../helpers/tmp.js';

// Retry and rate-limit handling (NEWS-109).

describe('backoffDelayMs', () => {
  // A fixed `random` isolates the schedule from the jitter.
  const noJitter = (): number => 0.5;

  it('is linear: 15s, 30s, 45s', () => {
    expect(backoffDelayMs(1, DEFAULT_BACKOFF, noJitter)).toBe(15_000);
    expect(backoffDelayMs(2, DEFAULT_BACKOFF, noJitter)).toBe(30_000);
    expect(backoffDelayMs(3, DEFAULT_BACKOFF, noJitter)).toBe(45_000);
  });

  it('caps at the maximum however many failures there have been', () => {
    expect(backoffDelayMs(16, DEFAULT_BACKOFF, noJitter)).toBe(240_000);
    expect(backoffDelayMs(500, DEFAULT_BACKOFF, noJitter)).toBe(240_000);
  });

  it('treats attempt 0 or negative as the first retry rather than going backwards', () => {
    expect(backoffDelayMs(0, DEFAULT_BACKOFF, noJitter)).toBe(15_000);
    expect(backoffDelayMs(-5, DEFAULT_BACKOFF, noJitter)).toBe(15_000);
  });

  it('applies jitter symmetrically, within the configured ratio', () => {
    // ±20% of 15s is 12s..18s. The point of jitter is that checks which failed
    // together don't all come back at the same instant.
    expect(backoffDelayMs(1, DEFAULT_BACKOFF, () => 0)).toBe(12_000);
    expect(backoffDelayMs(1, DEFAULT_BACKOFF, () => 1)).toBe(18_000);

    for (let i = 0; i < 200; i++) {
      const d = backoffDelayMs(1, DEFAULT_BACKOFF);
      expect(d).toBeGreaterThanOrEqual(12_000);
      expect(d).toBeLessThanOrEqual(18_000);
    }
  });

  it('never returns a negative delay, even with absurd jitter', () => {
    const wild = { ...DEFAULT_BACKOFF, jitterRatio: 5 };
    for (let i = 0; i < 100; i++) expect(backoffDelayMs(1, wild)).toBeGreaterThanOrEqual(0);
  });
});

describe('classifyFailure', () => {
  it('reads an HTTP status when the SDK supplies one', () => {
    expect(classifyFailure(Object.assign(new Error('x'), { status: 429 }))).toBe('rate-limited');
    expect(classifyFailure(Object.assign(new Error('x'), { status: 500 }))).toBe('retryable');
    expect(classifyFailure(Object.assign(new Error('x'), { status: 503 }))).toBe('retryable');
    expect(classifyFailure(Object.assign(new Error('x'), { status: 408 }))).toBe('retryable');
    // Other 4xx will fail identically however often it is asked.
    expect(classifyFailure(Object.assign(new Error('x'), { status: 401 }))).toBe('fatal');
    expect(classifyFailure(Object.assign(new Error('x'), { status: 400 }))).toBe('fatal');
    expect(classifyFailure(Object.assign(new Error('x'), { status: 404 }))).toBe('fatal');
  });

  it('falls back to the message for the CLI providers, which have no status', () => {
    // claude-cli / codex-cli spawn a process and throw whatever it printed.
    expect(classifyFailure(new Error('Error: rate limit exceeded'))).toBe('rate-limited');
    expect(classifyFailure(new Error('server overloaded, try again'))).toBe('rate-limited');
    expect(classifyFailure(new Error('quota exceeded for this org'))).toBe('rate-limited');
    expect(classifyFailure(new Error('401 Unauthorized'))).toBe('fatal');
    expect(classifyFailure(new Error('invalid api key provided'))).toBe('fatal');
  });

  it('treats an unrecognised failure as retryable', () => {
    // The deliberate bias: an unknown failure is more often a blip than a
    // permanent misconfiguration, and not retrying costs a whole interval of
    // news while retrying costs ninety seconds.
    expect(classifyFailure(new Error('socket hang up'))).toBe('retryable');
    expect(classifyFailure(new Error('ECONNRESET'))).toBe('retryable');
    expect(classifyFailure(new Error(''))).toBe('retryable');
    expect(classifyFailure(undefined)).toBe('retryable');
    expect(classifyFailure({ nonsense: true })).toBe('retryable');
  });

  it('treats the mock provider’s deliberate failure as fatal', () => {
    // Otherwise every failure test in the suite retries three times.
    expect(classifyFailure(new Error('mock news service failure'))).toBe('fatal');
  });
});

describe('retryAfterMs', () => {
  const now = new Date('2026-07-28T00:00:00.000Z');

  it('reads delta-seconds from a plain object of headers', () => {
    expect(retryAfterMs({ headers: { 'retry-after': '30' } }, now)).toBe(30_000);
    expect(retryAfterMs({ headers: { 'Retry-After': '30' } }, now)).toBe(30_000);
  });

  it('reads a Headers instance', () => {
    const headers = new Headers({ 'retry-after': '45' });
    expect(retryAfterMs({ headers }, now)).toBe(45_000);
  });

  it('reads an HTTP date', () => {
    expect(retryAfterMs({ headers: { 'retry-after': 'Tue, 28 Jul 2026 00:01:00 GMT' } }, now)).toBe(60_000);
  });

  it('clamps to the maximum, so a long wait does not hold a concurrency slot', () => {
    // A server asking for an hour is answered by failing this attempt and
    // letting the scheduler come back, not by sleeping for an hour.
    expect(retryAfterMs({ headers: { 'retry-after': '3600' } }, now)).toBe(DEFAULT_BACKOFF.maxMs);
  });

  it('treats a date already in the past as no wait', () => {
    expect(retryAfterMs({ headers: { 'retry-after': 'Mon, 27 Jul 2026 00:00:00 GMT' } }, now)).toBe(0);
  });

  it('returns null when there is nothing usable to read', () => {
    expect(retryAfterMs(new Error('no headers'), now)).toBeNull();
    expect(retryAfterMs({ headers: {} }, now)).toBeNull();
    expect(retryAfterMs({ headers: { 'retry-after': 'soon' } }, now)).toBeNull();
    expect(retryAfterMs({ headers: { 'retry-after': '-5' } }, now)).toBeNull();
    expect(retryAfterMs(null, now)).toBeNull();
  });
});

describe('CheckRunner retry behaviour (NEWS-109)', () => {
  function storeWithTopic(name = 'Fusion'): { store: Store; topicId: string } {
    const store = new Store(tmpDataDir());
    return { store, topicId: store.addTopic(name).id };
  }

  it('retries a transient failure and succeeds', async () => {
    const { store, topicId } = storeWithTopic();
    let calls = 0;
    const flaky = fakeProvider(() => {
      calls += 1;
      return calls < 2 ? Promise.reject(new Error('socket hang up')) : Promise.resolve(noUsage([]));
    });

    const runner = new CheckRunner(store, asResolver(flaky), undefined, null, null, instantRetry);
    expect(await runner.checkTopic(topicId)).toBe(0);
    expect(calls).toBe(2);
    // The run is recorded as a success, because it was one.
    expect(store.listRuns(1)[0]?.status).toBe('succeeded');
  });

  it('gives up after the attempt cap and records the failure', async () => {
    const { store, topicId } = storeWithTopic();
    let calls = 0;
    const broken = fakeProvider(() => {
      calls += 1;
      return Promise.reject(new Error('socket hang up'));
    });

    const runner = new CheckRunner(store, asResolver(broken), undefined, null, null, instantRetry);
    await runner.checkTopic(topicId);
    expect(calls).toBe(DEFAULT_BACKOFF.maxAttempts);
    expect(store.listRuns(1)[0]?.status).toBe('failed');
  });

  it('does not retry a fatal failure', async () => {
    // A bad key fails identically however often it is asked, and repeatedly
    // presenting bad credentials is its own kind of rude.
    const { store, topicId } = storeWithTopic();
    let calls = 0;
    const unauthorized = fakeProvider(() => {
      calls += 1;
      return Promise.reject(Object.assign(new Error('Unauthorized'), { status: 401 }));
    });

    const runner = new CheckRunner(store, asResolver(unauthorized), undefined, null, null, instantRetry);
    await runner.checkTopic(topicId);
    expect(calls).toBe(1);
    expect(store.listRuns(1)[0]?.error).toContain('Unauthorized');
  });

  it('waits the backoff between attempts, in order', async () => {
    const { store, topicId } = storeWithTopic();
    const waits: number[] = [];
    const broken = fakeProvider(() => Promise.reject(new Error('socket hang up')));

    const runner = new CheckRunner(store, asResolver(broken), undefined, null, null, {
      backoff: { ...DEFAULT_BACKOFF, jitterRatio: 0 },
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });
    await runner.checkTopic(topicId);

    // One retry after the first attempt (NEWS-110 cut this from three, since
    // the per-topic cooldown now does the longer waiting without holding a
    // concurrency slot) — and no sleep after the last attempt, which would be
    // pure delay before giving up.
    expect(waits).toEqual([15_000]);
  });

  it('honours Retry-After over the computed backoff', async () => {
    const { store, topicId } = storeWithTopic();
    const waits: number[] = [];
    const limited = fakeProvider(() =>
      Promise.reject(Object.assign(new Error('Too Many Requests'), { status: 429, headers: { 'retry-after': '90' } })),
    );

    const runner = new CheckRunner(store, asResolver(limited), undefined, null, null, {
      backoff: { ...DEFAULT_BACKOFF, jitterRatio: 0 },
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });
    await runner.checkTopic(topicId);

    // The server said 90s; the computed schedule would have said 15/30/45. It
    // knows when the window resets and we are guessing.
    expect(waits).toEqual([90_000]);
  });

  it('pauses scheduled checks for every topic after a rate limit', async () => {
    // The heart of "deal with rate limiting": throttling is account-wide, so a
    // sweep must not answer one 429 by making twenty more requests.
    const store = new Store(tmpDataDir());
    for (const name of ['A', 'B', 'C']) store.addTopic(name);
    let calls = 0;
    const limited = fakeProvider(() => {
      calls += 1;
      return Promise.reject(Object.assign(new Error('Too Many Requests'), { status: 429 }));
    });

    // `fastRetry`, not `instantRetry`: the gate's length comes from the backoff,
    // so a zeroed config would open it again immediately.
    const runner = new CheckRunner(store, asResolver(limited), undefined, null, null, fastRetry);
    await runner.checkDue(new Date());
    const afterFirstSweep = calls;
    expect(afterFirstSweep).toBeGreaterThan(0);

    // A second sweep, still inside the window, must make no requests at all.
    expect(await runner.checkDue(new Date())).toBe(0);
    expect(calls).toBe(afterFirstSweep);
  });

  it('lets a manual check through the gate', async () => {
    // The user asked, and one request is how you find out whether the window
    // has reopened. Only *scheduled* work is paused.
    const store = new Store(tmpDataDir());
    const topicId = store.addTopic('Fusion').id;
    let calls = 0;
    const limited = fakeProvider(() => {
      calls += 1;
      return Promise.reject(Object.assign(new Error('Too Many Requests'), { status: 429 }));
    });

    const runner = new CheckRunner(store, asResolver(limited), undefined, null, null, fastRetry);
    await runner.checkDue(new Date());
    const afterSweep = calls;

    await runner.checkTopic(topicId, { manual: true });
    expect(calls).toBeGreaterThan(afterSweep);
  });

  it('resumes scheduled checks once the window has passed', async () => {
    const store = new Store(tmpDataDir());
    store.addTopic('Fusion');
    let fail = true;
    const provider = fakeProvider(() =>
      fail
        ? Promise.reject(Object.assign(new Error('Too Many Requests'), { status: 429, headers: { 'retry-after': '1' } }))
        : Promise.resolve(noUsage([])),
    );

    const runner = new CheckRunner(store, asResolver(provider), undefined, null, null, fastRetry);
    await runner.checkDue(new Date());

    // Still gated now...
    expect(await runner.checkDue(new Date())).toBe(0);
    // ...but open again once the window has passed.
    fail = false;
    expect(await runner.checkDue(new Date(Date.now() + 2000))).toBe(1);
  });
});

describe('per-topic failure cooldown (NEWS-110)', () => {
  function storeWithTopics(names: string[]): Store {
    const store = new Store(tmpDataDir());
    for (const n of names) store.addTopic(n);
    return store;
  }

  it('grows the cooldown with the failure streak', () => {
    // 2 min, 4, 6 … so a blip recovers on the next tick or two while a provider
    // broken for an hour is asked twice an hour rather than sixty times.
    const noJitter = (): number => 0.5;
    expect(backoffDelayMs(1, FAILURE_COOLDOWN, noJitter)).toBe(120_000);
    expect(backoffDelayMs(2, FAILURE_COOLDOWN, noJitter)).toBe(240_000);
    expect(backoffDelayMs(3, FAILURE_COOLDOWN, noJitter)).toBe(360_000);
    expect(backoffDelayMs(100, FAILURE_COOLDOWN, noJitter)).toBe(30 * 60_000);
  });

  it('is longer than the scheduler tick, or it would be indistinguishable from none', () => {
    expect(FAILURE_COOLDOWN.baseMs).toBeGreaterThan(60_000);
  });

  it('holds a failing topic back from the next sweep, then lets it through', async () => {
    const store = storeWithTopics(['Fusion']);
    let calls = 0;
    const broken = fakeProvider(() => {
      calls += 1;
      return Promise.reject(new Error('socket hang up'));
    });
    const runner = new CheckRunner(store, asResolver(broken), undefined, null, null, instantRetry);

    await runner.checkDue(new Date());
    const afterFirst = calls;
    expect(afterFirst).toBeGreaterThan(0);

    // A tick later, still inside the cooldown: no request at all.
    expect(await runner.checkDue(new Date(Date.now() + 60_000))).toBe(0);
    expect(calls).toBe(afterFirst);

    // Past the cooldown, it runs again — the whole point, versus waiting a
    // full check interval.
    expect(await runner.checkDue(new Date(Date.now() + 4 * 60_000))).toBe(1);
    expect(calls).toBeGreaterThan(afterFirst);
  });

  it('lengthens the cooldown on each consecutive failure', async () => {
    const store = storeWithTopics(['Fusion']);
    const topicId = store.listTopics()[0].id;
    const broken = fakeProvider(() => Promise.reject(new Error('socket hang up')));
    const runner = new CheckRunner(store, asResolver(broken), undefined, null, null, instantRetry);

    await runner.checkTopic(topicId);
    const first = store.getTopic(topicId);
    expect(first?.consecutiveFailures).toBe(1);
    const firstWait = Date.parse(first?.retryAfter ?? '') - Date.now();

    await runner.checkTopic(topicId);
    const second = store.getTopic(topicId);
    expect(second?.consecutiveFailures).toBe(2);
    const secondWait = Date.parse(second?.retryAfter ?? '') - Date.now();

    // ±20% jitter on 2 min and 4 min can't overlap, so this is a safe assertion.
    expect(secondWait).toBeGreaterThan(firstWait);
  });

  it('clears the streak and the cooldown on a success', async () => {
    const store = storeWithTopics(['Fusion']);
    const topicId = store.listTopics()[0].id;
    let fail = true;
    const provider = fakeProvider(() =>
      fail ? Promise.reject(new Error('socket hang up')) : Promise.resolve(noUsage([])),
    );
    const runner = new CheckRunner(store, asResolver(provider), undefined, null, null, instantRetry);

    await runner.checkTopic(topicId);
    expect(store.getTopic(topicId)?.consecutiveFailures).toBe(1);

    fail = false;
    await runner.checkTopic(topicId);
    const after = store.getTopic(topicId);
    // A later failure starts its cooldown from the bottom, not from where the
    // previous streak left off.
    expect(after?.consecutiveFailures).toBe(0);
    expect(after?.retryAfter).toBeNull();
  });

  it('does not hold back a manual check', async () => {
    // The cooldown is about not hammering on a schedule. If the user asks, the
    // outage may well be over — and they are the ones who would know.
    const store = storeWithTopics(['Fusion']);
    const topicId = store.listTopics()[0].id;
    let calls = 0;
    const broken = fakeProvider(() => {
      calls += 1;
      return Promise.reject(new Error('socket hang up'));
    });
    const runner = new CheckRunner(store, asResolver(broken), undefined, null, null, instantRetry);

    await runner.checkTopic(topicId);
    const afterFirst = calls;
    await runner.checkTopic(topicId, { manual: true });
    expect(calls).toBeGreaterThan(afterFirst);
  });

  it('does not set a cooldown for a rate limit — the global gate owns that', async () => {
    // Both would compound into a much longer wait than either meant.
    const store = storeWithTopics(['Fusion']);
    const topicId = store.listTopics()[0].id;
    const limited = fakeProvider(() =>
      Promise.reject(Object.assign(new Error('Too Many Requests'), { status: 429 })),
    );
    const runner = new CheckRunner(store, asResolver(limited), undefined, null, null, fastRetry);

    await runner.checkTopic(topicId);
    expect(store.getTopic(topicId)?.retryAfter).toBeNull();
  });

  it('holds back only the failing topic, not its neighbours', async () => {
    // A per-topic cooldown must stay per-topic: one broken feed shouldn't stop
    // the rest of the sweep. (The global gate is for rate limiting, which is
    // account-wide; this isn't.)
    const store = storeWithTopics(['Broken', 'Fine']);
    const provider = fakeProvider((topicName) =>
      topicName === 'Broken' ? Promise.reject(new Error('socket hang up')) : Promise.resolve(noUsage([])),
    );
    const runner = new CheckRunner(store, asResolver(provider), undefined, null, null, instantRetry);

    await runner.checkDue(new Date());
    const broken = store.listTopics().find((t) => t.name === 'Broken');
    const fine = store.listTopics().find((t) => t.name === 'Fine');
    expect(broken?.retryAfter).not.toBeNull();
    expect(fine?.retryAfter).toBeNull();
    expect(fine?.lastCheckedAt).not.toBeNull();

    // And the cooldown is *honoured* per topic on the next sweep: the healthy
    // one is simply not due yet (it just succeeded), the broken one is held
    // back by its cooldown rather than by the schedule.
    expect(await runner.checkDue(new Date(Date.now() + 60_000))).toBe(0);
    // Past the cooldown, only the broken one comes back — the healthy topic is
    // still inside its normal interval.
    expect(await runner.checkDue(new Date(Date.now() + 4 * 60_000))).toBe(1);
  });
});
