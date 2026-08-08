import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createMockProvider } from '../../src/ai/providers/index.js';
import type { CheckResult } from '../../src/ai/types.js';
import { BACKUP_FILE,Backups } from '../../src/backup.js';
import { byCheckOrder, CheckRunner, effectiveInterval, isDue, scheduleBaseline } from '../../src/checks.js';
import { DataFileSchema } from '../../src/db/schemas.js';
import { afterGrace } from '../helpers/grace.js';
import { asResolver, fakeProvider, noUsage } from '../helpers/provider.js';
import { tmpStore } from '../helpers/tmp.js';


const HOUR = 3_600_000;

describe('isDue', () => {
  const now = new Date('2026-07-23T12:00:00Z');

  it('is due when never checked', () => {
    expect(isDue({ paused: false, lastCheckedAt: null }, HOUR, now)).toBe(true);
  });

  it('is not due while paused, even if overdue', () => {
    expect(isDue({ paused: true, lastCheckedAt: null }, HOUR, now)).toBe(false);
    expect(isDue({ paused: true, lastCheckedAt: '2026-07-23T00:00:00Z' }, HOUR, now)).toBe(false);
  });

  it('is due exactly at the interval boundary and beyond', () => {
    expect(isDue({ paused: false, lastCheckedAt: '2026-07-23T11:00:00Z' }, HOUR, now)).toBe(true);
    expect(isDue({ paused: false, lastCheckedAt: '2026-07-23T11:00:01Z' }, HOUR, now)).toBe(false);
    expect(isDue({ paused: false, lastCheckedAt: '2026-07-23T09:00:00Z' }, HOUR, now)).toBe(true);
  });
});

/**
 * Due-ness after a clear (NEWS-291).
 *
 * The two constraints that look contradictory and both have to hold: a cleared
 * topic must *read* as never checked (NEWS-273), and must not *be* due, or a
 * clear would cancel the checks in flight and start a fresh sweep a minute later
 * — the exact thing NEWS-271 was about.
 */
describe('scheduleBaseline (NEWS-291)', () => {
  const now = new Date('2026-07-23T12:00:00Z');

  it('falls back to the clear when there is no check', () => {
    expect(scheduleBaseline({ lastCheckedAt: null, clearedAt: '2026-07-23T11:00:00Z' })).toBe('2026-07-23T11:00:00Z');
  });

  it('prefers the check, which after a clear can only be the newer of the two', () => {
    // The clear nulls `lastCheckedAt` in the same transaction that sets
    // `clearedAt`, so a non-null check time is always from a check that ran
    // after the clear. That is what makes `??` correct and a max() unnecessary.
    expect(scheduleBaseline({ lastCheckedAt: '2026-07-23T11:30:00Z', clearedAt: '2026-07-23T11:00:00Z' })).toBe(
      '2026-07-23T11:30:00Z',
    );
  });

  it('is null for a topic that has neither been checked nor cleared', () => {
    expect(scheduleBaseline({ lastCheckedAt: null })).toBeNull();
    expect(scheduleBaseline({ lastCheckedAt: null, clearedAt: null })).toBeNull();
  });

  it('a just-cleared topic is NOT due, though it reads as never checked', () => {
    // The regression this whole ticket turns on. If this flips to true, clearing
    // starts a sweep on the next minute tick.
    const cleared = { paused: false, lastCheckedAt: null, clearedAt: '2026-07-23T11:59:00Z' };
    expect(isDue(cleared, HOUR, now)).toBe(false);
    expect(cleared.lastCheckedAt, 'and it still reads as never checked').toBeNull();
  });

  it('becomes due one full interval after the clear, not before', () => {
    const cleared = (at: string) => ({ paused: false, lastCheckedAt: null, clearedAt: at });
    expect(isDue(cleared('2026-07-23T11:00:01Z'), HOUR, now)).toBe(false); // a second short
    expect(isDue(cleared('2026-07-23T11:00:00Z'), HOUR, now)).toBe(true); // exactly an interval
    expect(isDue(cleared('2026-07-22T00:00:00Z'), HOUR, now)).toBe(true); // long overdue
  });

  it('a cleared topic is still not due while paused', () => {
    expect(isDue({ paused: true, lastCheckedAt: null, clearedAt: '2026-07-01T00:00:00Z' }, HOUR, now)).toBe(false);
  });
});

