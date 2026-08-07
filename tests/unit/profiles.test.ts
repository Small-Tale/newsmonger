/**
 * Reader profiles: the table, the paging, and what is stored (NEWS-383).
 *
 * The facet-spread assertion is the one that earns its place. "Each page is
 * diverse" is the kind of claim a comment makes and then quietly stops being
 * true after two edits — the whole reason the pages are balanced at all is that
 * they are individually skippable, and a page that drifted into eight hobbies
 * would fail nobody's eye and every user who stopped there.
 */

import { describe, expect, it } from 'vitest';

import { UpdateSettingsReqSchema } from '../../src/api/schemas.js';
import { nextProfilePage } from '../../src/client/onboarding.js';
import { SettingsSchema } from '../../src/db/schemas.js';
import {
  ALL_PROFILES,
  isKnownProfile,
  PROFILE_FACETS,
  PROFILE_PAGE_COUNT,
  PROFILE_PAGES,
  profileLabels,
  resolveProfiles,
} from '../../src/profiles.js';

describe('the profile table', () => {
  it('is three pages of sixteen', () => {
    expect(PROFILE_PAGE_COUNT).toBe(3);
    for (const page of PROFILE_PAGES) expect(page).toHaveLength(16);
    expect(ALL_PROFILES).toHaveLength(48);
  });

  it('gives every page a spread across all twelve facets', () => {
    // The property the paging depends on. Pages are individually skippable, so
    // a page that covered only some facets would offer a partial view of the
    // world to anyone who stopped there.
    for (const [index, page] of PROFILE_PAGES.entries()) {
      const facets = new Set(page.map((p) => p.facet));
      expect(facets.size, `page ${String(index + 1)} must span all ${String(PROFILE_FACETS.length)} facets`).toBe(
        PROFILE_FACETS.length,
      );
      for (const facet of PROFILE_FACETS) {
        expect(facets.has(facet), `page ${String(index + 1)} is missing the "${facet}" facet`).toBe(true);
      }
    }
  });

  it('has unique ids and unique labels', () => {
    // Ids because they are stored; labels because two identical chips would be
    // a UI bug nobody could report precisely.
    expect(new Set(ALL_PROFILES.map((p) => p.id)).size).toBe(ALL_PROFILES.length);
    expect(new Set(ALL_PROFILES.map((p) => p.label)).size).toBe(ALL_PROFILES.length);
  });

  it('uses only declared facets, and uses every one of them', () => {
    const declared = new Set<string>(PROFILE_FACETS);
    for (const p of ALL_PROFILES) expect(declared.has(p.facet), `${p.id} has facet "${p.facet}"`).toBe(true);
    const used = new Set(ALL_PROFILES.map((p) => p.facet));
    expect(used.size, 'a facet nothing uses is a facet that should be deleted').toBe(PROFILE_FACETS.length);
  });

  it('keeps ids stable and separate from labels', () => {
    // The whole point of an id: rewording a chip must not orphan the people who
    // ticked it. Slug-shaped and lower-case so a label edit cannot silently
    // change one by regeneration — unlike a category slug, these are hand-written.
    for (const p of ALL_PROFILES) {
      expect(p.id).toMatch(/^[a-z0-9-]+$/);
      expect(p.id).not.toBe(p.label);
    }
  });

  it('avoids US-shaped labels the de-Americanisation pass caught', () => {
    // NEWS-387 renamed "Real estate & housing" to "Property & housing". Pinned
    // because the old wording is the one that comes to hand when editing.
    const labels = ALL_PROFILES.map((p) => p.label);
    expect(labels).toContain('Property & housing');
    expect(labels).not.toContain('Real estate & housing');
  });
});

describe('resolving stored ids', () => {
  it('drops ids this build does not know rather than failing', () => {
    // An export from a build with one extra profile must still import — losing
    // a chip is a shrug, losing the import is not.
    const resolved = resolveProfiles(['foodie', 'not-a-real-profile', 'runner']);
    expect(resolved.map((p) => p.id)).toEqual(['foodie', 'runner']);
  });

  it('returns canonical page order, not the order they were ticked', () => {
    // Otherwise the same selection renders differently depending on the
    // sequence someone happened to click in.
    const forward = resolveProfiles(['foodie', 'runner', 'tech-enthusiast']).map((p) => p.id);
    const backward = resolveProfiles(['runner', 'tech-enthusiast', 'foodie']).map((p) => p.id);
    expect(forward).toEqual(backward);
    expect(forward).toEqual(['tech-enthusiast', 'foodie', 'runner']);
  });

  it('maps ids to labels and knows what it ships', () => {
    expect(profileLabels(['mental-health'])).toEqual(['Mental health & mindfulness']);
    expect(profileLabels([])).toEqual([]);
    expect(isKnownProfile('foodie')).toBe(true);
    expect(isKnownProfile('Foodie')).toBe(false);
  });
});

describe('storing the selection', () => {
  it('defaults to none', () => {
    expect(SettingsSchema.parse({ checkIntervalMs: 86_400_000 }).profiles).toEqual([]);
  });

  it('deduplicates on the way in', () => {
    const parsed = UpdateSettingsReqSchema.parse({ profiles: ['foodie', 'foodie', 'runner'] });
    expect(parsed.profiles).toEqual(['foodie', 'runner']);
  });

  it('accepts an empty list as a real value', () => {
    // "I ticked nothing" is a decision, not an absence — clearing every chip has
    // to be storable or the picker becomes one-way.
    expect(UpdateSettingsReqSchema.parse({ profiles: [] }).profiles).toEqual([]);
  });

  it('accepts an unknown id but caps the total', () => {
    expect(UpdateSettingsReqSchema.safeParse({ profiles: ['who-knows'] }).success).toBe(true);
    const tooMany = Array.from({ length: ALL_PROFILES.length + 1 }, (_, i) => `p${String(i)}`);
    expect(UpdateSettingsReqSchema.safeParse({ profiles: tooMany }).success).toBe(false);
  });

  it('survives a stored row written before the field existed', () => {
    const settings = SettingsSchema.parse({ checkIntervalMs: 86_400_000, theme: 'dark' });
    expect(settings.profiles).toEqual([]);
    expect(settings.theme).toBe('dark');
  });
});

describe('paging through the picker', () => {
  it('walks the pages, then hands over to the wizard', () => {
    expect(nextProfilePage(0, 3)).toEqual({ page: 1, advanceStep: false });
    expect(nextProfilePage(1, 3)).toEqual({ page: 2, advanceStep: false });
    expect(nextProfilePage(2, 3)).toEqual({ page: 2, advanceStep: true });
  });

  it('clamps a page index that is out of range instead of rendering nothing', () => {
    expect(nextProfilePage(-5, 3)).toEqual({ page: 1, advanceStep: false });
    expect(nextProfilePage(99, 3)).toEqual({ page: 2, advanceStep: true });
    expect(nextProfilePage(1.7, 3)).toEqual({ page: 2, advanceStep: false });
  });

  it('advances immediately when there are no pages at all', () => {
    // Degenerate, but the alternative is a Continue button that does nothing.
    expect(nextProfilePage(0, 0)).toEqual({ page: 0, advanceStep: true });
  });
});
