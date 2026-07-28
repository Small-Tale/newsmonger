import { describe, expect, it } from 'vitest';

import { createMockProvider } from '../../src/ai/providers/index.js';
import { CheckRunner, isDueDaily, isDueUnderSchedule, lastSlotBefore } from '../../src/checks.js';
import type { Settings } from '../../src/db/schemas.js';
import { Store } from '../../src/db/store.js';
import { asResolver } from '../helpers/provider.js';
import { tmpDataDir } from '../helpers/tmp.js';

/** A local-time Date, so tests read the way the feature is specified. */
function local(y: number, m: number, d: number, h: number, min = 0): Date {
  return new Date(y, m - 1, d, h, min, 0, 0);
}

const SETTINGS: Settings = {
  checkIntervalMs: 24 * 60 * 60 * 1000,
  highPriorityIntervalMs: 60 * 60 * 1000,
  scheduleMode: 'daily',
  dailyTimes: ['08:00', '18:00'],
  checkConcurrency: 3,
  provider: 'auto',
  model: '',
  endpoint: '',
  notifyOnNewItems: false,
  itemRetentionDays: 365,
};

describe('lastSlotBefore (NEWS-84)', () => {
  it('picks the most recent slot that has already passed today', () => {
    expect(lastSlotBefore(['08:00', '18:00'], local(2026, 7, 27, 12))).toEqual(local(2026, 7, 27, 8));
    expect(lastSlotBefore(['08:00', '18:00'], local(2026, 7, 27, 19))).toEqual(local(2026, 7, 27, 18));
  });

  it('falls back to yesterday’s last slot before the first of today', () => {
    // At 3am the standing obligation is last night's 18:00, not "nothing" —
    // otherwise a topic last checked two days ago reads as up to date.
    expect(lastSlotBefore(['08:00', '18:00'], local(2026, 7, 27, 3))).toEqual(local(2026, 7, 26, 18));
  });

  it('treats a slot exactly now as passed', () => {
    expect(lastSlotBefore(['08:00'], local(2026, 7, 27, 8))).toEqual(local(2026, 7, 27, 8));
  });

  it('is order-independent — it sorts the times itself', () => {
    expect(lastSlotBefore(['18:00', '08:00'], local(2026, 7, 27, 12))).toEqual(local(2026, 7, 27, 8));
  });

  it('returns null for an empty list, and ignores unparseable entries', () => {
    expect(lastSlotBefore([], local(2026, 7, 27, 12))).toBeNull();
    expect(lastSlotBefore(['nonsense'], local(2026, 7, 27, 12))).toBeNull();
  });
});

describe('isDueDaily (NEWS-84)', () => {
  const times = ['08:00', '18:00'];

  it('is due when the slot has passed and nothing ran since', () => {
    const topic = { paused: false, lastCheckedAt: local(2026, 7, 27, 7).toISOString() };
    expect(isDueDaily(topic, times, local(2026, 7, 27, 9))).toBe(true);
  });

  it('is not due again once the slot has been served', () => {
    const topic = { paused: false, lastCheckedAt: local(2026, 7, 27, 8, 30).toISOString() };
    expect(isDueDaily(topic, times, local(2026, 7, 27, 9))).toBe(false);
    // ...and stays not-due right up until the next slot.
    expect(isDueDaily(topic, times, local(2026, 7, 27, 17, 59))).toBe(false);
    expect(isDueDaily(topic, times, local(2026, 7, 27, 18, 1))).toBe(true);
  });

  it('keeps a slot missed while the app was closed outstanding', () => {
    // Deliberately not "fires at 08:00 exactly": the app may be shut. A missed
    // morning briefing should still be there at lunchtime, not skipped to
    // tomorrow — that is the difference between a schedule and an alarm.
    const topic = { paused: false, lastCheckedAt: local(2026, 7, 25, 18, 5).toISOString() };
    expect(isDueDaily(topic, times, local(2026, 7, 27, 12))).toBe(true);
  });

  it('is always due when never checked, and never due when paused', () => {
    expect(isDueDaily({ paused: false, lastCheckedAt: null }, times, local(2026, 7, 27, 3))).toBe(true);
    expect(isDueDaily({ paused: true, lastCheckedAt: null }, times, local(2026, 7, 27, 12))).toBe(false);
  });
});

