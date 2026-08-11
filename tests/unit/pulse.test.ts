import { describe, expect, test } from 'vitest';

import { type NewsItem, NewsItemSchema, type Topic,TopicSchema } from '../../src/db/schemas.js';
import { analyzePulse, topicSparklines } from '../../src/pulse.js';

function topic(id: string, category: string | null = 'environment', subcategory: string | null = 'energy'): Topic {
  return TopicSchema.parse({
    id,
    name: id,
    paused: false,
    guidance: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastCheckedAt: null,
    category,
    subcategory,
  });
}

function item(
  id: string,
  topicId: string,
  foundAt: string,
  init: { threadId?: string; outlet?: string | null; offTopic?: boolean; url?: string } = {},
): NewsItem {
  return NewsItemSchema.parse({
    id,
    topicId,
    title: `Story ${id}`,
    summary: `Summary ${id}`,
    saved: false,
    offTopic: init.offTopic ?? false,
    sources:
      init.outlet === null
        ? []
        : [{ title: `Source ${id}`, url: init.url ?? `https://${id}.example/story`, outlet: init.outlet }],
    image: null,
    dedupeKey: id,
    threadId: init.threadId ?? id,
    foundAt,
  });
}

function localIso(now: Date, offsetDays: number): string {
  const value = new Date(now);
  value.setDate(value.getDate() + offsetDays);
  return value.toISOString();
}

describe('topic pulse analysis', () => {
  const now = new Date(2026, 7, 11, 12, 0, 0);
  const energy = topic('Energy');
  const climate = topic('Climate', 'environment', 'climate');

  test('uses the complete window, excludes flagged stories, and counts one primary source per story', () => {
    const items = [
      item('first', energy.id, localIso(now, -29), { threadId: 'thread', outlet: 'Reuters' }),
      item('update', energy.id, localIso(now, -2), { threadId: 'thread', outlet: 'Reuters' }),
      item('other', energy.id, localIso(now, -1), { outlet: 'Grid Journal' }),
      item('unsourced', energy.id, localIso(now, 0), { outlet: null }),
      item('previous', energy.id, localIso(now, -31), { outlet: 'Archive Wire' }),
      item('flagged', energy.id, localIso(now, 0), { offTopic: true, outlet: 'Reuters' }),
      item('different-topic', climate.id, localIso(now, 0), { outlet: 'Climate Desk' }),
    ];

    const pulse = analyzePulse(items, [energy, climate], { kind: 'topic', id: energy.id, label: energy.name }, 30, now);

    expect(pulse.storyCount).toBe(4);
    expect(pulse.previousStoryCount).toBe(1);
    expect(pulse.activeThreads).toBe(3);
    expect(pulse.distinctOutlets).toBe(2);
    expect(pulse.sourcedStories).toBe(3);
    expect(pulse.topSourceShare).toBeCloseTo(2 / 3);
    expect(pulse.sources[0]).toMatchObject({ label: 'Reuters', count: 2 });
    expect(pulse.series).toHaveLength(30);
    expect(pulse.series.reduce((sum, point) => sum + point.stories, 0)).toBe(4);
    expect(pulse.series.reduce((sum, point) => sum + point.updates, 0)).toBe(1);
    expect(pulse.threads).toEqual([
      expect.objectContaining({ id: 'thread', updates: 1, title: 'Story update' }),
    ]);
    expect(pulse.smallSample).toBe(true);
  });

  test('category and subcategory scopes aggregate only matching topics', () => {
    const items = [
      item('energy-1', energy.id, localIso(now, 0), { outlet: 'One' }),
      item('climate-1', climate.id, localIso(now, 0), { outlet: 'Two' }),
    ];
    const whole = analyzePulse(
      items,
      [energy, climate],
      { kind: 'category', id: 'environment', subcategory: null, label: 'Environment' },
      7,
      now,
    );
    const subcategory = analyzePulse(
      items,
      [energy, climate],
      { kind: 'category', id: 'environment', subcategory: 'energy', label: 'Environment · Energy' },
      7,
      now,
    );

    expect(whole.storyCount).toBe(2);
    expect(subcategory.storyCount).toBe(1);
    expect(subcategory.scope.subcategory).toBe('energy');
  });

  test('handles empty and refill sequences without false precision', () => {
    const empty = analyzePulse([], [energy], { kind: 'topic', id: energy.id, label: energy.name }, 7, now);
    expect(empty).toMatchObject({
      storyCount: 0,
      trendPercent: null,
      topSourceShare: null,
      distinctOutlets: 0,
      smallSample: true,
    });
    expect(empty.cadence).toMatchObject({ averageDays: null, longestQuietDays: 7, mostActiveDate: null });

    const refilled = analyzePulse(
      [item('today', energy.id, localIso(now, 0), { outlet: null })],
      [energy],
      { kind: 'topic', id: energy.id, label: energy.name },
      7,
      now,
    );
    expect(refilled.storyCount).toBe(1);
    expect(refilled.topSourceShare).toBeNull();
    expect(refilled.cadence.mostActiveCount).toBe(1);
  });

  test('builds fixed seven-day rail series for every topic', () => {
    const result = topicSparklines(
      [item('old', energy.id, localIso(now, -8)), item('recent', energy.id, localIso(now, 0))],
      [energy, climate],
      now,
    );
    expect(result.byTopic[energy.id]).toEqual([0, 0, 0, 0, 0, 0, 1]);
    expect(result.byTopic[climate.id]).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });
});
