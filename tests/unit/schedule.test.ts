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
  notifyOnNewItems: false,
  monthlyBudgetUsd: 0,
  itemRetentionDays: 365,
  scheduleMode: 'interval',
  dailyTimes: ['08:00'],
  checkConcurrency: 3,
  priceManifestUrl: '',
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
