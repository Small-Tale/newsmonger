import { describe, expect, it } from 'vitest';

import { dialRemaining } from '../../src/client/dial.js';

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
});
