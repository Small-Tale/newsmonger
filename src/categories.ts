import { z } from 'zod';

import type { CategoryOption } from './ai/types.js';

/**
 * The topic category taxonomy (NEWS-97, widened to 20 sections in NEWS-388).
 *
 * Newspaper-section shaped, two levels deep. Every section carries subcategories
 * now; the sections that don't need a drill-down simply never show one, because
 * the sub-row appears only when two or more of them are in use (FR-22.14).
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

/**
 * A subcategory in the seed table: usually just its label, from which the slug
 * is generated — or a fully-built row when the slug can't simply follow the
 * label (`renamed`) or the row is on its way out (`retiredSub`).
 */
type SubSpec = string | Subcategory;

/**
 * A subcategory whose **label changed but whose slug must not** (FR-22.2).
 *
 * Slugs are generated from labels, so widening "Books" to "Books & Literature"
 * would otherwise move the slug to `books-literature` and leave every topic
 * holding `books` unlabelled. Pinning the old slug is what makes the docs'
 * promise — "renaming touches one table row and no topic" — actually hold.
 */
function renamed(label: string, slug: string): Subcategory {
  return { slug, label, retired: false };
}

/**
 * A subcategory that **moved to another section or left the taxonomy** (FR-22.4).
 *
 * Kept with its original label so topics that already hold the slug still render;
 * `activeCategories()` hides it from the filter bar and from the classifier's
 * options, so nothing new can land in it. Deleting the row instead is what would
 * orphan a topic.
 */
function retiredSub(label: string): Subcategory {
  return { slug: slugify(label), label, retired: true };
}

function cat(label: string, subs: SubSpec[] = []): Category {
  return {
    slug: slugify(label),
    label,
    retired: false,
    subcategories: subs.map((s) => (typeof s === 'string' ? { slug: slugify(s), label: s, retired: false } : s)),
  };
}

/**
 * The seeded taxonomy — 20 top-level sections (NEWS-97, widened in NEWS-388).
 *
 * It began at eleven. NEWS-388 took it to twenty against the brief "enough that
 * virtually any topic one could pick would fit reasonably well": Money, Media,
 * Living, Law & Justice and Transport are new, and Environment, Food & Drink,
 * Travel and Education were promoted out of the sections they were buried in.
 *
 * **An unused section costs nothing in the bar** (NEWS-114). `visibleCategories`
 * renders only the sections topics are actually filed under, so the original
 * argument for a hard ceiling — "a category nobody's topics land in costs bar
 * space permanently" — has been false since then. What the taxonomy's size
 * really buys is paid somewhere else: **the classifier's option list**. Every
 * section and every subcategory is written into the check prompt as a choice
 * (`categoryOptions` → `buildUserPrompt`), so the table is re-read, in tokens,
 * on every check that still needs a classification — and a longer menu is a
 * harder choice to make well. That is the budget to weigh before widening it
 * again, not the width of the filter bar.
 *
 * The three placements the owner reviewed on NEWS-97, and where they stand:
 *
 * - **Climate & Environment under Science** — *superseded by NEWS-388*. The
 *   argument for burying it was that promoting it later would be a one-line data
 *   edit; that is what happened. **Environment** is a top-level section now, and
 *   the Science rows are retired rather than deleted.
 * - **Style is separate from Culture** — *still true*, mirroring the newspaper
 *   section, so Fashion is findable on its own. Home & Garden moved to Living.
 * - **Crime & Justice under Society, not Politics** — *superseded by NEWS-388*.
 *   The split it drew is intact but now sits inside one section: **Law & Justice
 *   ▸ Crime & Policing** (incidents and policing) against **Courts & Rulings**
 *   (rulings and the judiciary). Splitting it across two top-level sections was
 *   the part that never quite worked.
 *
 * Rows that moved are `retiredSub(...)`, never deleted, so topics classified
 * under the old shape keep their labels (FR-22.4). Rows whose label was widened
 * in place are `renamed(label, slug)`, so the slug they are stored under does
 * not move (FR-22.2).
 */
