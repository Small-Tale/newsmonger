import type { TopicSuggestion } from '../api/schemas.js';
import type { Category } from '../categories.js';
import { activeCategories, BUILTIN_CATEGORIES, NO_SUBCATEGORY_LABEL, UNCATEGORIZED_LABEL } from '../categories.js';

/**
 * Pure helpers behind the discovery dialog (NEWS-126).
 *
 * Kept out of `app.tsx` so the grouping and labelling rules are unit-testable
 * without a DOM — the same split `search.ts` and `solo.ts` already use.
 */

/** The 11 section tiles, retired ones excluded (FR-24.2). */
export function sectionTiles(): Category[] {
  return activeCategories(BUILTIN_CATEGORIES);
}

/** The subcategories of one section, or null when the slug isn't one. */
export function sectionFor(slug: string): Category | undefined {
  return sectionTiles().find((c) => c.slug === slug);
}

export interface SuggestionGroup {
  /** Section heading — "Sports · Motorsport", or the uncategorized label. */
  label: string;
  /** Stable key for the row, since a label can repeat across renders. */
  key: string;
  suggestions: TopicSuggestion[];
}

/**
 * Group suggestions by section for display (FR-24.4).
 *
 * The grouping doubles as a preview of where each topic will file itself in the
 * filter bar, so the labels are deliberately the *same* ones that bar uses
 * rather than a discovery-specific wording — a suggestion shown under "Sports ·
 * Motorsport" lands exactly there.
 *
 * Order follows the taxonomy, not the model's output order, so browsing twice
 * doesn't reshuffle the page. Unclassified suggestions sort last: they are the
 * ones the model couldn't place, and leading with them buries the rest.
 */
export function groupSuggestions(suggestions: TopicSuggestion[]): SuggestionGroup[] {
  const table = sectionTiles();
  const groups = new Map<string, SuggestionGroup>();

  const push = (key: string, label: string, suggestion: TopicSuggestion): void => {
    const existing = groups.get(key);
    if (existing) existing.suggestions.push(suggestion);
    else groups.set(key, { key, label, suggestions: [suggestion] });
  };

  for (const suggestion of suggestions) {
    const classification = suggestion.classification;
    if (classification === null) {
      push('~uncategorized', UNCATEGORIZED_LABEL, suggestion);
      continue;
    }
    const category = table.find((c) => c.slug === classification.category);
    if (category === undefined) {
      // The server validates against the same table, so this is unreachable in
      // practice — but rendering *something* beats dropping a suggestion the
      // user might have wanted because a slug went stale mid-session.
      push('~uncategorized', UNCATEGORIZED_LABEL, suggestion);
      continue;
    }
    const sub = category.subcategories.find((s) => s.slug === classification.subcategory);
    const key = `${category.slug}/${sub?.slug ?? ''}`;
    push(key, `${category.label} · ${sub?.label ?? NO_SUBCATEGORY_LABEL}`, suggestion);
  }

  // Sorted by *both* levels: ordering only by category would leave two
  // subcategories of the same section in whatever order the model happened to
  // emit them, which is exactly the reshuffling this is meant to prevent.
  const order = (key: string): [number, number] => {
    if (key === '~uncategorized') return [Number.MAX_SAFE_INTEGER, 0];
    const [categorySlug, subSlug] = key.split('/');
    const categoryIndex = table.findIndex((c) => c.slug === categorySlug);
    const subs = table[categoryIndex]?.subcategories ?? [];
    // A category with no subcategory sorts after its named subsections: "Other"
    // is the leftovers, and leading with it reads as the section's headline.
    const subIndex = subSlug === '' ? subs.length : subs.findIndex((s) => s.slug === subSlug);
    return [categoryIndex, subIndex];
  };
  return [...groups.values()].sort((a, b) => {
    const [ac, as] = order(a.key);
    const [bc, bs] = order(b.key);
    return ac === bc ? as - bs : ac - bc;
  });
}

/** Heading describing where a result list came from, for the results pane. */
export function resultsHeading(from: { kind: 'describe'; query: string } | { kind: 'section'; category: string; subcategory: string | null }): string {
  if (from.kind === 'describe') {
    const query = from.query.trim();
    // The empty box is "surprise me" (FR-24.3), so it needs a heading that
    // reads as a deliberate answer rather than a failed search.
    return query === '' ? 'A bit of everything' : `Because you said “${query}”`;
  }
  const category = sectionFor(from.category);
  if (category === undefined) return 'Suggestions';
  if (from.subcategory === null) return `Anything in ${category.label}`;
  const sub = category.subcategories.find((s) => s.slug === from.subcategory);
  return sub === undefined ? category.label : `${category.label} · ${sub.label}`;
}

/** Label for the ongoing/evergreen badge (FR-24.10). */
export function kindLabel(kind: TopicSuggestion['kind']): string {
  return kind === 'ongoing' ? 'Ongoing story' : 'Evergreen';
}
