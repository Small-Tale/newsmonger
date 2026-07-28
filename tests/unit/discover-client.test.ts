import { describe, expect, it } from 'vitest';

import type { TopicSuggestion } from '../../src/api/schemas.js';
import { groupSuggestions, kindLabel, resultsHeading, sectionFor, sectionTiles } from '../../src/client/discover.js';

/** The pure half of the discovery dialog (NEWS-126). */

function suggestion(name: string, category: string | null, subcategory: string | null = null): TopicSuggestion {
  return {
    name,
    reason: 'because',
    kind: 'evergreen',
    guidance: '',
    classification: category === null ? null : { category, subcategory },
  };
}

describe('sectionTiles', () => {
  it('offers the whole taxonomy', () => {
    const tiles = sectionTiles();
    expect(tiles).toHaveLength(11);
    expect(tiles.map((t) => t.slug)).toContain('sports');
  });

  it('resolves a section by slug, and nothing for a slug that is not one', () => {
    expect(sectionFor('sports')?.label).toBe('Sports');
    expect(sectionFor('not-a-section')).toBeUndefined();
  });
});

describe('groupSuggestions', () => {
  it('groups by section and labels with the same wording the filter bar uses', () => {
    const groups = groupSuggestions([
      suggestion('Formula 1', 'sports', 'motorsport'),
      suggestion('MotoGP', 'sports', 'motorsport'),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe('Sports · Motorsport');
    expect(groups[0].suggestions.map((s) => s.name)).toEqual(['Formula 1', 'MotoGP']);
  });

  it('separates two subcategories of the same section', () => {
    const groups = groupSuggestions([
      suggestion('Formula 1', 'sports', 'motorsport'),
      suggestion('Premier League', 'sports', 'soccer'),
    ]);
    expect(groups.map((g) => g.label)).toEqual(['Sports · Soccer', 'Sports · Motorsport']);
  });

  it('labels a category with no subcategory as Other, not as unclassified', () => {
    // A topic can legitimately belong to a section without matching any of its
    // subsections (FR-22.6), and that is a different thing from unclassified.
    const [group] = groupSuggestions([suggestion('Skiing', 'sports', null)]);
    expect(group.label).toBe('Sports · Other');
  });

  it('orders by the taxonomy, not by the order the model returned', () => {
    // Browsing twice must not reshuffle the page.
    const groups = groupSuggestions([
      suggestion('Skiing', 'sports', null),
      suggestion('EU AI Act', 'technology', 'ai'),
      suggestion('Elections', 'politics', 'elections'),
    ]);
    expect(groups.map((g) => g.label)).toEqual(['Politics · Elections', 'Technology · AI', 'Sports · Other']);
  });

  it('sorts unclassified last, so it never buries the rest', () => {
    const groups = groupSuggestions([suggestion('Something odd', null), suggestion('Formula 1', 'sports', 'motorsport')]);
    expect(groups.map((g) => g.label)).toEqual(['Sports · Motorsport', 'Uncategorized']);
  });

  it('renders a suggestion whose slug went stale rather than dropping it', () => {
    // The server validates against the same table, so this shouldn't happen —
    // but losing a suggestion the user might have wanted is the worse failure.
    const [group] = groupSuggestions([suggestion('Mystery', 'not-a-real-category')]);
    expect(group.label).toBe('Uncategorized');
    expect(group.suggestions).toHaveLength(1);
  });

  it('gives every group a key distinct from its label', () => {
    const groups = groupSuggestions([suggestion('Skiing', 'sports', null), suggestion('Something', null)]);
    expect(new Set(groups.map((g) => g.key)).size).toBe(2);
  });

  it('returns nothing for nothing', () => {
    expect(groupSuggestions([])).toEqual([]);
  });
});

describe('resultsHeading', () => {
  it('quotes what the user actually typed', () => {
    expect(resultsHeading({ kind: 'describe', query: 'i cycle' })).toContain('i cycle');
  });

  it('reads an empty query as a deliberate answer, not a failed search (FR-24.3)', () => {
    expect(resultsHeading({ kind: 'describe', query: '   ' })).toBe('A bit of everything');
  });

  it('names both taxonomy levels, or the whole section', () => {
    expect(resultsHeading({ kind: 'section', category: 'sports', subcategory: 'motorsport' })).toBe('Sports · Motorsport');
    expect(resultsHeading({ kind: 'section', category: 'sports', subcategory: null })).toBe('Anything in Sports');
  });

  it('degrades rather than throwing on a slug that is not a section', () => {
    expect(resultsHeading({ kind: 'section', category: 'nope', subcategory: null })).toBe('Suggestions');
    expect(resultsHeading({ kind: 'section', category: 'sports', subcategory: 'nope' })).toBe('Sports');
  });
});

describe('kindLabel', () => {
  it('distinguishes a story that will end from a subject that will not', () => {
    expect(kindLabel('ongoing')).toBe('Ongoing story');
    expect(kindLabel('evergreen')).toBe('Evergreen');
  });
});
