import type { StateResp } from '../api/schemas.js';
import type { TopicSort } from './stores.js';

type Topic = StateResp['topics'][number];

/**
 * Order the sidebar topics for display (NEWS-63). A stable copy — never mutates
 * the input — since the array comes straight from app state.
 *
 * - `alpha`: A→Z by name (the default; the most predictable place to find one).
 * - `added`: most recently added first.
 * - `priority`: high-priority topics on top, then A→Z within each group.
 */
export function sortTopics(topics: Topic[], sort: TopicSort): Topic[] {
  const byName = (a: Topic, b: Topic): number => a.name.localeCompare(b.name);
  const copy = [...topics];
  switch (sort) {
    case 'alpha':
      return copy.sort(byName);
    case 'added':
      return copy.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    case 'priority':
      return copy.sort((a, b) => (a.highPriority === b.highPriority ? byName(a, b) : a.highPriority ? -1 : 1));
  }
}
