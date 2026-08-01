import type { StateResp } from '../api/schemas.js';
import { activeCategories, BUILTIN_CATEGORIES, UNCATEGORIZED_LABEL } from '../categories.js';
import type { TopicSort } from './stores.js';

type Topic = StateResp['topics'][number];

/** Taxonomy position of a topic's category — unclassified sorts last (NEWS-140). */
function categoryRank(topic: Topic): number {
  if (topic.category === null) return Number.MAX_SAFE_INTEGER;
  const index = activeCategories(BUILTIN_CATEGORIES).findIndex((c) => c.slug === topic.category);
  // A slug the taxonomy no longer has is unclassified as far as the rail is
  // concerned — it renders under the same heading, so it must sort there too.
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

/** The heading a topic sits under in category order. */
export function categoryHeading(topic: Topic): string {
  const category = activeCategories(BUILTIN_CATEGORIES).find((c) => c.slug === topic.category);
  return category?.label ?? UNCATEGORIZED_LABEL;
}

/**
 * Order the sidebar topics for display (NEWS-63). A stable copy — never mutates
 * the input — since the array comes straight from app state.
 *
 * - `alpha`: A→Z by name (the default; the most predictable place to find one).
 * - `added`: most recently added first.
 * - `recent`: the topic with the newest story first (NEWS-241). Topics with no
 *   stories sink to the bottom rather than floating on an empty timestamp —
 *   "newest stories" that leads with a topic having none would be a lie. Ties,
 *   including the whole empty group, fall back to A→Z so the order is stable.
 * - `priority`: high-priority topics on top, then A→Z within each group.
 * - `category`: taxonomy order, then A→Z within each section; unclassified last.
 */
export function sortTopics(
  topics: Topic[],
  sort: TopicSort,
  /**
   * Newest story `foundAt` per topic id; only `recent` reads it.
   *
   * Typed with `| undefined` deliberately: a topic that has never produced a
   * story is simply absent from the map, and `Record<string, string>` would
   * claim otherwise — which makes the "no stories yet" branch below look like
   * dead code to both the reader and the linter.
   */
  newestByTopic: Record<string, string | undefined> = {},
): Topic[] {
  const byName = (a: Topic, b: Topic): number => a.name.localeCompare(b.name);
  const copy = [...topics];
  switch (sort) {
    case 'alpha':
      return copy.sort(byName);
    case 'added':
      return copy.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    case 'recent':
      return copy.sort((a, b) => {
        const an = newestByTopic[a.id];
        const bn = newestByTopic[b.id];
        // An absent timestamp means the topic has never produced a story. Sorting
        // it as an empty string would put it *first* under a descending compare,
        // which is the opposite of what "newest stories" promises.
        if (an === undefined && bn === undefined) return byName(a, b);
        if (an === undefined) return 1;
        if (bn === undefined) return -1;
        const cmp = bn.localeCompare(an);
        return cmp === 0 ? byName(a, b) : cmp;
      });
    case 'priority':
      return copy.sort((a, b) => (a.highPriority === b.highPriority ? byName(a, b) : a.highPriority ? -1 : 1));
    case 'category':
      return copy.sort((a, b) => {
        const rank = categoryRank(a) - categoryRank(b);
        return rank === 0 ? byName(a, b) : rank;
      });
  }
}

/** A section heading standing in the topic list (NEWS-140). */
export interface TopicHeading {
  kind: 'heading';
  /** Prefixed so a heading can never collide with a topic id in `data-key`. */
  key: string;
  label: string;
}

/**
 * One row of the sidebar list: a topic, or a heading above a group of them.
 *
 * Headings live in the *same* flat list rather than a nested structure, so the
 * rail keeps its single keyed `each()`. A nested list would be an `each()`
 * inside an `each()` row, which kerf never reconciles (`docs/3-ui.md`), and
 * grouping with `.map()` would give up the per-row memoization the rows need.
 *
 * **Topics are passed through unwrapped, deliberately.** `each()` memoizes on
 * item *identity*, so wrapping each topic in a fresh object every render made
 * every row a cache miss — the rows were rebuilt rather than morphed, and a
 * focused row lost focus the moment anything re-rendered. That broke keyboard
 * access to the topic menu entirely. Only headings are new objects, and a
 * heading has no focus or selection to lose.
 */
export type TopicRow = Topic | TopicHeading;

/** Whether a row is a section heading rather than a topic. */
export function isHeading(row: TopicRow): row is TopicHeading {
  // A `Topic` has no `kind` field, so the presence of one is the discriminator.
  return 'kind' in row;
}

/**
 * The sidebar's rows in display order, with section headings interleaved when
 * sorting by section and none at all otherwise.
 */
export function topicRows(
  topics: Topic[],
  sort: TopicSort,
  newestByTopic: Record<string, string | undefined> = {},
): TopicRow[] {
  const sorted = sortTopics(topics, sort, newestByTopic);
  if (sort !== 'category') return sorted;

  const rows: TopicRow[] = [];
  let heading: string | null = null;
  for (const topic of sorted) {
    const label = categoryHeading(topic);
    if (label !== heading) {
      heading = label;
      rows.push({ kind: 'heading', key: `heading:${label}`, label });
    }
    rows.push(topic);
  }
  return rows;
}