describe('byCheckOrder (NEWS-58)', () => {
  const T = (iso: string | null, highPriority = false) => ({ highPriority, lastCheckedAt: iso });

  it('puts high-priority topics ahead of normal ones', () => {
    // Even a freshly-checked high-priority topic sorts before an overdue normal one.
    expect(byCheckOrder(T('2026-07-24T11:00:00Z', true), T('2026-07-01T00:00:00Z', false))).toBeLessThan(0);
  });

  it('puts never-checked before ever-checked (same priority)', () => {
    expect(byCheckOrder(T(null), T('2026-07-24T00:00:00Z'))).toBeLessThan(0);
    expect(byCheckOrder(T('2026-07-24T00:00:00Z'), T(null))).toBeGreaterThan(0);
  });

  it('puts the oldest lastCheckedAt first among checked, same priority', () => {
    expect(byCheckOrder(T('2026-07-23T00:00:00Z'), T('2026-07-24T00:00:00Z'))).toBeLessThan(0);
  });

  it('does not send a just-cleared topic to the front of the sweep (NEWS-291)', () => {
    // A cleared topic reads as never checked, and ordering on that alone would
    // make it the most overdue thing in the app — ahead of topics that have
    // genuinely been waiting. It sorts by when it was *cleared* instead.
    const cleared = { highPriority: false, lastCheckedAt: null, clearedAt: '2026-07-24T11:00:00Z' };
    const waiting = { highPriority: false, lastCheckedAt: '2026-07-01T00:00:00Z' };
    expect(byCheckOrder(cleared, waiting)).toBeGreaterThan(0);
    expect(byCheckOrder(waiting, cleared)).toBeLessThan(0);
    // …but a genuinely never-touched topic still leads.
    expect(byCheckOrder(T(null), cleared)).toBeLessThan(0);
  });

  it('sorts a mixed set: high-priority (stalest-first) then normal (stalest-first)', () => {
    const topics = [
      T('2026-07-24T00:00:00Z', false), // normal, recent
      T(null, false), // normal, never checked
      T('2026-07-24T06:00:00Z', true), // high, recent
      T('2026-07-20T00:00:00Z', true), // high, older
    ];
    const order = [...topics].sort(byCheckOrder);
    expect(order).toEqual([
      T('2026-07-20T00:00:00Z', true), // high + oldest
      T('2026-07-24T06:00:00Z', true), // high
      T(null, false), // normal never-checked
      T('2026-07-24T00:00:00Z', false), // normal recent
    ]);
  });
});

describe('effectiveInterval (NEWS-56)', () => {
  const settings = { checkIntervalMs: 24 * HOUR, highPriorityIntervalMs: HOUR };

  it('uses the default interval for a normal topic', () => {
    expect(effectiveInterval({ highPriority: false }, settings)).toBe(24 * HOUR);
  });

  it('uses the shorter high-priority interval for a flagged topic', () => {
    expect(effectiveInterval({ highPriority: true }, settings)).toBe(HOUR);
  });
});