export const BUILTIN_CATEGORIES: CategoryTable = [
  cat('World', [
    'Africa',
    'Americas',
    'Asia-Pacific',
    'Europe',
    'Middle East',
    'Conflict & Security',
    'Global Development',
  ]),
  cat('Politics', [
    'Elections',
    'Policy & Legislation',
    'Government',
    'Defense',
    'Parties & Campaigns',
    'Polling & Public Opinion',
    retiredSub('Courts & Law'), // → Law & Justice ▸ Courts & Rulings
  ]),
  cat('Business', [
    'Markets',
    'Companies',
    'Economy',
    'Startups & VC',
    'Jobs & Labor',
    'Small Business',
    'Trade & Supply Chains',
    retiredSub('Real Estate'), // → Money ▸ Housing & Property
  ]),
  cat('Money', [
    'Personal Finance',
    'Housing & Property',
    'Retirement & Pensions',
    'Tax',
    'Consumer Rights & Prices',
    'Insurance',
  ]),
  cat('Technology', [
    'AI',
    'Software & Internet',
    'Chips & Hardware',
    'Cybersecurity',
    'Crypto',
    'Consumer Tech',
    'Developer Tools',
    'Data & Privacy',
  ]),
  cat('Science', [
    renamed('Space & Astronomy', 'space'),
    'Biology & Medicine Research',
    'Physics & Math',
    'Earth Sciences',
    'Archaeology & Anthropology',
    'Research & Academia',
    retiredSub('Climate & Environment'), // → Environment ▸ Climate
    retiredSub('Energy'), // → Environment ▸ Energy
  ]),
  cat('Environment', [
    'Climate',
    'Energy',
    'Conservation & Wildlife',
    'Pollution & Waste',
    'Weather & Natural Disasters',
    'Water & Oceans',
  ]),
  cat('Health', [
    'Medicine',
    'Public Health',
    'Mental Health',
    'Healthcare Industry',
    'Fitness & Nutrition',
    'Pharma & Drug Development',
    'Aging & Longevity',
  ]),
  cat('Sports', [
    'Soccer',
    'Football',
    'Basketball',
    'Baseball',
    'Hockey',
    'Cricket',
    'Tennis',
    'Golf',
    'Motorsport',
    'Combat Sports',
    'Running & Endurance',
    'Cycling',
    'Winter Sports',
    'Water Sports',
    'Olympics',
    'College',
  ]),
  cat('Entertainment', [
    'Film',
    'TV & Streaming',
    'Music',
    'Gaming',
    'Anime & Comics',
    'Comedy & Theater',
    'Celebrity',
  ]),
  cat('Media', ['Journalism & Press', 'Publishing', 'Social Platforms', 'Advertising & Marketing', 'Podcasts & Audio']),
  cat('Culture', [
    'Art & Design',
    renamed('Books & Literature', 'books'),
    'History',
    renamed('Religion & Belief', 'religion'),
    renamed('Ideas & Philosophy', 'ideas'),
    'Language',
    'Museums & Heritage',
    retiredSub('Food & Drink'), // → the Food & Drink section
    retiredSub('Travel'), // → the Travel section
  ]),
  cat('Food & Drink', [
    'Restaurants',
    'Cooking',
    'Ingredients & Produce',
    'Beer, Wine & Spirits',
    'Coffee & Tea',
    'Food Industry & Safety',
  ]),
  cat('Travel', ['Air Travel', 'Destinations', 'Hotels & Lodging', 'Rail & Road', 'Visas & Border Rules', 'Travel Industry']),
  cat('Style', [
    'Fashion',
    renamed('Beauty & Skincare', 'beauty'),
    'Watches & Jewelry',
    'Streetwear & Sneakers',
    retiredSub('Home & Garden'), // → Living ▸ Home & Garden
  ]),
  cat('Living', ['Home & Garden', 'Pets & Animals', 'Outdoors & Recreation', 'Hobbies & Making', 'Motoring', 'Photography']),
  cat('Education', [
    'Schools',
    'Higher Education',
    'Teaching & Curriculum',
    'Student Life',
    'Education Technology',
    'Skills & Training',
  ]),
  cat('Law & Justice', [
    'Courts & Rulings',
    'Crime & Policing',
    'Regulation & Compliance',
    'Legal Profession',
    'Civil Rights & Liberties',
  ]),
  cat('Society', [
    'Social Issues',
    'Immigration',
    renamed('Family & Relationships', 'family'),
    'Work & Careers',
    'Community & Nonprofits',
    'Demographics & Population',
    retiredSub('Education'), // → the Education section
    retiredSub('Crime & Justice'), // → Law & Justice ▸ Crime & Policing
  ]),
  cat('Transport', ['Aviation', 'Rail', 'Shipping & Logistics', 'Public Transit', 'Roads & Infrastructure']),
  /**
   * The explicit home for a topic nothing else fits (NEWS-405).
   *
   * **Deliberately has no subcategories.** Its whole meaning is "no subject
   * fits", so offering subjects would contradict it — and it keeps the one
   * label collision harmless: `NO_SUBCATEGORY_LABEL` is also "Other", but a
   * section with no subcategories never renders a subject beside its name.
   *
   * This exists so the classifier has somewhere to *put* a topic it cannot
   * place. Before it, declining meant `category: null`, which left
   * `needsClassifying` true and re-sent the whole ~5,400-character option list
   * on every check, forever, with nothing to show for it. A real section ends
   * the asking and makes the outcome visible — and FR-22.7a lets the user move
   * it somewhere better in two clicks.
   */
  cat('Other'),
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
 * as a **rendered fallback rather than one stored row per section**:
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

/** The minimum a topic must carry for the filter bar to count it. */
export interface CategorisedTopic {
  category: string | null;
  subcategory: string | null;
}

/**
 * The filter bar's visible options, given what the topics actually use (NEWS-114).
 *
 * A pill for a section nobody watches is a button that can only ever produce an
 * empty feed, and twenty of them crowd out the two or three that mean something.
 *
 * This is also why the taxonomy can afford to be broad (NEWS-388): an unused
 * section is never rendered, so it costs nothing here.
 *
 * `selected` is always kept, even when nothing uses it any more. Deleting the
 * last Sports topic while filtered to Sports would otherwise remove the only
 * control showing that a filter is on, leaving an empty feed with no visible
 * cause and no way back.
 */
export function visibleCategories(
  table: CategoryTable,
  topics: readonly CategorisedTopic[],
  selected: string | null = null,
): Category[] {
  const used = new Set(topics.map((t) => t.category).filter((c): c is string => c !== null));
  return activeCategories(table).filter((c) => used.has(c.slug) || c.slug === selected);
}

/** Whether any topic has no category, i.e. whether the Uncategorized pill earns its place. */
export function hasUncategorized(topics: readonly CategorisedTopic[], selected: string | null = null): boolean {
  return topics.some((t) => t.category === null) || selected === UNCATEGORIZED_FILTER;
}

/**
 * The subcategory options for `categorySlug`, or an empty list when the row
 * shouldn't be shown at all (NEWS-114).
 *
 * Returns `[]` when fewer than two options are in use, because a lone option is
 * not a choice: with every Sports topic under Soccer, "All Sports" and "Soccer"
 * select exactly the same stories, so offering both is a control that does
 * nothing. `null` in a returned slug is the *Other* pill — topics in this
 * section with no subcategory (FR-22.6).
 */
export function visibleSubcategories(
  table: CategoryTable,
  categorySlug: string,
  topics: readonly CategorisedTopic[],
  selected: string | null = null,
): { slug: string | null; label: string }[] {
  const mine = topics.filter((t) => t.category === categorySlug);
  const category = findCategory(activeCategories(table), categorySlug);
  if (category === undefined) return [];

  const usedSubs = new Set(mine.map((t) => t.subcategory).filter((sub): sub is string => sub !== null));
  const options: { slug: string | null; label: string }[] = category.subcategories
    .filter((sub) => usedSubs.has(sub.slug) || sub.slug === selected)
    .map((sub) => ({ slug: sub.slug, label: sub.label }));
  if (mine.some((t) => t.subcategory === null) || selected === NO_SUBCATEGORY_FILTER) {
    options.push({ slug: null, label: NO_SUBCATEGORY_LABEL });
  }
  return options.length < 2 ? [] : options;
}

/**
 * The sections offered to the classifier — retired ones excluded (FR-22.4).
 *
 * Here rather than in `checks.ts` so the recorder (`npm run record:cli-sessions`)
 * sends the **same** list the app does. A fixture built from a hand-written option
 * list would be a transcript of a prompt this app never sends, which is the one
 * thing a recording is supposed to make impossible.
 */
export function classifierOptions(): CategoryOption[] {
  return activeCategories(BUILTIN_CATEGORIES).map((c) => ({
    slug: c.slug,
    label: c.label,
    subcategories: c.subcategories.map((s) => ({ slug: s.slug, label: s.label })),
  }));
}
