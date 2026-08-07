/**
 * Reader profiles — the "what kind of person are you?" chips (NEWS-381, NEWS-383).
 *
 * At `src/` root rather than under `client/` for the same reason `categories.ts`
 * is: the server validates and stores these, the client draws them, and two
 * copies would eventually disagree.
 *
 * **These name a kind of person, not a subject.** "Foodie", not "Food"; "Car
 * enthusiast", not "Automotive". The distinction is load-bearing for what comes
 * next (NEWS-382, NEWS-386): a label that is already a topic gives a topic
 * generator nothing to add — it would echo the label back. "Gear head" implies
 * EV launches, right-to-repair legislation and F1 in a way "Cars" does not.
 */

import { z } from 'zod';

/**
 * The twelve interest facets the pages are balanced across.
 *
 * Not shown to the user and not stored — they exist so `profiles.test.ts` can
 * assert the property that makes the paging work (see `PROFILE_PAGES`). A
 * comment claiming the pages are diverse would rot; an assertion cannot.
 */
export const PROFILE_FACETS = [
  'work',
  'money',
  'tech',
  'sport',
  'arts',
  'food',
  'home',
  'science',
  'civic',
  'body',
  'life',
  'play',
] as const;
export type ProfileFacet = (typeof PROFILE_FACETS)[number];

export interface UserProfile {
  /**
   * Stable identifier — **this is what gets stored**, never the label.
   *
   * Rewording a chip must not orphan the selections of everyone who ticked it,
   * which is exactly what storing the display string would do. Same rule as a
   * category slug, and the same reason (`categories.ts`, NEWS-388's `renamed`).
   */
  id: string;
  label: string;
  facet: ProfileFacet;
}

const p = (id: string, label: string, facet: ProfileFacet): UserProfile => ({ id, label, facet });

/**
 * Three pages of sixteen, shown one page at a time (NEWS-381).
 *
 * **Each page independently spans all twelve facets, and that is the point.**
 * The obvious build is page 1 = professions, page 2 = hobbies, page 3 = culture.
 * That is wrong here because pages are individually skippable: anyone who stops
 * after page 1 would have been offered only professions. Sampling the whole
 * space on every page means a user who quits early still saw a full spread.
 *
 * Breadth *decreases* across pages — page 1 is the highest-hit set, page 3 the
 * long tail — which is the right gradient when later pages are the ones most
 * likely to be skipped.
 *
 * Three near-pairs are deliberate, not duplicates: Tech enthusiast/Software
 * developer, Music lover/Musician, Sports fan/Runner. Each splits *consuming*
 * from *doing*, which should produce genuinely different topics. If NEWS-382's
 * generator cannot tell them apart, collapse each to the page-1 label.
 */
export const PROFILE_PAGES: readonly (readonly UserProfile[])[] = [
  [
    p('tech-enthusiast', 'Tech enthusiast', 'tech'),
    p('foodie', 'Foodie', 'food'),
    p('traveler', 'Traveler', 'life'),
    p('sports-fan', 'Sports fan', 'sport'),
    p('investor', 'Investor', 'money'),
    p('film-tv-buff', 'Film & TV buff', 'arts'),
    p('fitness-wellness', 'Fitness & wellness', 'body'),
    p('gamer', 'Gamer', 'play'),
    p('science-curious', 'Science curious', 'science'),
    p('parent', 'Parent', 'life'),
    p('music-lover', 'Music lover', 'arts'),
    p('small-business-owner', 'Small business owner', 'work'),
    p('gardener', 'Gardener', 'home'),
    p('politics-watcher', 'Politics watcher', 'civic'),
    p('car-enthusiast', 'Car enthusiast', 'tech'),
    p('student', 'Student', 'work'),
  ],
  [
    p('software-developer', 'Software developer', 'work'),
    p('healthcare-professional', 'Healthcare professional', 'work'),
    p('home-cook', 'Home cook', 'food'),
    p('hiker-camper', 'Hiker & camper', 'sport'),
    p('reader', 'Reader', 'arts'),
    p('startup-founder', 'Startup founder', 'money'),
    p('pet-owner', 'Pet owner', 'life'),
    p('diy-home-repair', 'DIY & home repair', 'home'),
    p('space-astronomy', 'Space & astronomy', 'science'),
    p('climate-environment', 'Climate & environment', 'civic'),
    p('photographer', 'Photographer', 'tech'),
    p('board-games', 'Board games & tabletop', 'play'),
    // Longest label in the set at 27 characters — the chip grid has to hold it
    // without truncating. "Mindfulness" is the fallback if it ever cannot.
    p('mental-health', 'Mental health & mindfulness', 'body'),
    p('educator', 'Educator', 'work'),
    p('fashion-style', 'Fashion & style', 'arts'),
    p('local-news', 'Local news follower', 'civic'),
  ],
  [
    p('runner', 'Runner', 'sport'),
    p('anime-comics', 'Anime & comics', 'play'),
    p('beer-wine-spirits', 'Beer, wine & spirits', 'food'),
    p('musician', 'Musician', 'arts'),
    // "Property", not "Real estate" — the latter is US-shaped, and this list is
    // read by people who say "property" (NEWS-387's de-Americanisation pass).
    p('property-housing', 'Property & housing', 'money'),
    p('legal-professional', 'Legal professional', 'work'),
    p('crafts-making', 'Crafts & making', 'home'),
    p('academic-researcher', 'Academic researcher', 'science'),
    p('volunteer-community', 'Volunteer & community', 'civic'),
    p('retiree', 'Retiree', 'life'),
    p('aviation', 'Aviation & flight', 'tech'),
    p('remote-worker', 'Remote worker', 'work'),
    p('frugal-living', 'Frugal living & deals', 'money'),
    p('language-learner', 'Language learner', 'life'),
    p('history-buff', 'History buff', 'arts'),
    p('skincare-beauty', 'Skincare & beauty', 'body'),
  ],
];

/** Every profile, flattened. */
export const ALL_PROFILES: readonly UserProfile[] = PROFILE_PAGES.flat();

const BY_ID = new Map(ALL_PROFILES.map((profile) => [profile.id, profile]));

/** How many pages the picker has. */
export const PROFILE_PAGE_COUNT = PROFILE_PAGES.length;

/**
 * Drop ids this build doesn't know, keeping the rest (NEWS-383).
 *
 * **Filtered on read rather than rejected at the boundary**, the same call
 * `categories.ts` makes for an unresolvable slug (FR-22.8). An import written by
 * a build with one extra profile must not fail wholesale — losing one chip is a
 * shrug, losing the import is not. Order follows the canonical page order rather
 * than the stored order, so the value a user sees is stable regardless of the
 * sequence they happened to tick things in.
 */
export function resolveProfiles(ids: readonly string[]): UserProfile[] {
  const wanted = new Set(ids);
  return ALL_PROFILES.filter((profile) => wanted.has(profile.id));
}

/** Display labels for stored ids, unknown ones dropped. */
export function profileLabels(ids: readonly string[]): string[] {
  return resolveProfiles(ids).map((profile) => profile.label);
}

/** Whether an id names a profile this build ships. */
export function isKnownProfile(id: string): boolean {
  return BY_ID.has(id);
}

/**
 * Stored selections — ids, deduplicated, unknown ones kept until read.
 *
 * Capped at the number of profiles that exist so a malformed write cannot grow
 * the row without bound; the per-item cap is generous because an id is short and
 * the only real bound that matters is the total.
 */
export const ProfileIdsSchema = z
  .array(z.string().max(64))
  .max(ALL_PROFILES.length)
  .transform((ids) => [...new Set(ids)]);