describe('CheckRunner', () => {
  it('adds found items and records a succeeded run', async () => {
    const store = tmpStore();
    const runner = new CheckRunner(store, asResolver(createMockProvider()));
    const topic = store.addTopic('Fusion');

    const added = await runner.checkTopic(topic.id);
    expect(added).toBe(2);
    expect(store.listItems(topic.id)).toHaveLength(2);
    expect(store.getTopic(topic.id)?.lastCheckedAt).not.toBeNull();
    const run = store.listRuns().at(0);
    expect(run?.status).toBe('succeeded');
    expect(run?.newItems).toBe(2);
  });

  /**
   * The backup must include the stories the check just added, not the state
   * from before it — the whole point is that a snapshot is current.
   */
  it('writes a backup after a successful check, once per hour (NEWS-192)', async () => {
    const store = tmpStore();
    const dest = path.join(store.dataDir, 'backups');
    store.updateSettings({ backupDir: dest });
    let now = Date.now();
    const backups = new Backups(
      store,
      () => store.getSettings().backupDir,
      () => now,
    );
    const runner = new CheckRunner(store, asResolver(createMockProvider()), undefined, null, null, { backups });
    const topic = store.addTopic('Fusion');

    await runner.checkTopic(topic.id);
    const at = path.join(dest, BACKUP_FILE);
    const backup = DataFileSchema.parse(JSON.parse(fs.readFileSync(at, 'utf8')));
    expect(backup.items).toHaveLength(2);

    // A second topic checked moments later does not rewrite it...
    const mtime = fs.statSync(at).mtimeMs;
    await runner.checkTopic(store.addTopic('Optics').id);
    expect(fs.statSync(at).mtimeMs).toBe(mtime);

    // ...but an hour on, it does, and picks up the new topic.
    now += 60 * 60 * 1000 + 1;
    await runner.checkTopic(store.addTopic('Radio').id);
    const later = DataFileSchema.parse(JSON.parse(fs.readFileSync(at, 'utf8')));
    expect(later.topics.map((t) => t.name).sort()).toEqual(['Fusion', 'Optics', 'Radio']);
  });

  /** A backup that cannot be written must not fail the check that triggered it. */
  it('survives a broken backup destination (NEWS-192)', async () => {
    const store = tmpStore();
    const blocked = path.join(store.dataDir, 'not-a-folder');
    fs.writeFileSync(blocked, 'x');
    store.updateSettings({ backupDir: blocked });
    const runner = new CheckRunner(store, asResolver(createMockProvider()), undefined, null, null, {
      backups: new Backups(
        store,
        () => store.getSettings().backupDir,
        () => Date.now(),
        () => {
          /* quiet */
        },
      ),
    });
    const topic = store.addTopic('Fusion');
    expect(await runner.checkTopic(topic.id)).toBe(2);
    expect(store.listRuns().at(0)?.status).toBe('succeeded');
  });

  it('deduplicates on a second check (same stories found again)', async () => {
    const store = tmpStore();
    const runner = new CheckRunner(store, asResolver(createMockProvider()));
    const topic = store.addTopic('Fusion');

    await runner.checkTopic(topic.id);
    const secondAdded = await runner.checkTopic(topic.id);
    expect(secondAdded).toBe(0);
    expect(store.listItems(topic.id)).toHaveLength(2);
  });

  it('passes known items and last-checked to the service', async () => {
    const store = tmpStore();
    const service = createMockProvider();
    const runner = new CheckRunner(store, asResolver(service));
    const topic = store.addTopic('Fusion');

    await runner.checkTopic(topic.id);
    expect(service.calls[0]?.known).toEqual([]);
    expect(service.calls[0]?.sinceIso).toBeNull();

    await runner.checkTopic(topic.id);
    expect(service.calls[1]?.known.map((k) => k.title)).toHaveLength(2);
    expect(service.calls[1]?.sinceIso).not.toBeNull();
  });

  it('records a failed run with the error, and still advances lastCheckedAt', async () => {
    const store = tmpStore();
    const runner = new CheckRunner(store, asResolver(createMockProvider()));
    const topic = store.addTopic('this will fail');

    const added = await runner.checkTopic(topic.id);
    expect(added).toBe(0);
    const run = store.listRuns().at(0);
    expect(run?.status).toBe('failed');
    expect(run?.error).toMatch(/mock news service failure/);
    expect(store.getTopic(topic.id)?.lastCheckedAt).not.toBeNull();
  });

  it('returns null for unknown topics', async () => {
    const store = tmpStore();
    const runner = new CheckRunner(store, asResolver(createMockProvider()));
    expect(await runner.checkTopic('nope')).toBeNull();
  });

  it('ignores a second concurrent check for the same topic', async () => {
    const store = tmpStore();
    let release: (result: CheckResult) => void = () => undefined;
    let callCount = 0;
    const blocking = fakeProvider(() => {
      callCount += 1;
      return new Promise<CheckResult>((resolve) => {
        release = resolve;
      });
    });
    const runner = new CheckRunner(store, asResolver(blocking));
    const topic = store.addTopic('Slow');

    const first = runner.checkTopic(topic.id);
    expect(runner.checking()).toEqual([topic.id]);
    const second = await runner.checkTopic(topic.id);
    expect(second).toBeNull();
    expect(callCount).toBe(1);

    release(noUsage([]));
    expect(await first).toBe(0);
    expect(runner.checking()).toEqual([]);
  });

  it('drops results when the topic was deleted mid-check', async () => {
    const store = tmpStore();
    let release: (result: CheckResult) => void = () => undefined;
    const blocking = fakeProvider(
      () =>
        new Promise<CheckResult>((resolve) => {
          release = resolve;
        }),
    );
    const runner = new CheckRunner(store, asResolver(blocking));
    const topic = store.addTopic('Doomed');

    const pending = runner.checkTopic(topic.id);
    // Let the check progress past `await resolveProvider()` into checkTopic
    // (where `release` gets assigned) before we delete + release.
    await new Promise((r) => setTimeout(r, 0));
    store.deleteTopic(topic.id);
    release(noUsage([{ title: 'late', summary: 's', sources: [] }]));
    await pending;
    expect(store.listItems()).toEqual([]);
  });

  it('checkDue only checks due, unpaused topics', async () => {
    const store = tmpStore();
    const service = createMockProvider();
    const runner = new CheckRunner(store, asResolver(service));
    store.updateSettings({ checkIntervalMs: HOUR });

    const fresh = store.addTopic('Fresh');
    store.markTopicChecked(fresh.id, new Date());
    const paused = store.addTopic('Paused');
    store.setTopicPaused(paused.id, true);
    store.addTopic('Due');

    await runner.checkDue(afterGrace());
    expect(service.calls.map((c) => c.topicName)).toEqual(['Due']);
  });

  it('checkDue services topics most-overdue-first, high-priority ahead (NEWS-58)', async () => {
    const store = tmpStore();
    const service = createMockProvider();
    const runner = new CheckRunner(store, asResolver(service));
    store.updateSettings({ checkIntervalMs: HOUR });

    // Insertion order deliberately unlike the intended check order.
    const recent = store.addTopic('RecentNormal');
    const stale = store.addTopic('StaleNormal');
    const hot = store.addTopic('Hot');
    store.setTopicHighPriority(hot.id, true);
    const t0 = Date.parse('2026-07-24T00:00:00Z');
    store.markTopicChecked(recent.id, new Date(t0 - 2 * HOUR)); // due, least stale
    store.markTopicChecked(stale.id, new Date(t0 - 10 * HOUR)); // due, most stale
    store.markTopicChecked(hot.id, new Date(t0 - 2 * HOUR)); // due, high priority

    await runner.checkDue(new Date(t0));
    // High-priority first, then the stalest normal, then the least-stale normal.
    expect(service.calls.map((c) => c.topicName)).toEqual(['Hot', 'StaleNormal', 'RecentNormal']);
  });

  it('checkDue runs a high-priority topic on the shorter interval (NEWS-56)', async () => {
    const store = tmpStore();
    const service = createMockProvider();
    const runner = new CheckRunner(store, asResolver(service));
    // Default 1 day, high-priority 1 hour.
    store.updateSettings({ checkIntervalMs: 24 * HOUR, highPriorityIntervalMs: HOUR });

    const normal = store.addTopic('Normal');
    const hot = store.addTopic('Hot');
    store.setTopicHighPriority(hot.id, true);
    const t0 = new Date('2026-07-24T00:00:00Z');
    store.markTopicChecked(normal.id, t0);
    store.markTopicChecked(hot.id, t0);

    // 2 hours later: past the 1h high-priority interval, well short of the 1-day default.
    await runner.checkDue(new Date(t0.getTime() + 2 * HOUR));
    expect(service.calls.map((c) => c.topicName)).toEqual(['Hot']);

    // A full day later, the normal topic comes due too.
    service.calls.length = 0;
    store.markTopicChecked(hot.id, new Date(t0.getTime() + 2 * HOUR)); // keep hot recent
    await runner.checkDue(new Date(t0.getTime() + 25 * HOUR));
    expect(service.calls.map((c) => c.topicName)).toContain('Normal');
  });

  it('checkAll checks every unpaused topic regardless of due time', async () => {
    const store = tmpStore();
    const service = createMockProvider();
    const runner = new CheckRunner(store, asResolver(service));

    const a = store.addTopic('A');
    store.markTopicChecked(a.id, new Date());
    const paused = store.addTopic('Paused one');
    store.setTopicPaused(paused.id, true);
    store.addTopic('B');

    await runner.checkAll();
    expect(service.calls.map((c) => c.topicName).sort()).toEqual(['A', 'B']);
  });






  it('pause -> unpause sequence: checks resume after unpausing', async () => {
    const store = tmpStore();
    const service = createMockProvider();
    const runner = new CheckRunner(store, asResolver(service));
    store.updateSettings({ checkIntervalMs: HOUR });
    const topic = store.addTopic('Wave');

    await runner.checkDue(afterGrace());
    expect(service.calls).toHaveLength(1);

    store.setTopicPaused(topic.id, true);
    await runner.checkDue(afterGrace(2 * HOUR));
    expect(service.calls).toHaveLength(1);

    store.setTopicPaused(topic.id, false);
    await runner.checkDue(afterGrace(2 * HOUR));
    expect(service.calls).toHaveLength(2);
  });
});
