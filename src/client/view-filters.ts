import type { AppState } from './stores.js';

/** Solo owns topic scope while active; the saved taxonomy choice remains untouched. */
export function effectiveCategoryFilter(
  selected: AppState['categoryFilter'],
  soloTopicIds: readonly string[],
): AppState['categoryFilter'] {
  return soloTopicIds.length > 0 ? null : selected;
}
