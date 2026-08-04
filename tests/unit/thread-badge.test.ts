import { describe, expect, it } from 'vitest';

import type { ThreadSummary } from '../../src/api/schemas.js';
import { dayKeyOf, dayLabel } from '../../src/client/dates.js';
import { threadBadge, threadBadgeLabel, threadExpanderLabel } from '../../src/client/thread-view.js';

// The collapsed card's thread badge (NEWS-283). Without it the timeline is
// invisible — nothing on a collapsed card would say that a click reveals
// anything — so what this label *says* is the whole feature, and it is asserted
// as text rather than through the DOM.

const DAY = 24 * 60 * 60 * 1000;

function summary(over: Partial<ThreadSummary> = {}): ThreadSummary {
  return { position: 4, size: 6, startedAt: new Date(Date.now() - 5 * DAY).toISOString(), ...over };
}

describe('thread badge label (NEWS-283)', () => {
  it('names the story by its place in the thread', () => {
    const at = new Date(Date.now() - 5 * DAY);
    const label = dayLabel(dayKeyOf(at)).toLowerCase();
    expect(threadBadge(summary({ position: 4, startedAt: at.toISOString() }))).toEqual({
      count: '4th update',
      since: label,
    });
    expect(threadBadgeLabel(summary({ position: 4, startedAt: at.toISOString() }))).toBe(`4th update · since ${label}`);
  });

  it('gets the ordinal right, including the teens', () => {
    // 11th/12th/13th are the exceptions every hand-rolled ordinal gets wrong,
    // and a thread that long is exactly where a badge would be read closely.
    const counts = [2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111].map(
      (position) => threadBadge(summary({ position, size: position + 1 }))?.count,
    );
    expect(counts).toEqual([
      '2nd update',
      '3rd update',
      '4th update',
      '11th update',
      '12th update',
      '13th update',
      '21st update',
      '22nd update',
      '23rd update',
      '101st update',
      '111th update',
    ]);
  });

  it('says how many followed the story that started the thread', () => {
    // "1st update" would be wrong: the opening story updated nothing. The useful
    // fact about it is that it was followed up — and its own date is already in
    // the header beside it, so there is no "since" to add.
    expect(threadBadge(summary({ position: 1, size: 4 }))).toEqual({ count: '3 follow-ups', since: '' });
    expect(threadBadge(summary({ position: 1, size: 2 }))).toEqual({ count: '1 follow-up', since: '' });
    expect(threadBadgeLabel(summary({ position: 1, size: 4 }))).toBe('3 follow-ups');
  });

  it('dates the thread in the feed\'s own words, not a third format', () => {
    const now = new Date();
    expect(threadBadgeLabel(summary({ startedAt: now.toISOString() }))).toBe('4th update · since today');
    expect(threadBadgeLabel(summary({ startedAt: new Date(now.getTime() - DAY).toISOString() }))).toBe(
      '4th update · since yesterday',
    );
    // Older than that, the label is `dayLabel`'s absolute form — the same string
    // the feed heads that day's group with.
    const old = new Date('2026-07-01T12:00:00.000Z');
    expect(threadBadgeLabel(summary({ startedAt: old.toISOString() }))).toBe(
      `4th update · since ${dayLabel(dayKeyOf(old)).toLowerCase()}`,
    );
  });

  it('drops the date clause rather than printing half of one', () => {
    expect(threadBadgeLabel(summary({ startedAt: 'not a date' }))).toBe('4th update');
  });

  it('says nothing at all for a thread of one', () => {
    // The point of the badge is that it is *rare*: one on every card would be
    // noise, and would tell the reader nothing about which cards hold history.
    expect(threadBadge(undefined)).toBeNull();
    expect(threadBadge({ position: 1, size: 1, startedAt: new Date().toISOString() })).toBeNull();
    expect(threadBadgeLabel(undefined)).toBe('');
  });
});

describe('the badge is the expander\'s label (NEWS-283)', () => {
  it('says what pressing it does and what it would reveal', () => {
    const s = summary({ startedAt: new Date().toISOString() });
    expect(threadExpanderLabel(s, false)).toBe('Show the story so far — 4th update · since today');
    expect(threadExpanderLabel(s, true)).toBe('Hide the story so far — 4th update · since today');
  });

  it('contains the visible label verbatim (WCAG 2.5.3, Label in Name)', () => {
    // Someone who says what they see and someone who hears the accessible name
    // have to be naming the same control, so the badge text is carried through
    // rather than paraphrased.
    const s = summary();
    expect(threadExpanderLabel(s, false)).toContain(threadBadgeLabel(s));
  });

  it('keeps the plain wording on a card with no thread', () => {
    expect(threadExpanderLabel(undefined, false)).toBe('Show story detail');
    expect(threadExpanderLabel(undefined, true)).toBe('Hide story detail');
  });
});
