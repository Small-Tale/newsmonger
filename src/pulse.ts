import type { PulseResp, TopicSparklineResp } from './api/schemas.js';
import { NO_SUBCATEGORY_FILTER, UNCATEGORIZED_FILTER } from './categories.js';
import type { NewsItem, Topic } from './db/schemas.js';

export type PulseDays = 7 | 30 | 90;

export type PulseSelection =
  | { kind: 'topic'; id: string; label: string }
  | { kind: 'category'; id: string; subcategory: string | null; label: string };

function startOfLocalDay(value: Date): Date {
  const day = new Date(value);
  day.setHours(0, 0, 0, 0);
  return day;
}

function localDayKey(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${String(year)}-${month}-${day}`;
}

function addLocalDays(value: Date, days: number): Date {
  const next = new Date(value);
  next.setDate(next.getDate() + days);
  return next;
}

function sourceLabel(item: NewsItem): string | null {
  const primary = item.sources.at(0);
  if (primary === undefined) return null;
  const outlet = primary.outlet?.trim();
  if (outlet !== undefined && outlet !== '') return outlet;
  try {
    return new URL(primary.url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function matchesSelection(item: NewsItem, topics: ReadonlyMap<string, Topic>, selection: PulseSelection): boolean {
  if (selection.kind === 'topic') return item.topicId === selection.id;
  const topic = topics.get(item.topicId);
  if (selection.id === UNCATEGORIZED_FILTER) return topic?.category === null;
  if (topic?.category !== selection.id) return false;
  if (selection.subcategory === null) return true;
  if (selection.subcategory === NO_SUBCATEGORY_FILTER) return topic.subcategory === null;
  return topic.subcategory === selection.subcategory;
}

function rounded(value: number, places = 1): number {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

/**
 * Build one pulse entirely from stored metadata (NEWS-453).
 *
 * `foundAt` owns the calendar, matching the feed's day headings. Flagged rows
 * are excluded, also matching the ordinary feed. A story is credited to its
 * primary source only: this gives every story one vote, makes the denominator
 * legible, and avoids a six-citation story outweighing a one-citation story.
 */
export function analyzePulse(
  allItems: readonly NewsItem[],
  allTopics: readonly Topic[],
  selection: PulseSelection,
  days: PulseDays,
  now = new Date(),
): PulseResp {
  const topics = new Map(allTopics.map((topic) => [topic.id, topic]));
  const today = startOfLocalDay(now);
  const windowStart = addLocalDays(today, -(days - 1));
  const nextDay = addLocalDays(today, 1);
  const previousStart = addLocalDays(windowStart, -days);

  const relevant = allItems
    .filter((item) => !item.offTopic && matchesSelection(item, topics, selection))
    .map((item) => ({ item, at: new Date(item.foundAt) }))
    .filter(({ at }) => !Number.isNaN(at.getTime()))
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  const current = relevant.filter(({ at }) => at >= windowStart && at < nextDay);
  const previousStoryCount = relevant.filter(({ at }) => at >= previousStart && at < windowStart).length;

  const firstByThread = new Map<string, number>();
  for (const { item, at } of relevant) {
    const first = firstByThread.get(item.threadId);
    if (first === undefined || at.getTime() < first) firstByThread.set(item.threadId, at.getTime());
  }

  const perDay = new Map<string, { stories: number; updates: number }>();
  for (let offset = 0; offset < days; offset++) {
    perDay.set(localDayKey(addLocalDays(windowStart, offset)), { stories: 0, updates: 0 });
  }
  for (const { item, at } of current) {
    const bucket = perDay.get(localDayKey(at));
    if (bucket === undefined) continue;
    bucket.stories++;
    if ((firstByThread.get(item.threadId) ?? at.getTime()) < at.getTime()) bucket.updates++;
  }
  const series = [...perDay].map(([date, value]) => ({ date, ...value }));

  const sourceCounts = new Map<string, number>();
  for (const { item } of current) {
    const label = sourceLabel(item);
    if (label !== null) sourceCounts.set(label, (sourceCounts.get(label) ?? 0) + 1);
  }
  const sourcedStories = [...sourceCounts.values()].reduce((sum, count) => sum + count, 0);
  const rankedSources = [...sourceCounts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const topSources = rankedSources.slice(0, 4);
  const sources = topSources.map(([label, count]) => ({
    label,
    count,
    share: sourcedStories === 0 ? 0 : count / sourcedStories,
  }));
  const otherSourceCount = rankedSources.slice(4).reduce((sum, [, count]) => sum + count, 0);

  const currentByThread = new Map<string, { items: NewsItem[]; first: string; latest: string }>();
  for (const { item } of current) {
    const group = currentByThread.get(item.threadId);
    if (group === undefined) {
      currentByThread.set(item.threadId, { items: [item], first: item.foundAt, latest: item.foundAt });
    } else {
      group.items.push(item);
      if (item.foundAt < group.first) group.first = item.foundAt;
      if (item.foundAt > group.latest) group.latest = item.foundAt;
    }
  }
  const threads = [...currentByThread]
    .map(([id, group]) => ({
      id,
      title: group.items.at(-1)?.title ?? 'Untitled story',
      updates: Math.max(0, group.items.length - (firstByThread.get(id) === new Date(group.first).getTime() ? 1 : 0)),
      startedAt: group.first,
      latestAt: group.latest,
    }))
    .filter((thread) => thread.updates > 0)
    .sort((a, b) => b.updates - a.updates || b.latestAt.localeCompare(a.latestAt))
    .slice(0, 3);

  const activeThreads = new Set(current.map(({ item }) => item.threadId)).size;
  const storyCount = current.length;
  const trendPercent = previousStoryCount === 0 ? null : rounded(((storyCount - previousStoryCount) / previousStoryCount) * 100, 0);
  const activeDays = series.filter((point) => point.stories > 0);
  let longestQuietDays = 0;
  let quietRun = 0;
  for (const point of series) {
    if (point.stories === 0) {
      quietRun++;
      longestQuietDays = Math.max(longestQuietDays, quietRun);
    } else quietRun = 0;
  }
  const mostActive = activeDays.reduce<(typeof activeDays)[number] | null>(
    (best, point) => (best === null || point.stories > best.stories ? point : best),
    null,
  );
  const averageDays = storyCount < 2 ? null : rounded(days / storyCount);

  return {
    scope: {
      kind: selection.kind,
      id: selection.id,
      subcategory: selection.kind === 'category' ? selection.subcategory : null,
      label: selection.label,
    },
    days,
    storyCount,
    previousStoryCount,
    trendPercent,
    activeThreads,
    distinctOutlets: sourceCounts.size,
    sourcedStories,
    topSourceShare: sourcedStories === 0 ? null : (rankedSources[0]?.[1] ?? 0) / sourcedStories,
    smallSample: storyCount < 10,
    series,
    cadence: {
      averageDays,
      longestQuietDays,
      mostActiveDate: mostActive?.date ?? null,
      mostActiveCount: mostActive?.stories ?? 0,
    },
    sources,
    otherSourceCount,
    threads,
  };
}

/** Seven local-calendar buckets for every topic row's tiny activity chart. */
export function topicSparklines(
  allItems: readonly NewsItem[],
  allTopics: readonly Topic[],
  now = new Date(),
): TopicSparklineResp {
  const byTopic: TopicSparklineResp['byTopic'] = {};
  for (const topic of allTopics) {
    byTopic[topic.id] = analyzePulse(allItems, allTopics, { kind: 'topic', id: topic.id, label: topic.name }, 7, now).series.map(
      (point) => point.stories,
    );
  }
  return { byTopic };
}
