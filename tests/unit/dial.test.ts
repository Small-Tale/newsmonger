import { describe, expect, it } from 'vitest';

import { dialCountdownMs, dialRemaining, formatCountdown } from '../../src/client/dial.js';

/** The sidebar ring counts down rather than up (NEWS-144). */

const HOUR = 60 * 60 * 1000;
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();

describe('dialRemaining', () => {
  it('is full immediately after a check and empty when one is due', () => {
    expect(dialRemaining({ lastCheckedAt: ago(0), paused: false }, HOUR)).toBeCloseTo(1, 2);
    expect(dialRemaining({ lastCheckedAt: ago(HOUR), paused: false }, HOUR)).toBeCloseTo(0, 2);
  });

  it('drains through the interval rather than filling', () => {
    // The whole point of the change: quarter of the way through the interval
    // leaves three quarters of the ring, not one.
    expect(dialRemaining({ lastCheckedAt: ago(HOUR / 4), paused: false }, HOUR)).toBeCloseTo(0.75, 2);
    expect(dialRemaining({ lastCheckedAt: ago(HOUR / 2), paused: false }, HOUR)).toBeCloseTo(0.5, 2);
  });

  it('stays empty once overdue rather than going negative', () => {
    expect(dialRemaining({ lastCheckedAt: ago(HOUR * 5), paused: false }, HOUR)).toBe(0);
  });

  it('is full for a topic that has never been checked — everything is still to come', () => {
    expect(dialRemaining({ lastCheckedAt: null, paused: false }, HOUR)).toBe(1);
  });

  it('is full while paused, because the interval is not running down', () => {
    // Draining toward a check that will never fire would be a lie.
    expect(dialRemaining({ lastCheckedAt: ago(HOUR * 10), paused: true }, HOUR)).toBe(1);
  });

  it('clamps a timestamp in the future rather than overfilling the ring', () => {
    const future = new Date(Date.now() + HOUR).toISOString();
    expect(dialRemaining({ lastCheckedAt: future, paused: false }, HOUR)).toBe(1);
  });

  it('treats a nonsensical interval as due now rather than dividing by zero', () => {
    expect(dialRemaining({ lastCheckedAt: ago(HOUR), paused: false }, 0)).toBe(0);
    expect(dialRemaining({ lastCheckedAt: ago(HOUR), paused: false }, -1)).toBe(0);
  });

  it('falls back to full on an unparseable timestamp', () => {
    expect(dialRemaining({ lastCheckedAt: 'not a date', paused: false }, HOUR)).toBe(1);
  });

  /**
   * A cleared topic counts down from the clear (NEWS-291).
   *
   * The row's *text* says "not checked yet", which is a claim about the past and
   * is true. The ring is a claim about the future: a check really is coming, one
   * interval after the clear. Leaving it full for a whole day would be the same
   * kind of lie this ticket set out to remove, pointing the other way.
   */
  it('counts down from a clear when there is no check to count from', () => {
    expect(dialRemaining({ lastCheckedAt: null, clearedAt: ago(0), paused: false }, HOUR)).toBeCloseTo(1, 2);
    expect(dialRemaining({ lastCheckedAt: null, clearedAt: ago(HOUR / 2), paused: false }, HOUR)).toBeCloseTo(0.5, 2);
    expect(dialRemaining({ lastCheckedAt: null, clearedAt: ago(HOUR), paused: false }, HOUR)).toBeCloseTo(0, 2);
  });

  it('prefers a check over an older clear', () => {
    // Once a check has run since the clear, it owns the countdown again.
    expect(
      dialRemaining({ lastCheckedAt: ago(HOUR / 4), clearedAt: ago(HOUR * 3), paused: false }, HOUR),
    ).toBeCloseTo(0.75, 2);
  });

  it('is still full for a topic neither checked nor cleared', () => {
    expect(dialRemaining({ lastCheckedAt: null, clearedAt: null, paused: false }, HOUR)).toBe(1);
  });

  it('is still full while paused, even after a clear', () => {
    expect(dialRemaining({ lastCheckedAt: null, clearedAt: ago(HOUR * 10), paused: true }, HOUR)).toBe(1);
  });
});

/**
 * The tooltip shows how long until the next check, not a percentage (NEWS-202).
 *
 * "3% of the interval left before the next check" asked the reader to do
 * arithmetic they had no inputs for — the tooltip never said what the interval
 * was. The ring already shows the proportion; the tooltip's job is the part the
 * ring cannot show.
 */
const MINUTE = 60 * 1000;

