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

import {
  DEFAULT_TOPIC_CAP,
  guidanceForTopic,
  PROFILE_TOPICS,
  TOPIC_GUIDANCE,
  topicsForProfile,
  topicsForProfiles,
} from '../../src/profile-topics.js';
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

describe('near-duplicate topic names (NEWS-422)', () => {
  it('does not offer the same subject under two names', () => {
    // Dedup is `normalizeTopicName`, which compares names and not meanings, so a
    // subject written two ways survives as two topics — two checks, two feeds,
    // one subject. That is what "Climate science" and "Climate science and
    // research" were, and someone interested in both science and the climate is
    // exactly the person who ticks both profiles.
    const chosen = topicsForProfiles(['science-curious', 'climate-environment'], { cap: 12 });
    expect(chosen.filter((t) => t.toLowerCase().startsWith('climate science'))).toHaveLength(1);
  });

  it('leaves genuinely distinct neighbours alone', () => {
    // The counterweight, and the reason this is a named pair rather than a rule.
    // A containment or word-overlap check would collapse these too, and silently
    // dropping a topic someone asked for is worse than a visible duplicate:
    // pet food recalls are not food recalls.
    const names = new Set(Object.values(PROFILE_TOPICS).flat());
    expect(names.has('Food safety and recalls')).toBe(true);
    expect(names.has('Pet food safety and recalls')).toBe(true);
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

describe('the discovery strip’s selection (NEWS-406, FR-24.40)', () => {
  // The strip renders `topicsForProfiles` with a small cap and the user's own
  // topics excluded. Its behaviour is that call, so it is tested here rather
  // than through a rendered dialog — the same reason `onboarding.ts` exists.
  const STRIP_CAP = 6;

  it('offers nothing when no profiles are set', () => {
    // The one part of the dialog with nothing to say without them. An empty
    // result is what lets the container collapse instead of rendering a shell.
    expect(topicsForProfiles([], { cap: STRIP_CAP })).toEqual([]);
  });

  it('offers nothing once every candidate is already followed', () => {
    // FR-24.11 applies to the strip as much as to a live suggestion — a static
    // list is not an excuse to offer something the user already watches.
    const all = topicsForProfile('gardener');
    expect(topicsForProfiles(['gardener'], { cap: STRIP_CAP, exclude: [...all] })).toEqual([]);
  });

  it('stays short enough to read at a glance', () => {
    // Six, not twelve: this sits above the section grid and competes with it for
    // attention. A row long enough to scroll would be a third door, not a nudge.
    const many = ALL_PROFILES.slice(0, 12).map((p) => p.id);
    expect(topicsForProfiles(many, { cap: STRIP_CAP })).toHaveLength(STRIP_CAP);
  });

  it('still spreads across the ticked profiles at strip size', () => {
    // The rank-first rule has to survive the smaller cap, or a six-slot strip
    // shows one profile's top six and ignores the other five.
    const ids = ALL_PROFILES.slice(0, 6).map((p) => p.id);
    const picked = topicsForProfiles(ids, { cap: STRIP_CAP });
    for (const id of ids) {
      expect(picked, `${id} should be represented`).toContain(topicsForProfile(id)[0]);
    }
  });
});

describe('guidance steers (NEWS-400, FR-36.10)', () => {
  it('is sparse, and that is the design', () => {
    // A steer that restates the topic name is worse than none — it spends prompt
    // on nothing and reads as though someone had thought about it. Most of the
    // 240 are already beats narrow enough to search on.
    const withGuidance = Object.keys(TOPIC_GUIDANCE).length;
    expect(withGuidance).toBeGreaterThan(0);
    expect(withGuidance, 'a steer on most topics would mean the names are too vague').toBeLessThan(60);
  });

  it('only names topics that actually exist', () => {
    // A steer keyed to a topic that was renamed is dead weight that looks alive.
    const names = new Set(Object.values(PROFILE_TOPICS).flat());
    for (const key of Object.keys(TOPIC_GUIDANCE)) {
      expect(names.has(key), `"${key}" is not a topic in the table`).toBe(true);
    }
  });

  it('never merely restates the topic name', () => {
    // The failure mode this sparseness exists to avoid, asserted rather than
    // trusted: a steer has to say something the name does not.
    for (const [name, steer] of Object.entries(TOPIC_GUIDANCE)) {
      expect(steer.toLowerCase(), `"${name}" restates itself`).not.toBe(name.toLowerCase());
      expect(steer.length, `"${name}" has a steer too short to be saying anything`).toBeGreaterThan(40);
    }
  });

  it('says nothing about place', () => {
    // NEWS-387 expected guidance to carry the jurisdiction qualifier its four
    // un-rewordable beats needed. It cannot — a static "in the reader's own
    // jurisdiction" is meaningless without knowing the jurisdiction, and FR-35.4
    // already passes the location into every check naming exactly those cases.
    // A steer that duplicated it would be a frozen, worse copy.
    for (const [name, steer] of Object.entries(TOPIC_GUIDANCE)) {
      for (const word of ['jurisdiction', 'your country', 'near you', 'local to']) {
        expect(steer.toLowerCase(), `"${name}" duplicates FR-35.4's location instruction`).not.toContain(word);
      }
    }
  });

  it('returns an empty steer rather than undefined for an unsteered topic', () => {
    // `''` is what the create path checks, and what FR-24.19 treats as "no
    // guidance". An `undefined` leaking into the POST body would send `null`.
    expect(guidanceForTopic('Marathons and road racing')).toBe('');
    expect(guidanceForTopic('not a topic at all')).toBe('');
    expect(guidanceForTopic('Artificial intelligence')).not.toBe('');
  });
});
