import { describe, expect, it } from 'vitest';

import type { StateResp } from '../../src/api/schemas.js';
import { activeBehindWarnings, isBehindSchedule, topicsBehindSchedule } from '../../src/client/schedule.js';

type Topic = StateResp['topics'][number];

const SETTINGS: StateResp['settings'] = {
  checkIntervalMs: 60 * 60 * 1000, // 1 hour
  highPriorityIntervalMs: 15 * 60 * 1000, // 15 min
  provider: 'auto',
  model: '',
  endpoint: '',
  effort: '',
  backupDir: '',
  location: '',
  profiles: [],
  backupPromptNever: false,
  backupPromptSnoozedUntil: '',
  notifyOnNewItems: false,
  itemRetentionDays: 365,
  scheduleMode: 'interval',
  theme: 'auto',
  dailyTimes: ['08:00'],
  checkConcurrency: 3,
};

const NOW = Date.parse('2026-07-24T12:00:00Z');

function topic(over: Partial<Topic> = {}): Topic {
  return {
    id: 'i',
    name: 'T',
    paused: false,
    highPriority: false,
    guidance: '',
    createdAt: '2026-07-01T00:00:00Z',
    lastCheckedAt: '2026-07-24T11:00:00Z',
    coveredThroughAt: null,
    category: null,
    subcategory: null,
    categorySource: 'auto',
    consecutiveFailures: 0,
    retryAfter: null,
    clearedAt: null,
    ...over,
  };
}

describe('activeBehindWarnings grace (NEWS-67)', () => {
  // A topic 3h stale against a 1h interval — genuinely behind, absent the grace.
  const behindTopic = topic({ lastCheckedAt: '2026-07-24T09:00:00Z' });

  it('suppresses warnings during the grace window', () => {
    // Grace ends in the future → nothing reported, even for an overdue topic.
    expect(activeBehindWarnings([behindTopic], SETTINGS, NOW, NOW + 60_000)).toEqual([]);
  });

  it('reports behind topics once the grace has passed', () => {
    expect(activeBehindWarnings([behindTopic], SETTINGS, NOW, NOW - 1)).toHaveLength(1);
  });

  it('reports nothing when nothing is behind, grace or not', () => {
    const fresh = topic({ lastCheckedAt: '2026-07-24T11:30:00Z' }); // 30 min ago
    expect(activeBehindWarnings([fresh], SETTINGS, NOW, NOW - 1)).toEqual([]);
  });
});

describe('isBehindSchedule (NEWS-59)', () => {
  it('is not behind when checked within 2x the interval', () => {
    // 1h interval; checked 90 min ago → overdue but under the 2h bar.
    expect(isBehindSchedule(topic({ lastCheckedAt: '2026-07-24T10:30:00Z' }), SETTINGS, NOW)).toBe(false);
  });

  it('is behind when overdue by more than a full extra interval', () => {
    // 1h interval; checked 3h ago → well past 2h.
    expect(isBehindSchedule(topic({ lastCheckedAt: '2026-07-24T09:00:00Z' }), SETTINGS, NOW)).toBe(true);
  });

  it('uses the shorter high-priority interval', () => {
    // 15-min HP interval; checked 40 min ago → past 30 min (2x) → behind.
    const t = topic({ highPriority: true, lastCheckedAt: '2026-07-24T11:20:00Z' });
    expect(isBehindSchedule(t, SETTINGS, NOW)).toBe(true);
    // A normal topic at the same age (40 min, 1h interval) is not behind.
    expect(isBehindSchedule(topic({ lastCheckedAt: '2026-07-24T11:20:00Z' }), SETTINGS, NOW)).toBe(false);
  });

  it('excludes paused and never-checked topics', () => {
    expect(isBehindSchedule(topic({ paused: true, lastCheckedAt: '2026-07-20T00:00:00Z' }), SETTINGS, NOW)).toBe(false);
    expect(isBehindSchedule(topic({ lastCheckedAt: null }), SETTINGS, NOW)).toBe(false);
  });
});

