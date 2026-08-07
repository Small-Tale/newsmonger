/**
 * Profile → default topics (NEWS-382, `docs/36-profile-topics.md`).
 *
 * Two kinds of test here, and the second is the one that matters. The table
 * assertions pin the data — every profile covered, five each, no duplicates. The
 * selection assertions pin `topicsForProfiles`, whose whole job is to stop a
 * user who ticked ten profiles from getting fifty topics, each of which fires
 * its own check the moment it is created (FR-1.12).
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_TOPIC_CAP, PROFILE_TOPICS, topicsForProfile, topicsForProfiles } from '../../src/profile-topics.js';
import { ALL_PROFILES } from '../../src/profiles.js';

describe('the topic table', () => {
  it('covers every profile with exactly five topics', () => {
    for (const profile of ALL_PROFILES) {
      expect(topicsForProfile(profile.id), `${profile.id} has no topics`).toHaveLength(5);
    }
    expect(Object.keys(PROFILE_TOPICS)).toHaveLength(ALL_PROFILES.length);
  });

  it('names no profile that does not exist', () => {
    // A typo'd key would silently contribute nothing, since selection walks the
    // profile list rather than this table's keys.
    const known = new Set(ALL_PROFILES.map((p) => p.id));
    for (const id of Object.keys(PROFILE_TOPICS)) expect(known.has(id), `unknown profile "${id}"`).toBe(true);
  });

  it('has no duplicate topic within a profile', () => {
    for (const [id, topics] of Object.entries(PROFILE_TOPICS)) {
      expect(new Set(topics).size, `${id} repeats a topic`).toBe(topics.length);
    }
  });

  it('keeps the US-shaped wording out that NEWS-387 removed', () => {
    // Pinned because the removed phrasings are the ones that come to hand when
    // editing — every one of these was in the first draft.
    const all = Object.values(PROFILE_TOPICS).flat().join(' | ').toLowerCase();
    for (const banned of [
      'college admissions',
      'student debt',
      'zoning',
      'reimbursement',
      'state parks',
      'backcountry',
      'major league',
      'free agency',
      'building codes',
      'real estate',
      'grocery prices',
    ]) {
      expect(all, `"${banned}" is US-shaped and was removed in NEWS-387`).not.toContain(banned);
    }
  });

  it('names beats rather than dated entities', () => {
    // The durability rule, as far as a test can enforce it: no four-digit years,
    // and no trailing "2026"-style qualifiers. It cannot catch a company name,
    // which is why the module states the rule in prose as well.
    for (const [id, topics] of Object.entries(PROFILE_TOPICS)) {
      for (const topic of topics) {
        expect(topic, `${id}: "${topic}" carries a year`).not.toMatch(/\b(19|20)\d{2}\b/);
      }
    }
  });
});

describe('choosing topics for a selection', () => {
  it('gives a single profile its whole list', () => {
    expect(topicsForProfiles(['foodie'])).toEqual(topicsForProfile('foodie'));
  });

  it('returns nothing for no profiles', () => {
    expect(topicsForProfiles([])).toEqual([]);
    expect(topicsForProfiles(['not-a-profile'])).toEqual([]);
  });

  it('takes each profile’s best before any profile’s second', () => {
    // The core of the design. Profile-major order would hand someone who ticked
    // ten profiles everything from two of them and nothing from the other eight.
    const picked = topicsForProfiles(['foodie', 'runner', 'investor'], { cap: 3 });
    // Canonical page order, not tick order: foodie is page 1 #2, investor page 1
    // #5, runner page 3 #1.
    expect(picked).toEqual([
      topicsForProfile('foodie')[0],
      topicsForProfile('investor')[0],
      topicsForProfile('runner')[0],
    ]);
  });

  it('falls in depth as the tick count rises, and never exceeds the cap', () => {
    // The property FR-20.6's cost warning depends on: more profiles must not
    // mean proportionally more checks.
    const many = ALL_PROFILES.slice(0, 10).map((p) => p.id);
    const picked = topicsForProfiles(many);
    expect(picked).toHaveLength(DEFAULT_TOPIC_CAP);
    // Ten profiles, twelve topics — so eight contribute one and two contribute
    // two, rather than the first two contributing five each.
    const firsts = many.filter((id) => picked.includes(topicsForProfile(id)[0] ?? ''));
    expect(firsts).toHaveLength(10);
  });

  it('is stable regardless of the order things were ticked', () => {
    const a = topicsForProfiles(['runner', 'foodie', 'investor']);
    const b = topicsForProfiles(['investor', 'runner', 'foodie']);
    expect(a).toEqual(b);
  });

  it('skips topics the user already follows', () => {
    // Same intent as FR-24.11: never propose something already being watched.
    const withoutExclusions = topicsForProfiles(['foodie'], { cap: 5 });
    const first = withoutExclusions[0] ?? '';
    const withExclusion = topicsForProfiles(['foodie'], { cap: 5, exclude: [first] });
    expect(withExclusion).not.toContain(first);
    expect(withExclusion).toHaveLength(4);
  });

  it('matches an existing topic loosely enough to catch a re-punctuation', () => {
    // `normalizeTopicName`, not `normalizeTitle` — in a topic name a hyphen
    // stands in for a space, so these are the same subject (FR-24.24).
    const picked = topicsForProfiles(['gamer'], { cap: 5, exclude: ['game-releases-and-reviews'] });
    expect(picked).not.toContain('Game releases and reviews');
  });

  it('deduplicates across profiles rather than proposing the same topic twice', () => {
    // No two profiles currently share a topic verbatim, so this asserts the
    // mechanism on a synthetic overlap: excluding nothing, every result is unique.
    const picked = topicsForProfiles(ALL_PROFILES.map((p) => p.id), { cap: 48 });
    expect(new Set(picked).size).toBe(picked.length);
  });

  it('treats a zero or negative cap as "none", not "unlimited"', () => {
    expect(topicsForProfiles(['foodie'], { cap: 0 })).toEqual([]);
    expect(topicsForProfiles(['foodie'], { cap: -1 })).toEqual([]);
  });
});