describe('dialCountdownMs', () => {
  it('is the whole interval immediately after a check', () => {
    expect(dialCountdownMs({ lastCheckedAt: ago(0), paused: false }, HOUR)).toBeCloseTo(HOUR, -2);
  });

  it('counts down as the interval runs', () => {
    const left = dialCountdownMs({ lastCheckedAt: ago(HOUR * 0.75), paused: false }, HOUR);
    expect(left).not.toBeNull();
    expect(left as number).toBeCloseTo(HOUR * 0.25, -3);
  });

  it('clamps an overdue check to zero rather than going negative', () => {
    // "due now" is the honest reading of an overdue check; a negative countdown
    // would render as "in -12m".
    expect(dialCountdownMs({ lastCheckedAt: ago(HOUR * 3), paused: false }, HOUR)).toBe(0);
  });

  it('caps a future timestamp at the full interval', () => {
    // Clock skew shouldn't promise a check further out than the schedule allows.
    const left = dialCountdownMs({ lastCheckedAt: new Date(Date.now() + HOUR).toISOString(), paused: false }, HOUR);
    expect(left).toBe(HOUR);
  });

  it('is null while paused, because no check is scheduled', () => {
    // Not 0 — that would claim a check is imminent when the interval isn't
    // running at all. The caller shows "Paused" instead.
    expect(dialCountdownMs({ lastCheckedAt: ago(HOUR), paused: true }, HOUR)).toBeNull();
  });

  it('is null before the first check', () => {
    expect(dialCountdownMs({ lastCheckedAt: null, paused: false }, HOUR)).toBeNull();
  });

  it('counts down from a clear, so the tooltip names the real next check (NEWS-291)', () => {
    // `null` here is what makes the caller say "Waiting for first check" — which
    // a cleared topic is not doing. It is waiting for the *next* one, an interval
    // after the clear, and the tooltip should say when.
    const left = dialCountdownMs({ lastCheckedAt: null, clearedAt: ago(HOUR * 0.75), paused: false }, HOUR);
    expect(left).not.toBeNull();
    expect(left as number).toBeCloseTo(HOUR * 0.25, -3);
  });

  it('stays null for a topic neither checked nor cleared', () => {
    // The one case that really is "waiting for the first check".
    expect(dialCountdownMs({ lastCheckedAt: null, clearedAt: null, paused: false }, HOUR)).toBeNull();
  });

  it('is null on an unparseable timestamp', () => {
    expect(dialCountdownMs({ lastCheckedAt: 'not a date', paused: false }, HOUR)).toBeNull();
  });

  it('treats a nonsensical interval as due now rather than dividing by zero', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(dialCountdownMs({ lastCheckedAt: ago(MINUTE), paused: false }, bad)).toBe(0);
    }
  });
});

describe('formatCountdown', () => {
  it('says "due now" only when nothing is left', () => {
    expect(formatCountdown(0)).toBe('due now');
    expect(formatCountdown(-1)).toBe('due now');
  });

  it('distinguishes "under a minute" from "due now"', () => {
    // With 30s left the ring is visibly not empty, so "due now" would have the
    // tooltip contradict what is on screen.
    expect(formatCountdown(30 * 1000)).toBe('in under a minute');
    expect(formatCountdown(59 * 1000)).toBe('in under a minute');
  });

  it('uses the same m/h/d vocabulary as the "checked 23h ago" label beside it', () => {
    expect(formatCountdown(MINUTE)).toBe('in 1m');
    expect(formatCountdown(42 * MINUTE)).toBe('in 42m');
    expect(formatCountdown(59 * MINUTE)).toBe('in 59m');
    expect(formatCountdown(HOUR)).toBe('in 1h');
    expect(formatCountdown(23 * HOUR)).toBe('in 23h');
    expect(formatCountdown(24 * HOUR)).toBe('in 1d');
    expect(formatCountdown(50 * HOUR)).toBe('in 2d');
  });

  it('rounds down at every boundary, never up into a unit that has not arrived', () => {
    // 119 minutes is "in 1h", not "in 2h" — claiming more time than remains is
    // the direction that misleads.
    expect(formatCountdown(119 * MINUTE)).toBe('in 1h');
    expect(formatCountdown(HOUR - 1)).toBe('in 59m');
    expect(formatCountdown(24 * HOUR - 1)).toBe('in 23h');
  });

  it('never emits a percentage', () => {
    // The requirement change, stated as an assertion.
    for (const ms of [0, 30 * 1000, 42 * MINUTE, 5 * HOUR, 100 * HOUR]) {
      expect(formatCountdown(ms)).not.toContain('%');
    }
  });
});