describe('topicsBehindSchedule (NEWS-59)', () => {
  it('returns only the behind topics', () => {
    const topics = [
      topic({ id: 'behind', lastCheckedAt: '2026-07-24T08:00:00Z' }), // 4h ago → behind
      topic({ id: 'ok', lastCheckedAt: '2026-07-24T11:30:00Z' }), // 30 min ago → fine
      topic({ id: 'new', lastCheckedAt: null }), // never checked → excluded
    ];
    expect(topicsBehindSchedule(topics, SETTINGS, NOW).map((t) => t.id)).toEqual(['behind']);
  });
});

describe('time the app was not allowed to check does not count (NEWS-247)', () => {
  /**
   * The reported bug, in the reporter's words: *"because the app only checks
   * when the user has foregrounded the app within a reasonably tight time
   * period, the warning shows incorrectly because it thinks not scheduling due
   * to being in the background is the same problem as not running due to
   * requests being too time consuming."*
   *
   * Exactly right, and the advice made it worse — "try fewer topics, a longer
   * interval, or a faster provider" is three suggestions about a problem the
   * user did not have. Nothing was slow. Nothing was permitted to run.
   */
  const HOUR = 60 * 60 * 1000;
  const stale = topic({ lastCheckedAt: new Date(NOW - 25 * HOUR).toISOString() });

  it('warned about a day in the background — the bug', () => {
    // With no notion of what was possible, a day away is indistinguishable from
    // a day of failing to keep up. This is the old behaviour, kept as the
    // contrast the fix is measured against.
    expect(isBehindSchedule(stale, SETTINGS, NOW)).toBe(true);
  });

  it('says nothing when checking only just became possible again', () => {
    // The user came back a minute ago. The topic is genuinely 25 hours stale
    // and there is genuinely nothing wrong: the app has had one minute in which
    // it was allowed to do anything about it.
    expect(isBehindSchedule(stale, SETTINGS, NOW, NOW - 60_000)).toBe(false);
  });

  it('still warns once checking has been possible long enough', () => {
    // The fix must not be a mute button. Three hours attended on a one-hour
    // interval with no check is the real failure this banner exists for, and it
    // still reports — the same topic, the same staleness, a different reason.
    expect(isBehindSchedule(stale, SETTINGS, NOW, NOW - 3 * HOUR)).toBe(true);
  });

  it('never counts time before the topic was last checked', () => {
    // A topic checked ten minutes ago is not behind, however long ago checking
    // became possible. The clock starts at the *later* of the two.
    const fresh = topic({ lastCheckedAt: new Date(NOW - 10 * 60_000).toISOString() });
    expect(isBehindSchedule(fresh, SETTINGS, NOW, NOW - 10 * HOUR)).toBe(false);
  });

  it('defaults to the old behaviour when the server says nothing', () => {
    // Absent `checksPossibleSince` — an older server, or a fixture — means
    // "checking has always been possible", so nothing changes for a caller that
    // does not pass it. A default that silenced the banner would hide real
    // problems on exactly the deployments that cannot report the new field.
    expect(isBehindSchedule(stale, SETTINGS, NOW)).toBe(isBehindSchedule(stale, SETTINGS, NOW, 0));
  });

  it('applies through the list and grace-window wrappers', () => {
    // The banner reads `activeBehindWarnings`, so the fix has to survive both
    // layers — a filter that dropped the argument would leave the bug in place
    // while every unit test above still passed.
    const topics = [stale, topic({ id: 'j', lastCheckedAt: new Date(NOW - 30 * HOUR).toISOString() })];
    expect(topicsBehindSchedule(topics, SETTINGS, NOW, NOW - 60_000)).toEqual([]);
    expect(topicsBehindSchedule(topics, SETTINGS, NOW, NOW - 3 * HOUR)).toHaveLength(2);
    expect(activeBehindWarnings(topics, SETTINGS, NOW, NOW - 1, NOW - 60_000)).toEqual([]);
    expect(activeBehindWarnings(topics, SETTINGS, NOW, NOW - 1, NOW - 3 * HOUR)).toHaveLength(2);
  });

  it('keeps the grace window winning over everything', () => {
    // Grace answers a different question (the interval just changed, NEWS-67).
    // Inside it, nothing is reported regardless of what was possible.
    expect(activeBehindWarnings([stale], SETTINGS, NOW, NOW + 1, NOW - 10 * HOUR)).toEqual([]);
  });
});
