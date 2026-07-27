import { describe, expect, it } from 'vitest';

import {
  activeCategories,
  BUILTIN_CATEGORIES,
  categoryLabel,
  CategoryTableSchema,
  findCategory,
  findSubcategory,
  NO_SUBCATEGORY_LABEL,
  UNCATEGORIZED_LABEL,
} from '../../src/categories.js';

// The category taxonomy (NEWS-97). These cover the seed table's shape and the
// label resolution, which is the part every other piece of the feature will read
// through — the classifier, the sidebar pill, and the filter bar all resolve a
// stored slug to a label the same way.

describe('the built-in taxonomy', () => {
  it('parses as a valid table', () => {
    expect(() => CategoryTableSchema.parse(BUILTIN_CATEGORIES)).not.toThrow();
  });

  it('has the eleven approved top-level categories', () => {
    expect(BUILTIN_CATEGORIES.map((c) => c.label)).toEqual([
      'World',
      'Politics',
      'Business',
      'Technology',
      'Science',
      'Health',
      'Sports',
      'Entertainment',
      'Culture',
      'Style',
      'Society',
    ]);
  });

  it('uses slugs distinct from labels, so a rename touches no topic', () => {
    // The whole extensibility guarantee rests on this: topics store the slug.
    const style = BUILTIN_CATEGORIES.find((c) => c.label === 'Style');
    expect(style?.slug).toBe('style');
    const climate = findSubcategory(BUILTIN_CATEGORIES, 'science', 'climate-environment');
    expect(climate?.label).toBe('Climate & Environment');
  });

  it('has unique slugs at both levels', () => {
    // A duplicate slug would make lookups silently pick the first match.
    const top = BUILTIN_CATEGORIES.map((c) => c.slug);
    expect(new Set(top).size).toBe(top.length);
    for (const category of BUILTIN_CATEGORIES) {
      const subs = category.subcategories.map((s) => s.slug);
      expect(new Set(subs).size, `duplicate sub slug in ${category.slug}`).toBe(subs.length);
    }
  });

  it('generates slugs that survive punctuation', () => {
    expect(findSubcategory(BUILTIN_CATEGORIES, 'business', 'startups-vc')?.label).toBe('Startups & VC');
    expect(findSubcategory(BUILTIN_CATEGORIES, 'world', 'asia-pacific')?.label).toBe('Asia-Pacific');
    expect(findSubcategory(BUILTIN_CATEGORIES, 'style', 'home-garden')?.label).toBe('Home & Garden');
  });

  it('places the three categories the owner reviewed where they were approved', () => {
    expect(findSubcategory(BUILTIN_CATEGORIES, 'science', 'climate-environment')).toBeDefined();
    expect(findCategory(BUILTIN_CATEGORIES, 'style')).toBeDefined();
    expect(findSubcategory(BUILTIN_CATEGORIES, 'society', 'crime-justice')).toBeDefined();
    // ...and not where they were not.
    expect(findSubcategory(BUILTIN_CATEGORIES, 'politics', 'crime-justice')).toBeUndefined();
  });

  it('ships nothing retired', () => {
    expect(BUILTIN_CATEGORIES.every((c) => !c.retired)).toBe(true);
    expect(BUILTIN_CATEGORIES.flatMap((c) => c.subcategories).every((s) => !s.retired)).toBe(true);
  });

  it('has no stored "general" subcategory — that is a rendered fallback', () => {
    // Pinning the decision: a General row in each category is the thing this
    // design deliberately avoids, so its absence should be asserted, not assumed.
    const all = BUILTIN_CATEGORIES.flatMap((c) => c.subcategories.map((s) => s.slug));
    expect(all).not.toContain('general');
    expect(all).not.toContain('other');
    expect(all).not.toContain('uncategorized');
  });
});

describe('categoryLabel', () => {
  it('shows the category alone when there is no subcategory', () => {
    expect(categoryLabel(BUILTIN_CATEGORIES, 'sports', null)).toBe('Sports');
  });

  it('shows both levels when the subcategory resolves', () => {
    expect(categoryLabel(BUILTIN_CATEGORIES, 'sports', 'soccer')).toBe('Sports · Soccer');
  });

  it('falls back to Uncategorized when the topic has no category', () => {
    expect(categoryLabel(BUILTIN_CATEGORIES, null, null)).toBe(UNCATEGORIZED_LABEL);
  });

  it('falls back to Uncategorized for a slug the table no longer has', () => {
    // The table is user-editable, so an unresolvable slug is an ordinary
    // consequence of a deletion — it must render, not throw.
    expect(categoryLabel(BUILTIN_CATEGORIES, 'weather', null)).toBe(UNCATEGORIZED_LABEL);
  });

  it('keeps the category when only the subcategory is unresolvable', () => {
    // Losing a sub must not demote the topic all the way to Uncategorized: the
    // category part is still true and still useful.
    expect(categoryLabel(BUILTIN_CATEGORIES, 'sports', 'skiing')).toBe('Sports');
  });

  it('ignores a subcategory belonging to a different category', () => {
    expect(categoryLabel(BUILTIN_CATEGORIES, 'sports', 'soccer')).toBe('Sports · Soccer');
    expect(categoryLabel(BUILTIN_CATEGORIES, 'culture', 'soccer')).toBe('Culture');
  });
});

describe('activeCategories', () => {
  it('returns everything when nothing is retired', () => {
    expect(activeCategories(BUILTIN_CATEGORIES)).toHaveLength(BUILTIN_CATEGORIES.length);
  });

  it('hides a retired category and a retired subcategory', () => {
    const table = BUILTIN_CATEGORIES.map((c) =>
      c.slug === 'style'
        ? { ...c, retired: true }
        : c.slug === 'sports'
          ? { ...c, subcategories: c.subcategories.map((s) => (s.slug === 'golf' ? { ...s, retired: true } : s)) }
          : c,
    );
    const active = activeCategories(table);
    expect(active.map((c) => c.slug)).not.toContain('style');
    expect(active.find((c) => c.slug === 'sports')?.subcategories.map((s) => s.slug)).not.toContain('golf');
    expect(active.find((c) => c.slug === 'sports')?.subcategories.map((s) => s.slug)).toContain('soccer');
  });

  it('still labels a topic holding a retired slug', () => {
    // This is the point of retiring rather than deleting: the pill keeps working
    // for topics that already hold it, so removal can never orphan one.
    const table = BUILTIN_CATEGORIES.map((c) => (c.slug === 'style' ? { ...c, retired: true } : c));
    expect(categoryLabel(table, 'style', 'fashion')).toBe('Style · Fashion');
  });

  it('does not mutate the table it was given', () => {
    const before = JSON.stringify(BUILTIN_CATEGORIES);
    activeCategories(BUILTIN_CATEGORIES);
    expect(JSON.stringify(BUILTIN_CATEGORIES)).toBe(before);
  });
});

describe('the no-subcategory label', () => {
  it('is a constant, not a table entry', () => {
    // If this ever becomes a stored row, the tests above stop protecting the
    // decision — so assert the two are different kinds of thing.
    expect(NO_SUBCATEGORY_LABEL).toBe('Other');
    expect(BUILTIN_CATEGORIES.flatMap((c) => c.subcategories.map((s) => s.label))).not.toContain(
      NO_SUBCATEGORY_LABEL,
    );
  });
});