describe('isDueUnderSchedule (NEWS-84)', () => {
  const justChecked = local(2026, 7, 27, 11, 30).toISOString();

  it('uses the daily slots for a normal topic', () => {
    const topic = { paused: false, lastCheckedAt: justChecked, highPriority: false };
    expect(isDueUnderSchedule(topic, SETTINGS, local(2026, 7, 27, 12))).toBe(false);
    expect(isDueUnderSchedule(topic, SETTINGS, local(2026, 7, 27, 18, 30))).toBe(true);
  });

  it('keeps a high-priority topic on its interval even in daily mode', () => {
    // "Every 2 hours" is the whole point of the tier (FR-12.4); folding it into
    // a twice-daily schedule would silently make it check *less* often.
    const topic = { paused: false, lastCheckedAt: local(2026, 7, 27, 9).toISOString(), highPriority: true };
    expect(isDueUnderSchedule(topic, SETTINGS, local(2026, 7, 27, 12))).toBe(true);
  });

  it('falls back to the interval when the time list is empty', () => {
    // The mode must never be able to leave a topic unscheduled forever.
    const topic = { paused: false, lastCheckedAt: local(2026, 7, 25, 9).toISOString(), highPriority: false };
    expect(isDueUnderSchedule(topic, { ...SETTINGS, dailyTimes: [] }, local(2026, 7, 27, 12))).toBe(true);
  });

  it('uses the interval in interval mode, as before', () => {
    const topic = { paused: false, lastCheckedAt: justChecked, highPriority: false };
    const interval: Settings = { ...SETTINGS, scheduleMode: 'interval' };
    expect(isDueUnderSchedule(topic, interval, local(2026, 7, 27, 12))).toBe(false);
    expect(isDueUnderSchedule(topic, interval, local(2026, 7, 28, 12))).toBe(true);
  });
});

describe('the daily schedule end to end (NEWS-84)', () => {
  it('runs a sweep once per slot, not once per tick', async () => {
    const store = new Store(tmpDataDir());
    const service = createMockProvider();
    const runner = new CheckRunner(store, asResolver(service));
    store.updateSettings({ scheduleMode: 'daily', dailyTimes: ['08:00'] });
    store.addTopic('Fusion');

    // `checkDue` takes a simulated `now`, but a completed check records the REAL
    // `new Date()`. So every assertion here is really a comparison between the
    // simulated slot and the actual wall clock, and the timeline has to be
    // positioned around "now" rather than written down.
    //
    // Anchoring only the *day* is not enough, and this test has now failed twice
    // for that reason: fixed dates (2026-07-27/28) broke once the date passed
    // them, and a today-relative timeline broke again whenever the suite ran
    // before 08:00, because the recorded time landed *before* the slot it was
    // supposed to satisfy.
    //
    // So the "already checked" assertions use slots in the PAST (yesterday), which
    // the recorded now is guaranteed to be after, and the "due again" assertion
    // uses one in the FUTURE (tomorrow), which it is guaranteed to be before.
    // Nothing here depends on the time of day.
    const today = new Date();
    const at = (dayOffset: number, hour: number, min = 0): Date =>
      new Date(today.getFullYear(), today.getMonth(), today.getDate() + dayOffset, hour, min, 0, 0);

    // Never checked → due immediately.
    expect(await runner.checkDue(at(-1, 9))).toBe(1);
    // Same slot, a minute later: nothing.
    expect(await runner.checkDue(at(-1, 9, 1))).toBe(0);
    // Later the same day, still that 08:00 slot: nothing.
    expect(await runner.checkDue(at(-1, 23))).toBe(0);
    // A slot the recorded check predates: due again.
    expect(await runner.checkDue(at(1, 8, 5))).toBe(1);
  });

  it('sorts and de-duplicates the time list on save', () => {
    const store = new Store(tmpDataDir());
    store.updateSettings({ dailyTimes: ['18:00', '08:00', '08:00'] });
    expect(store.getSettings().dailyTimes).toEqual(['08:00', '18:00']);
  });

  it('defaults a pre-NEWS-84 data file to interval mode', () => {
    // Existing installs must not silently switch to a twice-daily schedule.
    const store = new Store(tmpDataDir());
    expect(store.getSettings().scheduleMode).toBe('interval');
  });
});
