import { z } from 'zod';

/**
 * The topic category taxonomy (NEWS-97).
 *
 * Newspaper-section shaped, two levels deep, with subcategories only where they
 * earn their place — Sports and Technology need them, Style doesn't.
 *
 * **Edited in code, by design** (FR-22.1) — there is no settings UI and no stored
 * copy, so this module is the single source of truth for both the server and the
 * client. Gaps are expected: add a category here, and the classifier offers it on
 * the next check. Prefer `retired: true` to deleting an entry, so topics already
 * holding the slug keep their label.
 */

/** A second-level category. */
export const SubcategorySchema = z.object({
  slug: z.string().min(1),
  label: z.string().min(1),
  /**
   * Hidden from the filter bar and from the classifier's options, but still
   * rendered on topics that hold it. Retiring rather than deleting is what makes
   * removal safe: a deleted slug would leave every topic holding it unlabelled.
   */
  retired: z.boolean().default(false),
});
export type Subcategory = z.infer<typeof SubcategorySchema>;

/** A top-level category. */
export const CategorySchema = z.object({
  slug: z.string().min(1),
  label: z.string().min(1),
  retired: z.boolean().default(false),
  subcategories: z.array(SubcategorySchema).default([]),
});
export type Category = z.infer<typeof CategorySchema>;

export const CategoryTableSchema = z.array(CategorySchema);
export type CategoryTable = z.infer<typeof CategoryTableSchema>;

/** Turn "Climate & Environment" into "climate-environment". */
function slugify(label: string): string {
  return label
    .toLowerCase()
    .replace(/&/g, ' ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function cat(label: string, subs: string[] = []): Category {
  return {
    slug: slugify(label),
    label,
    retired: false,
    subcategories: subs.map((s) => ({ slug: slugify(s), label: s, retired: false })),
  };
}

/**
 * The seeded taxonomy — 11 top-level categories, approved on NEWS-97.
 *
 * Eleven is a deliberate ceiling: the filter bar has to stay scannable, and a
 * category nobody's topics land in costs bar space permanently. Three calls the
 * owner reviewed specifically:
 *
 * - **Climate & Environment sits under Science**, not at the top level. Much
 *   climate news is really politics or business, and promoting it later is a
 *   one-line data edit under this design — whereas a twelfth pill is permanent.
 * - **Style is separate from Culture**, mirroring the newspaper section, so
 *   Fashion is findable on its own with Beauty and Home alongside it.
 * - **Crime & Justice sits under Society**, not Politics. The split against
 *   Politics ▸ Courts & Law is *incidents and policing* vs *rulings and the
 *   judiciary*.
 */
export const BUILTIN_CATEGORIES: CategoryTable = [
  cat('World', ['Africa', 'Americas', 'Asia-Pacific', 'Europe', 'Middle East']),
  cat('Politics', ['Elections', 'Policy & Legislation', 'Government', 'Courts & Law', 'Defense']),
  cat('Business', ['Markets', 'Companies', 'Economy', 'Startups & VC', 'Real Estate', 'Jobs & Labor']),
  cat('Technology', [
    'AI',
    'Software & Internet',
    'Chips & Hardware',
    'Cybersecurity',
    'Crypto',
    'Consumer Tech',
  ]),
  cat('Science', ['Space', 'Climate & Environment', 'Energy', 'Biology & Medicine Research', 'Physics & Math']),
  cat('Health', ['Medicine', 'Public Health', 'Mental Health', 'Healthcare Industry', 'Fitness & Nutrition']),
  cat('Sports', [
    'Soccer',
    'Football',
    'Basketball',
    'Baseball',
    'Hockey',
    'Tennis',
    'Golf',
    'Motorsport',
    'Combat Sports',
    'Olympics',
    'College',
  ]),
  cat('Entertainment', ['Film', 'TV & Streaming', 'Music', 'Gaming', 'Celebrity']),
  cat('Culture', ['Art & Design', 'Books', 'Food & Drink', 'Travel', 'History', 'Religion', 'Ideas']),
  cat('Style', ['Fashion', 'Beauty', 'Home & Garden']),
  cat('Society', ['Education', 'Crime & Justice', 'Immigration', 'Family', 'Social Issues']),
];

/**
 * Label for a topic with no category at all — not an entry in the table, so it
 * can't be renamed or retired, and nothing can accidentally classify *into* it.
 */
export const UNCATEGORIZED_LABEL = 'Uncategorized';

/**
 * Label for a topic that has a category but no subcategory (NEWS-97).
 *
 * The owner asked for a "general" subcategory on every category, so a skiing
 * topic has somewhere to sit when Sports has no Skiing row. This is that, done
 * as a **rendered fallback rather than 11 stored rows**:
 *
 * - Nothing to maintain — every category added later gets it for free, where a
 *   stored General row would have to be remembered each time or reopen the hole.
 * - Adding *Skiing* next winter strands nothing: existing `sports`/`null` topics
 *   are unclassified-at-sub-level, which is exactly what they are. A stored
 *   `sports/general` would claim to be classified and need migrating.
 * - The classifier can just omit the subcategory, which is both the honest
 *   answer and the easier instruction to write.
 */
export const NO_SUBCATEGORY_LABEL = 'Other';

/**
 * Sentinel slugs for the filter bar's two "absence" selections (NEWS-97).
 *
 * They are query values rather than taxonomy entries because they select the
 * *absence* of a value, which no table row can represent. Kept here so the
 * client and `Store.queryItems` cannot disagree about their spelling — the
 * client must not import from `db/`, which pulls in `node:sqlite`.
 *
 * Neither is a valid slug (nothing slugifies to them from the built-ins), so a
 * real category can never collide with one.
 */
export const UNCATEGORIZED_FILTER = 'uncategorized';
export const NO_SUBCATEGORY_FILTER = 'other';

/** Look up a category by slug, retired or not. Unknown slugs resolve to undefined. */
export function findCategory(table: CategoryTable, slug: string | null): Category | undefined {
  if (slug === null) return undefined;
  return table.find((c) => c.slug === slug);
}

export function findSubcategory(
  table: CategoryTable,
  categorySlug: string | null,
  subSlug: string | null,
): Subcategory | undefined {
  if (subSlug === null) return undefined;
  return findCategory(table, categorySlug)?.subcategories.find((s) => s.slug === subSlug);
}

/**
 * The label to show on a topic's pill: the most specific one that resolves.
 *
 * A slug that isn't in the table renders as Uncategorized rather than as itself
 * or as an error — the table is user-editable, so an unresolvable slug is an
 * ordinary consequence of retiring something, not a corruption to shout about.
 */
export function categoryLabel(
  table: CategoryTable,
  categorySlug: string | null,
  subSlug: string | null,
): string {
  const category = findCategory(table, categorySlug);
  if (category === undefined) return UNCATEGORIZED_LABEL;
  const sub = findSubcategory(table, categorySlug, subSlug);
  return sub === undefined ? category.label : `${category.label} · ${sub.label}`;
}

/** Categories offered in the filter bar and to the classifier — retired ones excluded. */
export function activeCategories(table: CategoryTable): Category[] {
  return table
    .filter((c) => !c.retired)
    .map((c) => ({ ...c, subcategories: c.subcategories.filter((s) => !s.retired) }));
}
