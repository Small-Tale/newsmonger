/**
 * The section filter bar under the masthead (NEWS-297; the feature is NEWS-97,
 * [22 — Topic categories](../../docs/22-topic-categories.md) FR-22.9–22.12).
 *
 * Ninth and last view seam out of `app.tsx`. It sat between the topics rail and
 * its context menu and looked like part of the rail for that reason alone —
 * seam 6 left it behind deliberately. It filters the **feed** by taxonomy
 * section; it merely renders above the rail.
 *
 * Its own file rather than folded into `feed.tsx`: a ticket about the taxonomy
 * touches this and `src/categories.ts`, and neither is about a story card.
 *
 * **The sub-row is always in the DOM**, empty when no section is selected,
 * rather than conditionally rendered — it sits above the keyed topics list, and
 * the E2E suite runs with kerf's `invariants: 'throw'` (NEWS-100), so a
 * conditional sibling there fails at the render that caused it. It also stops
 * the bar's height jumping as you select. That comment travels with the code
 * because it is the only record of why the empty row exists.
 *
 * Rendering only: `data-filter-category` / `data-filter-subcategory` are handled
 * by `delegate()` in `app.tsx` (NEWS-126).
 */

import type { SafeHtml } from 'kerfjs';

import {
  BUILTIN_CATEGORIES,
  findCategory,
  hasUncategorized,
  NO_SUBCATEGORY_FILTER,
  UNCATEGORIZED_FILTER,
  UNCATEGORIZED_LABEL,
  visibleCategories,
  visibleSubcategories,
} from '../categories.js';
import type { Topic } from '../db/schemas.js';
import type { AppState } from './stores.js';

/**
 * The section filter bar (NEWS-97) — a newspaper's section navigation.
 *
 * Two rows, and the second is deliberately styled unlike the first: the top row
 * is the masthead's sections, the sub-row is that section's subsections. Same
 * shape a newspaper uses, and it keeps "which level am I on" legible without a
 * label saying so.
 *
 * The sub-row only appears once a category is selected — 11 categories plus
 * their ~60 subcategories in one bar would be a wall rather than navigation.
 */
export function filterBarJsx(selected: AppState['categoryFilter'], topics: readonly Topic[]): SafeHtml {
  // Only sections something is filed under (NEWS-114) — a pill for a section
  // nobody watches can only ever produce an empty feed.
  const table = visibleCategories(BUILTIN_CATEGORIES, topics, selected?.category ?? null);
  const current = selected === null ? null : findCategory(table, selected.category);
  const subs =
    current === undefined || current === null
      ? []
      : visibleSubcategories(BUILTIN_CATEGORIES, current.slug, topics, selected?.subcategory ?? null);
  return (
    <nav class="filter-bar" aria-label="Filter by section">
      <div class="filter-row filter-row-top">
        <button
          class={`filter-pill${selected === null ? ' active' : ''}`}
          type="button"
          data-filter-category=""
          aria-pressed={selected === null ? 'true' : 'false'}
        >
          All
        </button>
        {table.map((category) => (
          <button
            class={`filter-pill${selected?.category === category.slug ? ' active' : ''}`}
            type="button"
            data-filter-category={category.slug}
            aria-pressed={selected?.category === category.slug ? 'true' : 'false'}
          >
            {category.label}
          </button>
        ))}
        {/* Selects the absence of a category, which no table row can express —
            hence a sentinel slug rather than an entry in the taxonomy. Shown
            only when something is actually unclassified (NEWS-114). */}
        {hasUncategorized(topics, selected?.category ?? null) ? (
          <button
            class={`filter-pill${selected?.category === UNCATEGORIZED_FILTER ? ' active' : ''}`}
            type="button"
            data-filter-category={UNCATEGORIZED_FILTER}
            aria-pressed={selected?.category === UNCATEGORIZED_FILTER ? 'true' : 'false'}
          >
            {UNCATEGORIZED_LABEL}
          </button>
        ) : (
          ''
        )}
      </div>
      {/* Always present, even when empty: this sits above the keyed topics list,
          and a row that comes and going would be a conditional sibling
          (docs/3-ui.md). It also keeps the bar's height from jumping. */}
      <div class="filter-row filter-row-sub">
        {subs.length === 0
          ? ''
          : [
              <button
                class={`filter-subpill${selected?.subcategory === null ? ' active' : ''}`}
                type="button"
                data-filter-subcategory=""
                aria-pressed={selected?.subcategory === null ? 'true' : 'false'}
              >
                All {current?.label ?? ''}
              </button>,
              ...subs.map((sub) => {
                // A null slug is the "Other" pill — topics in this section with
                // no subcategory. The sentinel travels in the attribute because
                // an absence has no slug of its own (FR-22.6).
                const value = sub.slug ?? NO_SUBCATEGORY_FILTER;
                const active = (selected?.subcategory ?? '') === value;
                return (
                  <button
                    class={`filter-subpill${active ? ' active' : ''}`}
                    type="button"
                    data-filter-subcategory={value}
                    aria-pressed={active ? 'true' : 'false'}
                  >
                    {sub.label}
                  </button>
                );
              }),
            ]}
      </div>
    </nav>
  );
}
