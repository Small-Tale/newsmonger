import type { StateResp } from '../api/schemas.js';

type NewsItem = StateResp['items'][number];

/**
 * Whether a story matches a feed search query (NEWS-60): a case-insensitive
 * substring match against its title, summary, or the name of the topic it
 * belongs to. An empty/whitespace query matches everything, so callers can pass
 * the raw box value.
 */
export function itemMatchesQuery(item: NewsItem, topicName: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return true;
  return (
    item.title.toLowerCase().includes(q) ||
    item.summary.toLowerCase().includes(q) ||
    topicName.toLowerCase().includes(q)
  );
}

/**
 * Filter a feed by the search query, resolving each item's topic name via
 * `topicNames`. Composes with whatever list is passed in (Solo/Saved already
 * applied), so search narrows within the current view.
 */
export function filterItemsByQuery(
  items: NewsItem[],
  topicNames: Map<string, string>,
  query: string,
): NewsItem[] {
  if (query.trim() === '') return items;
  return items.filter((item) => itemMatchesQuery(item, topicNames.get(item.topicId) ?? '', query));
}
